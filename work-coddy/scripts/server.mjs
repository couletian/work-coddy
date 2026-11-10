import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = path.resolve(process.env.WB_IDE_ROOT || path.resolve(HERE, '..'));
const INDEX = path.join(HERE, 'index.html');
const MONACO = path.resolve(process.env.WB_IDE_MONACO || path.join(HERE, 'node_modules/monaco-editor/min'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const SKIP = new Set(['node_modules', '.git', '.workbuddy', 'dist', 'min', 'lazy-lite-wb', 'out', 'vendor']);
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|html|css|scss|md|txt|py|sh|bat|ps1|yml|yaml|xml|sql|java|c|cpp|h|go|rs|php|lua|ini|toml|vue|svelte)$/i;

let PORT = Number(process.env.WB_IDE_PORT || 6830);
const agentClients = new Set();
let acp = { port: null, cid: null, sid: null };
let rpcId = 0;
let lastHistory = [];
let historyCollector = null;
const EXT_DIR = path.join(ROOT, '.wb-ide', 'extensions');
const pluginCommands = new Map();
const pluginList = [];
const breakpoints = new Map();
const debugClients = new Set();
let dbg = null;

function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
function broadcast(obj) { for (const r of agentClients) sse(r, obj); }
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function inside(p) {
  const full = path.resolve(ROOT, p || '.');
  return full === ROOT || full.startsWith(ROOT + path.sep) ? full : null;
}
function readBody(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', d => { s += d; });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

function tree(dir, depth, out) {
  if (depth > 4) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (e.isDirectory()) { out.push({ path: rel, name: e.name, type: 'dir', depth }); tree(full, depth + 1, out); }
    else out.push({ path: rel, name: e.name, type: 'file', depth });
  }
  return out;
}

function serveStatic(res, url) {
  let file;
  if (url === '/' || url === '/index.html') file = INDEX;
  else if (url.startsWith('/monaco/')) file = path.join(MONACO, url.slice(8));
  else return json(res, 404, { error: 'not found' });
  if (!file.startsWith(MONACO) && file !== INDEX) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found: ' + path.basename(file) });
    res.writeHead(200, { 'content-type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(buf);
  });
}

function probe(port) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/health', method: 'GET' }, r => {
      let b = '';
      r.on('data', d => { b += d; });
      r.on('end', () => resolve(b.includes('"status"') || b.includes('AUTH_REQUIRED') ? port : null));
    });
    req.setTimeout(300, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}
