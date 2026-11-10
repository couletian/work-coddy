# 实时 IDE 工作台 · 技术手册

本手册描述连接、配置与协议契约，供任意 Agent 在不同电脑上独立部署。**文中所有 `<...>` 均为占位符，必须替换为当前环境的实测值；不得把手册中的示例值当作固定配置。**

面向普通用户的定位、适用与不适用人群、能力对比见 [`README.md`](../README.md)；Agent 的触发条件与部署流程见 [`SKILL.md`](../SKILL.md)。

---

## 1. 架构与数据流

```
WorkBuddy 结果区「网页」页签
        │  HTTP  (127.0.0.1:<IDE_PORT>)
        ▼
单进程 Node 服务 (server.mjs)
   ├── 静态资源    index.html + Monaco /min/vs/*
   ├── 工作区 API  文件树 / 读写 / 新建 / 搜索 / 命令执行 (SSE)
   └── Agent 桥接  ── ACP over HTTP SSE ──► 宿主 Agent 网关 (127.0.0.1:<GATEWAY_PORT>)
                                            复用宿主已鉴权的会话与工具链
```

关键设计：**Agent 能力不自建、不登录、不安装**，通过宿主本地 ACP 端点复用；IDE 只负责界面与工作区文件操作。因此整套系统只有一个用户态进程，无构建步骤、无框架、无外部服务。

---

## 2. 组件与依赖

| 组件 | 说明 | 获取方式 |
| --- | --- | --- |
| Node.js | ≥ 18，需 `node` 与 `npm` 在 PATH | 宿主环境提供 |
| `server.mjs` | 单进程 HTTP 服务 + ACP 桥接 | Skill `scripts/` |
| `index.html` | 前端界面 | Skill `scripts/` |
| Monaco Editor | 离线编辑器资源（`min/vs/` 目录） | 服务首次启动自动 `npm install`，或用 `WB_IDE_MONACO` 复用已有缓存 |
| 宿主 Agent 网关 | 提供 `/api/v1/acp`，已鉴权 | 运行时探测，**不写死端口** |

Monaco 通过 AMD loader 加载，worker 用同源 blob URL 包装 `workerMain.js`，不依赖 CDN，可在离线环境与内置浏览器中使用。

---

## 3. 环境变量契约

全部为**可选**，未设置时按表中默认规则推导。任何值都不得硬编码为某台电脑的路径。

| 变量 | 含义 | 未设置时 |
| --- | --- | --- |
| `WB_IDE_ROOT` | IDE 绑定的工作区根目录 | `server.mjs` 所在目录的父目录 |
| `WB_IDE_PORT` | IDE 服务端口 | `6830`，占用时自动递增至 `6839` |
| `WB_GATEWAY_PORT` | 宿主 Agent 网关端口 | 进入自动发现流程 |
| `WB_IDE_MONACO` | Monaco `min` 目录绝对路径 | `server.mjs` 同级的 `node_modules/monaco-editor/min` |
| `CODEBUDDY_SERVICE_PROXY_URL` | 宿主注入的服务代理 URL，可解析出网关端口 | 忽略，改用其他发现方式 |

路径穿越防护：所有文件 API 都把目标路径 `resolve` 到 `WB_IDE_ROOT` 下校验，越界返回 403。

---

## 4. Agent 网关发现

### 4.1 优先级决策树

```
1. 调用方 Agent 解析自身 CODEBUDDY_SERVICE_PROXY_URL 得到端口
   └─ 校验通过 → 用作 WB_GATEWAY_PORT（最可靠，跨机器通用）
2. 已设置 WB_GATEWAY_PORT → 直接校验
3. 自动发现：枚举本机 loopback LISTENING 端口
   └─ 并发探测 GET /api/v1/health
      └─ 响应体含 "AUTH_REQUIRED" 或 "status" → 判定为网关
4. 全部失败 → 返回 null
   └─ IDE 编辑/终端仍可用；Agent 面板显示未连接
```

**校验标准**（必须同时满足，避免误连其他本地服务）：