function listeningPorts() {
  const cmds = process.platform === 'win32'
    ? [['netstat', ['-ano', '-p', 'tcp']]]
    : [['lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']], ['ss', ['-ltn']]];
  for (const [cmd, args] of cmds) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
      const ports = [...new Set(out.split(/\r?\n/)
        .map(l => l.match(/127\.0\.0\.1:(\d+)/) || l.match(/:(\d+)\s+.*LISTEN/))
        .filter(Boolean).map(m => Number(m[1])))];
      if (ports.length) return ports;
    } catch { /* 该命令不可用，尝试下一个 */ }
  }
  return [];
}
async function findGateway() {
  if (process.env.WB_GATEWAY_PORT) return Number(process.env.WB_GATEWAY_PORT);
  const fromEnv = process.env.CODEBUDDY_SERVICE_PROXY_URL?.match(/:(\d+)\//)?.[1];
  if (fromEnv && await probe(Number(fromEnv))) return Number(fromEnv);
  const ports = listeningPorts();
  for (let i = 0; i < ports.length; i += 20) {
    const hits = await Promise.all(ports.slice(i, i + 20).map(probe));
    const hit = hits.find(Boolean);
    if (hit) return hit;
  }
  return null;
}
function ensureMonaco() {
  if (fs.existsSync(path.join(MONACO, 'vs/loader.js'))) return;
  if (process.env.WB_IDE_MONACO) { console.log('Monaco 资源缺失：' + MONACO); return; }
  console.log('Monaco 资源缺失，正在安装 monaco-editor ...');
  try {
    execFileSync('npm', ['install', '--prefix', HERE, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', 'monaco-editor@0.52.2'],
      { stdio: 'inherit', timeout: 180000, shell: process.platform === 'win32' });
  } catch { console.log('自动安装失败，请手动执行: npm install --prefix ' + HERE + ' --no-save monaco-editor@0.52.2'); }
}

function handleAcp(m, tag) {
  const p = m.params || {}, u = p.update || {};
  if (p.sessionId && !acp.sid) acp.sid = p.sessionId;
  if (m.result?.sessionId) acp.sid = m.result.sessionId;
  if (!u.sessionUpdate) return null;
  const hist = u._meta?.['codebuddy.ai']?.mode === 'history' || !!u._meta?.['codebuddy.ai/historyReplay'];
  const evt = {
    sessionUpdate: u.sessionUpdate, messageId: u.messageId,
    text: u.content?.text || '', title: u.title || '', kind: u.kind || '', status: u.status || '',
  };
  if (historyCollector && ['agent_message_chunk', 'user_message_chunk'].includes(evt.sessionUpdate)) historyCollector(evt);
  if (hist) return null;
  if (tag === 'new') return evt;
  broadcast({ type: 'update', ...evt });
  return evt;
}

function acpPost(method, params, tag = '', onEvent = null) {
  if (!acp.cid) return;
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
  const req = http.request({ host: '127.0.0.1', port: acp.port, path: '/api/v1/acp', method: 'POST', headers: {
    'content-type': 'application/json', 'accept': 'application/json, text/event-stream',
    'acp-connection-id': acp.cid, 'content-length': Buffer.byteLength(body),
  } }, res => {
    let buf = '';
    const lines = chunk => {
      buf += chunk.toString();
      const parts = buf.split('\n'); buf = parts.pop();
      for (const l of parts) {
        if (!l.startsWith('data: ')) continue;
        let m; try { m = JSON.parse(l.slice(6).trim()); } catch { continue; }
        const e = handleAcp(m, tag);
        if (e && onEvent) onEvent(e);
      }
    };
    res.on('data', lines);
    res.on('end', () => { if (tag === 'prompt') broadcast({ type: 'turn-end' }); if (onEvent) onEvent(null); });
  });
  req.setTimeout(0);
  req.on('error', e => broadcast({ type: 'status', text: 'Agent 请求失败: ' + e.message }));
  req.end(body);
}

function connectAgent(port) {
  acp = { port, cid: null, sid: null };
  const req = http.request({ host: '127.0.0.1', port, path: '/api/v1/acp', method: 'GET', headers: { Accept: 'text/event-stream' } }, res => {
    acp.cid = res.headers['acp-connection-id'];
    if (!acp.cid) { broadcast({ type: 'status', text: 'Agent 连接被拒绝' }); return; }
    broadcast({ type: 'status', text: `Agent 已连接 · 网关 ${port}` });
    acpPost('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'wb-ide', version: '2.0.0' } });
    const recent = new Map();
    historyCollector = e => {
      if (!['agent_message_chunk', 'user_message_chunk'].includes(e.sessionUpdate) || !e.text) return;
      const role = e.sessionUpdate === 'user_message_chunk' ? 'user' : 'agent';
      const cur = recent.get(e.messageId) || { role, text: '' };
      cur.text += e.text;
      recent.set(e.messageId, cur);
    };
    acpPost('session/new', { cwd: ROOT, mcpServers: [] }, 'new');
    setTimeout(() => {
      lastHistory = [...recent.values()].slice(-16);
      if (lastHistory.length) broadcast({ type: 'history', items: lastHistory });
    }, 3500);
    let buf = '';
    res.on('data', chunk => {
      buf += chunk.toString();
      const parts = buf.split('\n'); buf = parts.pop();
      for (const l of parts) {
        if (!l.startsWith('data: ')) continue;
        try { handleAcp(JSON.parse(l.slice(6).trim()), 'get'); } catch { /* ignore */ }
      }
    });
    res.on('end', () => {
      broadcast({ type: 'status', text: 'Agent 连接断开，正在重连' });
      setTimeout(() => connectAgent(acp.port), 2500);
    });
  });
  req.on('error', e => {
    broadcast({ type: 'status', text: 'Agent 连接失败: ' + e.message });
    setTimeout(() => connectAgent(acp.port), 2500);
  });
  req.end();
}

function syncHistory() {
  broadcast({ type: 'history', items: lastHistory });
}

function searchFiles(q) {
  const out = [];
  const needle = q.toLowerCase();
  const walk = (dir, depth) => {
    if (depth > 4 || out.length >= 200) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!TEXT_EXT.test(e.name)) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size > 1024 * 1024) continue;
      let text; try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && out.length < 200; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          out.push({ path: path.relative(ROOT, full).split(path.sep).join('/'), line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    }
  };
  walk(ROOT, 0);
  return out;
}

/* ---------- 图形断点调试（CDP，零外部依赖） ---------- */
function dbgSse(o) { for (const r of debugClients) sse(r, o); }
let WSClass = typeof WebSocket !== 'undefined' ? WebSocket : null;
async function wsClass() {
  if (WSClass) return WSClass;
  try { WSClass = (await import('ws')).default; }
  catch {
    execFileSync('npm', ['install', '--prefix', HERE, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', 'ws'],
      { stdio: 'ignore', timeout: 120000, shell: process.platform === 'win32' });
    WSClass = (await import('ws')).default;
  }
  return WSClass;
}
function cdp(method, params = {}) {
  if (!dbg?.ws || dbg.ws.readyState !== 1) return Promise.resolve(null);
  const id = ++dbg.seq;
  return new Promise(resolve => {
    dbg.pending.set(id, resolve);
    dbg.ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (dbg?.pending.has(id)) { dbg.pending.delete(id); resolve(null); } }, 5000);
  });
}
async function applyBreakpoints() {
  if (!dbg) return [];
  for (const id of dbg.bpIds) await cdp('Debugger.removeBreakpoint', { breakpointId: id });
  dbg.bpIds = [];
  const set = [];
  for (const [file, lines] of breakpoints) {
    const abs = inside(file);
    if (!abs) continue;
    const url = pathToFileURL(abs).href;
    for (const line of lines) {
      const r = await cdp('Debugger.setBreakpointByUrl', { lineNumber: line - 1, columnNumber: 0, url });
      if (r?.result?.breakpointId) { dbg.bpIds.push(r.result.breakpointId); set.push({ file, line }); }
    }
  }
  return set;
}
async function onPaused(params) {
  if (!dbg) return;
  dbg.paused = params;
  const frames = (params.callFrames || []).slice(0, 12).map(f => ({
    fn: f.functionName || '(anonymous)', url: f.url || '', line: f.location.lineNumber + 1, col: f.location.columnNumber,
  }));
  let vars = [];
  const top = params.callFrames?.[0];
  const scope = top?.scopeChain?.find(s => s.type === 'local') || top?.scopeChain?.[0];
  if (scope?.object?.objectId) {
    const r = await cdp('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true });
    vars = (r?.result?.result || []).slice(0, 40).map(p => ({
      name: p.name, value: String(p.value?.value ?? p.value?.description ?? p.value?.type ?? ''),
    }));
  }
  dbgSse({ type: 'paused', reason: params.reason, frames, vars, file: frames[0]?.url, line: frames[0]?.line });
}
async function debugStart(file) {
  const abs = inside(file);
  if (!abs) throw new Error('outside workspace');
  if (!/\.(js|mjs|cjs)$/i.test(abs)) throw new Error('调试器当前仅支持 JavaScript（.js/.mjs/.cjs）');
  await debugStop();
  const WS = await wsClass();
  const child = spawn(process.execPath, ['--inspect-brk=0', abs], { cwd: ROOT, windowsHide: true });
  dbg = { child, ws: null, seq: 0, pending: new Map(), bpIds: [], paused: null, port: null };
  child.stdout.on('data', d => dbgSse({ type: 'console', text: d.toString() }));
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('inspector 启动超时')), 10000);
    child.stderr.on('data', d => {
      buf += d.toString();
      dbgSse({ type: 'console', text: d.toString().trim() });
      const m = buf.match(/ws:\/\/127\.0\.0\.1:(\d+)\/[^\s]+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', c => { clearTimeout(timer); reject(new Error('进程提前退出 ' + c)); });
  });
  dbg.port = Number(wsUrl.match(/:(\d+)\//)?.[1]) || null;
  const ws = new WS(wsUrl);
  dbg.ws = ws;
  ws.onopen = async () => {
    if (!dbg) return;
    await cdp('Runtime.enable');
    await cdp('Debugger.enable');
    const set = await applyBreakpoints();
    dbgSse({ type: 'started', file, breakpoints: set });
    await cdp('Runtime.runIfWaitingForDebugger');
  };
  ws.onmessage = e => {
    if (!dbg) return;
    const raw = typeof e.data === 'string' ? e.data : String(e.data);
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id && dbg?.pending.has(m.id)) { dbg.pending.get(m.id)(m); dbg.pending.delete(m.id); return; }
    if (m.method === 'Debugger.paused') onPaused(m.params);
    else if (m.method === 'Debugger.resumed') { dbg.paused = null; dbgSse({ type: 'resumed' }); }
    else if (m.method === 'Runtime.consoleAPICalled') dbgSse({ type: 'console', text: (m.params.args || []).map(a => String(a.value ?? a.description ?? '')).join(' ') });
    else if (m.method === 'Runtime.exceptionThrown') dbgSse({ type: 'console', text: 'EXCEPTION: ' + (m.params.exceptionDetails?.text || '') });
  };
  ws.onerror = e => dbgSse({ type: 'console', text: 'WebSocket 错误: ' + (e.message || '') });
  child.on('exit', code => { dbgSse({ type: 'exited', code }); if (dbg?.child === child) dbg = null; });
  return { ok: true, port: dbg.port };
}
async function debugStop() {
  if (!dbg) return { ok: true };
  try { dbg.ws?.close(); } catch { /* ignore */ }
  try { dbg.child.kill(); } catch { /* ignore */ }
  dbg = null;
  dbgSse({ type: 'stopped' });
  return { ok: true };
}
const DBG_ACTIONS = { continue: 'Debugger.resume', stepOver: 'Debugger.stepOver', stepInto: 'Debugger.stepInto', stepOut: 'Debugger.stepOut', pause: 'Debugger.pause' };

/* ---------- 轻量插件系统（替代扩展市场） ---------- */
async function loadPlugins() {
  if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });
  let current = '';
  const api = {
    readFile: p => fs.readFileSync(inside(p), 'utf8'),
    writeFile: (p, c) => fs.writeFileSync(inside(p), c, 'utf8'),
    listFiles: () => tree(ROOT, 0, []).filter(x => x.type === 'file').map(x => x.path),
    run: cmd => new Promise(resolve => {
      let out = '';
      const c = spawn(cmd, { shell: true, cwd: ROOT, windowsHide: true });
      c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
      c.on('close', () => resolve(out));
    }),
    askAgent: text => { if (acp.sid) acpPost('session/prompt', { sessionId: acp.sid, prompt: [{ type: 'text', text }] }, 'prompt'); },
    notify: text => broadcast({ type: 'plugin', text }),
    registerCommand: (id, title, handler) => pluginCommands.set(id, { id, title, handler, plugin: current }),
  };
  for (const f of fs.readdirSync(EXT_DIR).filter(x => x.endsWith('.mjs'))) {
    try {
      const mod = await import(pathToFileURL(path.join(EXT_DIR, f)).href + '?v=' + Date.now());
      current = mod.meta?.name || f;
      pluginList.push({ name: current, description: mod.meta?.description || '', file: f });
      await mod.activate?.(api);
    } catch (e) { console.log('插件加载失败', f, e.message); }
  }
}