- 端口上有 HTTP 服务响应
- `GET /api/v1/health` 返回 `401 {"error":{"code":"AUTH_REQUIRED",...}}` 或 `200 {"data":{"status":"ok"}}`
- `GET /api/v1/acp`（`Accept: text/event-stream`）返回 `acp-connection-id` 响应头

### 4.2 跨平台枚举监听端口

| 平台 | 命令 | 提取规则 |
| --- | --- | --- |
| `win32` | `netstat -ano -p tcp` | 匹配 `127.0.0.1:<port>` 且行含 `LISTENING` |
| `darwin` / `linux` | `lsof -nP -iTCP -sTCP:LISTEN` | 匹配 `127.0.0.1:<port>` |
| 兜底 | `ss -ltn` | 匹配 `:<port>` 且行含 `LISTEN` |

命令不可用时依次尝试下一个；全部不可用则返回空列表，由调用方 Agent 显式传入 `WB_GATEWAY_PORT`。**不要回落到任何固定端口范围**——不同宿主的端口分配策略不同。

### 4.3 参考实现（伪代码，可直接移植）

```
candidates = listening_ports()                 # 平台相关，见 4.2
for batch in chunks(candidates, 20):
    results = parallel(batch.map(port =>
        http_get("http://127.0.0.1:" + port + "/api/v1/health", timeout=300ms)))
    hit = results.find(r => r.body.includes("AUTH_REQUIRED") ||
                            r.body.includes("\"status\""))
    if hit: return hit.port
return null
```

---

## 5. ACP 协议契约

### 5.1 端点与请求头

| 项 | 值 |
| --- | --- |
| 端点 | `POST|GET http://127.0.0.1:<GATEWAY_PORT>/api/v1/acp` |
| GET 头 | `Accept: text/event-stream` |
| POST 头 | `Content-Type: application/json`、`Accept: application/json, text/event-stream`、`acp-connection-id: <CID>` |
| 认证 | **无需**。该端点对本机免鉴权；其它 `/api/v1/*` 端点需要 `Authorization: Bearer <gateway password>`，而该密码通常只注入宿主会话，独立进程不应依赖它 |
| 响应 | SSE：`event: message` + `data: <JSON-RPC 2.0>` |

GET 建立连接后，响应头返回 `acp-connection-id`（后续 POST 必须携带）与 `acp-session-token`。

### 5.2 JSON-RPC 方法

| 方法 | 关键参数 | 作用 |
| --- | --- | --- |
| `initialize` | `{ protocolVersion: 1, clientCapabilities: {}, clientInfo: {name, version} }` | 握手，返回 `agentCapabilities`、`authMethods` |
| `session/new` | `{ cwd: <WORKSPACE>, mcpServers: [] }` | 建立/绑定会话；**`cwd` 为必填字符串** |
| `session/load` | `{ sessionId, cwd, mcpServers: [] }` | 拉取会话历史；本实现不依赖它（部分构建返回空流） |
| `session/prompt` | `{ sessionId, prompt: [{type:"text", text:"..."}] }` | 向会话发送消息 |

`sessionId` 从 `session/new` 响应流中的 `params.sessionId`（或 `result.sessionId`）取得。

### 5.3 事件类型

`session/update` 通知位于 `params.update`，常见 `sessionUpdate` 值：

| 值 | 含义 | 前端处理 |
| --- | --- | --- |
| `user_message_chunk` | 用户输入 | 前端已本地渲染，忽略以免重复 |
| `agent_message_chunk` | Agent 正式回复 | 按 `messageId` 聚合追加 |
| `agent_thought_chunk` | 思考过程 | 弱化为灰色块 |
| `tool_call` / `tool_call_update` | 工具调用 | 显示工具名与状态 |
| `session_info_update` | 标题、回放起止 | 忽略 |
| `config_option_update` / `model_update` | 配置同步 | 忽略 |

历史回放事件带 `_meta["codebuddy.ai"].mode === "history"` 或 `_meta["codebuddy.ai/historyReplay"]`，**必须过滤**，否则打开界面会刷出整段历史。

### 5.4 三个必须遵守的实现要点

1. **事件在 POST 响应流，不在 GET 流**。`session/new` 与 `session/prompt` 的 POST 响应 SSE 流携带对应事件；GET 流主要维持连接。把 POST 响应用 `res.resume()` 丢弃会导致对话面板永久空白。
2. **不要加 `x-codebuddy-web-ui` / `x-codebuddy-request` 标记**。带 `x-codebuddy-web-ui: 1` 时连接被识别为 Web UI 客户端，走内部 `ui.input` / `ui.press` 协议，标准 `session/prompt` 不产生可订阅事件。使用普通 ACP 连接。
3. **POST 请求禁用超时**（`req.setTimeout(0)`）。`session/prompt` 的响应流在 Agent 完成前保持打开，提前销毁会丢失回复。
4. **历史回放的载体随连接方式变化**：普通 ACP 连接的历史事件主要落在 GET SSE 流；带 Web UI 标记时落在 `session/new` 的 POST 响应流。实现必须用**统一收集器**同时接两条流，按 `messageId` 聚合 `user_message_chunk` / `agent_message_chunk`，过滤 `_meta["codebuddy.ai"].mode === "history"` 标记后再决定广播或缓存。

### 5.5 共享会话约束

`session/new` 通常绑定宿主**当前会话**而非创建独立会话，因此：

- 从 IDE 发出的消息会同时出现在宿主主对话区
- 宿主主会话正忙时消息排队，IDE 面板可能延迟收到回复
- 连接建立时由统一收集器把历史回放聚合为最近 16 条消息并广播，界面一打开即有内容；「同步会话」按钮重放该缓存，不依赖 `session/load`

---

## 6. 服务端 HTTP API 契约