function runCommand(res, body) {
  const cwd = inside(body.cwd || '.') || ROOT;
  const child = spawn(body.cmd, { shell: true, cwd, windowsHide: true });
  const timer = setTimeout(() => child.kill(), 120000);
  const out = d => sse(res, { type: 'out', text: d.toString() });
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  child.on('error', e => out(e.message));
  child.on('close', code => { clearTimeout(timer); sse(res, { type: 'done', code }); res.end(); });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (p === '/api/state') return json(res, 200, {
    root: ROOT, port: PORT, gateway: acp.port, connected: !!acp.cid, sessionId: acp.sid,
    monaco: fs.existsSync(path.join(MONACO, 'vs/loader.js')),
  });
  if (p === '/api/tree') return json(res, 200, { root: ROOT, items: tree(ROOT, 0, []) });
  if (p === '/api/search') return json(res, 200, { items: searchFiles(u.searchParams.get('q') || '') });
  if (p === '/api/file' && req.method === 'GET') {
    const file = inside(u.searchParams.get('path'));
    if (!file) return json(res, 403, { error: 'outside workspace' });
    try {
      const st = fs.statSync(file);
      return json(res, 200, { content: fs.readFileSync(file, 'utf8'), mtime: st.mtimeMs, size: st.size });
    } catch (e) { return json(res, 404, { error: e.message }); }
  }
  if (p === '/api/file' && req.method === 'POST') {
    const body = await readBody(req);
    const file = inside(body.path);
    if (!file) return json(res, 403, { error: 'outside workspace' });
    fs.writeFileSync(file, body.content, 'utf8');
    return json(res, 200, { ok: true, mtime: fs.statSync(file).mtimeMs });
  }
  if (p === '/api/new' && req.method === 'POST') {
    const body = await readBody(req);
    const file = inside(body.path);
    if (!file) return json(res, 403, { error: 'outside workspace' });
    if (fs.existsSync(file)) return json(res, 409, { error: 'already exists' });
    if (body.type === 'dir') fs.mkdirSync(file, { recursive: true });
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '', 'utf8'); }
    return json(res, 200, { ok: true });
  }
  if (p === '/api/exec' && req.method === 'POST') {
    const body = await readBody(req);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    return runCommand(res, body);
  }
  if (p === '/api/agent/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    agentClients.add(res);
    sse(res, { type: 'status', text: acp.cid ? `Agent 已连接 · 网关 ${acp.port}` : 'Agent 未连接' });
    if (lastHistory.length) sse(res, { type: 'history', items: lastHistory });
    req.on('close', () => agentClients.delete(res));
    return;
  }
  if (p === '/api/agent/prompt' && req.method === 'POST') {
    const body = await readBody(req);
    if (!acp.sid) return json(res, 503, { error: 'agent not ready' });
    acpPost('session/prompt', { sessionId: acp.sid, prompt: [{ type: 'text', text: body.text }] }, 'prompt');
    return json(res, 200, { ok: true });
  }
  if (p === '/api/agent/sync') { syncHistory(); return json(res, 200, { ok: true }); }
  if (p === '/api/debug/start' && req.method === 'POST') {
    try { const b = await readBody(req); return json(res, 200, await debugStart(b.path)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/debug/stop' && req.method === 'POST') return json(res, 200, await debugStop());
  if (p === '/api/debug/action' && req.method === 'POST') {
    const b = await readBody(req);
    const method = DBG_ACTIONS[b.action];
    if (!method || !dbg) return json(res, 400, { error: '无活动调试会话或未知动作' });
    await cdp(method);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/debug/breakpoints' && req.method === 'POST') {
    const b = await readBody(req);
    breakpoints.set(b.path, [...new Set(b.lines || [])].sort((a, z) => a - z));
    return json(res, 200, { ok: true, applied: dbg ? await applyBreakpoints() : [] });
  }
  if (p === '/api/debug/state') return json(res, 200, {
    running: !!dbg, paused: !!dbg?.paused, port: dbg?.port,
    breakpoints: Object.fromEntries(breakpoints),
  });
  if (p === '/api/debug/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    debugClients.add(res);
    sse(res, { type: 'hello', running: !!dbg });
    req.on('close', () => debugClients.delete(res));
    return;
  }
  if (p === '/api/plugins') return json(res, 200, {
    dir: EXT_DIR, plugins: pluginList,
    commands: [...pluginCommands.values()].map(({ id, title, plugin }) => ({ id, title, plugin })),
  });
  if (p === '/api/plugin/command' && req.method === 'POST') {
    const b = await readBody(req);
    const c = pluginCommands.get(b.id);
    if (!c) return json(res, 404, { error: 'command not found' });
    try { return json(res, 200, { ok: true, result: (await c.handler(b.args)) ?? null }); }
    catch (e) { return json(res, 500, { error: e.message }); }
  }
  return serveStatic(res, p);
});

function listen() {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && PORT < 6839) { PORT++; listen(); }
    else console.error('启动失败:', e.message);
  });
  server.listen(PORT, '127.0.0.1', async () => {
    console.log(`WB-IDE  http://127.0.0.1:${PORT}`);
    console.log(`ROOT    ${ROOT}`);
    await loadPlugins();
    const port = await findGateway();
    if (port) connectAgent(port);
    else console.log('未找到 Agent 网关，对话面板不可用；请通过 WB_GATEWAY_PORT 指定网关端口');
  });
}
ensureMonaco();
listen();