所有响应为 JSON（除标注 SSE）。路径参数均相对 `WB_IDE_ROOT`。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/state` | — | `{root, port, gateway, connected, sessionId, monaco}` |
| GET | `/api/tree` | — | `{root, items:[{path,name,type,depth}]}`，深度 ≤ 4，跳过 `node_modules`、`.git`、`.workbuddy` 等 |
| GET | `/api/file?path=` | — | `{content, mtime, size}` |
| POST | `/api/file` | `{path, content}` | `{ok, mtime}` |
| POST | `/api/new` | `{path, type:"file"\|"dir"}` | `{ok}` 或 `409` |
| GET | `/api/search?q=` | — | `{items:[{path,line,text}]}`，最多 200 条，仅文本文件且 < 1 MiB |
| POST | `/api/exec` | `{cmd, cwd?}` | SSE：`{type:"out",text}` … `{type:"done",code}`，120 s 超时 |
| GET | `/api/agent/stream` | — | SSE：`{type:"status"\|"update"\|"history"\|"turn-end", ...}` |
| POST | `/api/agent/prompt` | `{text}` | `{ok}` 或 `503`（Agent 未就绪） |
| POST | `/api/agent/sync` | — | `{ok}`，广播缓存的最近 16 条 `{type:"history", items}` |
| POST | `/api/debug/start` | `{path}` | `{ok, port}` 或 400（仅 .js/.mjs/.cjs） |
| POST | `/api/debug/stop` | — | `{ok}` |
| POST | `/api/debug/action` | `{action: continue\|stepOver\|stepInto\|stepOut\|pause}` | `{ok}` |
| POST | `/api/debug/breakpoints` | `{path, lines:[...]}` | `{ok, applied}`，行号为 1 基 |
| GET | `/api/debug/state` | — | `{running, paused, port, breakpoints}` |
| GET | `/api/debug/stream` | — | SSE：`started` / `paused` / `resumed` / `console` / `exited` / `stopped` |
| GET | `/api/plugins` | — | `{dir, plugins, commands}` |
| POST | `/api/plugin/command` | `{id, args}` | `{ok, result}` 或 500 |
| GET | `/` `/index.html` | — | 界面 |
| GET | `/monaco/*` | — | Monaco 静态资源 |

---

## 7. 前端功能与快捷键

| 功能 | 入口 |
| --- | --- |
| 打开文件 / 多标签切换 / 关闭 | 文件树点击；标签栏 |
| 保存 | `Ctrl+S` 或「保存」按钮 |
| 快速打开文件 | `Ctrl+P`，输入过滤，↑↓ 选择，Enter 打开 |
| 全局文本搜索 | `Ctrl+Shift+F` 或搜索页签；点击结果跳转行 |
| 运行当前文件 | 「运行」按钮或 `Ctrl+Enter`；按扩展名映射 `node` / `python` / `npx tsx` / `bash` |
| 终端 | 命令输入、↑↓ 历史、清屏、Git 状态 |
| 外部修改同步 | 每 2.5 s 比对当前文件 `mtime`；无未保存改动时自动重载，否则提示 |
| Agent 对话 | 右栏输入、Enter 发送；「同步会话」拉历史；「清空」 |
| 状态栏 | 网关连接状态、当前文件、语言、行列、工作区根 |
| 设置/取消断点 | 点击编辑器行号左侧 gutter（红点） |
| 启动或继续调试 | F5 |
| 单步跳过 / 步入 / 步出 | F10 / F11 / Shift+F11 |
| 调试面板 | 底部「调试」页签：控制按钮、调用栈、变量、调试控制台 |
| 命令面板（内置 + 插件命令） | Ctrl+Shift+P |
| 插件管理 | 底部「插件」页签：已加载插件与命令清单 |
| 目录展开/折叠 | 点击文件树中的目录项（`▾` 展开 / `▸` 折叠），状态在当前页面内保持；折叠对多级子路径生效 |
| 新建文件 | 点击工作区标题栏「+」，在浮层输入相对路径（Enter 创建 / Esc 取消）。**不得使用原生 `prompt()`/`confirm()`**：内置浏览器会屏蔽它们且静默失败 |

布局采用绝对行高 `calc(100vh - 212px) / 186px / 26px` 并对所有容器设 `min-height:0; overflow:hidden`，避免 Monaco 自动布局与 grid `1fr` 形成反馈循环、把底部面板挤出视口。

---

## 8. 部署操作手册

### 8.1 首次部署（Agent 执行）

```
# 1. 取当前工作区与脚本目录
WORKSPACE = <宿主提供的当前工作区绝对路径>
SCRIPTS   = <本 Skill scripts 目录绝对路径>

# 2. 取网关端口（见第 4 节；优先从自身 CODEBUDDY_SERVICE_PROXY_URL 解析）
GATEWAY_PORT = <探测结果>

# 3. 后台启动（Windows / macOS / Linux 通用）
WB_IDE_ROOT="$WORKSPACE" \
WB_IDE_PORT=6830 \
WB_GATEWAY_PORT="$GATEWAY_PORT" \
node "$SCRIPTS/server.mjs" &

# 4. 从启动输出读取 URL，打开结果区「网页」页签
GET http://127.0.0.1:<IDE_PORT>/api/state
```

Windows 手动双击可用 `scripts/start.cmd`；它接受第一个参数作为工作区路径，未传则用脚本父目录，并把 `WB_IDE_PORT` 默认设为 6830。

### 8.2 复用（读取 SKILL.md「本机设置」）

```
1. 读取 workspace_root / ide_port / gateway_port / monaco_path
2. 校验（见 SKILL.md 复用校验清单）
3. 通过 → 若服务已停止则用缓存端口重启；否则直接打开界面
4. 失败 → 重新执行 8.1 的探测步骤，成功后回写「本机设置」与 last_verified
```

### 8.3 停止

结束 `node server.mjs` 后台进程。服务无守护进程、无开机自启、不写注册表。

---

## 8A. 图形断点调试（CDP）

**能力**：Monaco gutter 点击设断点，F5 启动/继续，F10 单步跳过，F11 步入，Shift+F11 步出；暂停时显示调用栈、栈顶帧局部变量、当前行高亮与调试控制台输出。

**实现原理**：

1. 后端 `spawn(process.execPath, ['--inspect-brk=0', abs])`，从 stderr 解析 `ws://127.0.0.1:<port>/...`。
2. 用 WebSocket 连接 CDP。Node 22 使用内置全局 `WebSocket`；Node 18 无该全局时自动安装 `ws` 包。
3. 依次调用 `Runtime.enable`、`Debugger.enable`、`Debugger.setBreakpointByUrl`（`lineNumber` 为 0 基）、`Runtime.runIfWaitingForDebugger`。
4. `Debugger.paused` → 取 `callFrames`，对栈顶 local scope 调 `Runtime.getProperties` 得变量；`Debugger.resumed`、`Runtime.consoleAPICalled`、`Runtime.exceptionThrown` 分别处理。
5. 断点用 `pathToFileURL(abs).href` 精确匹配脚本 URL；断点表在服务端内存中按文件保存，页面通过 `/api/debug/breakpoints` 同步。

**约束**：

- 仅 JavaScript（`.js` / `.mjs` / `.cjs`）。TypeScript 需先编译或接入 source map。
- `--inspect-brk=0` 会在入口先暂停一次，属正常现象；点「继续」后命中用户断点。
- 调试端口随机、仅回环，不占用固定端口；会话结束即释放。
- 多语言升级路径：CodeBuddy CN / VS Code 系 IDE 内含 `ms-vscode.js-debug`（DAP 适配器），可另实现 DAP 客户端替代 CDP；代价是需 spawn 适配器并处理路径映射。

---

## 8B. 轻量插件系统（替代扩展市场）

**为什么不做完整扩展市场**：VS Code 扩展需要扩展宿主、VS Code API、webview 与 Node 集成，浏览器内页面无法承载。因此以「本地插件目录 + 命令注册 + 命令面板」提供等价的可扩展能力。

**插件目录**：`<WORKSPACE>/.wb-ide/extensions/`，服务启动时自动创建。放入 `.mjs` 并重启服务即安装，删除即卸载。

**插件契约**：

```js
export const meta = { name: '名称', description: '说明' };
export function activate(api) {
  api.registerCommand('id', '命令标题', async (args) => { return '结果文本'; });
}
```

**`api` 提供**：

| 方法 | 说明 |
| --- | --- |
| `registerCommand(id, title, handler)` | 注册命令，出现在 Ctrl+Shift+P 命令面板 |
| `readFile(relPath)` / `writeFile(relPath, content)` | 读写工作区文件（受路径校验） |
| `listFiles()` | 列出工作区文件相对路径 |
| `run(cmd)` | 在工作区执行命令，返回合并输出 |
| `askAgent(text)` | 向当前 Agent 会话发送消息 |
| `notify(text)` | 向界面推送提示 |

**安全**：插件在服务端进程内以动态 `import` 执行，等价于本地代码，只加载可信来源的 `.mjs`；不要从不可信 URL 自动安装。

**API**：`GET /api/plugins` 返回插件与命令清单；`POST /api/plugin/command {id, args}` 执行插件命令。

---

## 9. 故障排查决策树

| 现象 | 检查 | 处置 |
| --- | --- | --- |
| 打开链接被拒绝 | 服务是否仍在运行；端口是否递增 | 重新启动；以启动输出 URL 为准 |
| 页面空白 / Monaco 报错 | `GET /monaco/vs/loader.js` 是否 200；`/api/state.monaco` | 让服务自动安装，或设置 `WB_IDE_MONACO` |
| 文件树为空或显示 `undefined` | `/api/tree` 的 `items[].name` 是否存在；`WB_IDE_ROOT` 是否正确 | 修正工作区根；确认 tree 返回 `name` 字段 |
| Agent 显示未连接 | `/api/state.gateway` 与 `connected` | 重新探测网关；宿主重启后端口常变化 |
| 右栏无回复 | 是否丢弃了 POST 响应流；是否误加 Web UI 标记；主会话是否正忙 | 按 5.4 修正；确认宿主空闲后再试；点「同步会话」 |
| 右栏刷出大量历史 | 是否过滤 `history` 标记 | 按 5.3 过滤 |
| 底部终端被编辑器遮住 | 布局是否用绝对行高 | 按第 7 节固定 grid 行高 |
| 命令执行无输出 | `/api/exec` 是否返回 SSE；命令是否需交互输入 | 改用非交互命令；查看退出码 |
| 调试启动失败 | 文件是否为 .js/.mjs/.cjs；Node 是否支持 `--inspect-brk=0` | 换用 JS 文件；查看调试控制台中的 inspector 输出 |
| 断点不命中 | 脚本 URL 是否与 `pathToFileURL` 一致；是否仍停在入口暂停 | 点「继续」；确认断点行是可执行语句 |
| 插件未加载 | `.mjs` 是否导出 `activate`；服务启动日志 | 修正导出并重启服务 |
| 命令面板无插件命令 | `/api/plugins` 是否返回 commands | 刷新页面或重启服务 |

---

## 10. 安全边界

- 服务只绑定 `127.0.0.1`，不监听外部接口。
- `/api/exec` 可执行任意 shell 命令，等价于本地终端；不要暴露到局域网或公网。
- 所有文件操作限制在 `WB_IDE_ROOT` 内并做路径校验。
- ACP 端点免鉴权仅限本机；不要转发该端点。
- 「本机设置」段落只存路径与端口，禁止记录令牌、密码、密钥。

---

## 11. CodeBuddy IDE 安装目录的可借鉴材料

若目标机器装有 CodeBuddy CN / VS Code 系 IDE（记为 `<CODEBUDDY_IDE_ROOT>`），可作为**参考**，但本 Skill 不依赖它：

| 路径（相对 `<CODEBUDDY_IDE_ROOT>`） | 价值 |
| --- | --- |
| `bin/buddycn.cmd`、`bin/buddycn` | VS Code CLI 包装；可用于「打开完整桌面 IDE」的可选增强 |
| `resources/app/package.json`、`product.json` | 版本号、产品标识、工作台配置参考 |
| `resources/app/out/cli.js` | CLI 命令实现参考 |
| `resources/app/out/vs/`、`extensions/` | 工作台、Monaco 语言支持、主题与扩展清单；可提取更完整的语言资源 |
| `resources/app/node_modules.asar` | 打包依赖，可用于离线提取前端库 |

**已验证的不可行路径**：该构建的 `serve-web` 会尝试启动 `<CODEBUDDY_IDE_ROOT>/bin/codebuddy-tunnel-cn.exe`，若该二进制未随安装提供则报 `ENOENT`，无法直接获得浏览器版完整工作台。因此以「单 Node 进程 + Monaco」为轻量主路径；如需完整 IDE，可选地用桌面 CLI 打开 `<WORKSPACE>`，但那属于独立窗口，不在 WorkBuddy 内。

---

## 12. 已知限制

- 图形断点调试器仅支持 JavaScript；其他语言需终端运行或接入 DAP 适配器。
- 不提供完整 VS Code 扩展市场，以本地 `.mjs` 插件系统与命令面板替代。
- Agent 对话共享宿主当前会话，主会话忙碌时消息排队。
- `session/new` 会回放历史，必须过滤；`session/load` 同理。
- 文件树深度上限 4 层、搜索上限 200 条、单文件 1 MiB，均为保持轻量的有意约束。

---

## 13. 变更记录

| 版本 | 变更 |
| --- | --- |
| 1.0.0 | 首版：通用化部署、动态网关发现、ACP POST 响应流订阅、多标签/搜索/终端/外部同步、本机设置缓存段落 |
| 1.1.0 | 新增 CDP 图形断点调试器（gutter 断点/单步/调用栈/变量/调试控制台）、轻量插件系统与命令面板；手册增补调试协议与插件 API |
| 1.1.1 | 修复文件树目录无法点击展开/折叠；改为按折叠集合渲染，同时修正切换文件后的选中高亮 |
| 1.1.2 | 新增 `README.md`：定位、快速开始、适用/不适用人群、与完整 IDE 对比、限制风险、FAQ；文档索引互链 |
| 1.1.3 | 修复工作区「+」按钮无响应：自定义输入浮层替代原生 `prompt()`；关闭未保存标签的 `confirm()` 改为二次点击确认；手册补充内置浏览器禁用原生对话框的约束 |
