---
name: work-coddy
version: 1.1.3
display_name: 实时 IDE 工作台
display_name_en: Live IDE Workbench
description_zh: 为当前对话与工作空间快速创建实时同步的类 IDE 界面：左侧文件树、多标签 Monaco 编辑器、全局搜索、终端与图形断点调试器，右侧复用 WorkBuddy 现有 Agent 会话的对话面板；另附轻量插件系统与命令面板。无需安装额外 IDE，单 Node 进程、离线可用。
description_en: Provision a live, synchronized IDE-like workspace: file tree, multi-tab Monaco editor, global search, terminal and a graphical breakpoint debugger on the left, plus an Agent chat panel reusing the existing WorkBuddy session on the right. Includes a lightweight plugin system and command palette. No extra IDE installation, single Node process, offline-capable.
---

# 实时 IDE 工作台

## 何时使用

用户提出以下任一诉求时加载本 Skill：

- 希望在 WorkBuddy 窗口内获得代码编辑 / 运行 / 调试界面
- 希望「左边写代码、右边与 Agent 对话」，且与当前工作区实时同步
- 希望不安装独立 IDE 就获得轻量编程工作台
- 需要为某个工作区快速拉起可复用的开发界面

## 能力边界（先读，避免误承诺）

- **提供**：文件树、多标签编辑、语法高亮、Ctrl+S 保存、Ctrl+P 快速打开、全局文本搜索、终端命令流式执行、Git 状态查看、单文件运行、外部文件修改检测与同步、Agent 对话面板与会话历史同步、**图形断点调试器**（gutter 断点、单步、调用栈、局部变量、调试控制台）、**轻量插件系统**（本地 .mjs 插件、Ctrl+Shift+P 命令面板）。
- **不提供**：完整 VS Code 扩展市场（由本地插件系统替代）、完整 VS Code 工作台、非 JavaScript 语言的图形调试（当前调试器仅支持 .js/.mjs/.cjs）。
- **Agent 对话复用当前 WorkBuddy 会话**，不是独立会话。主会话正忙时，从 IDE 发出的消息会排队；这是复用现有 Agent 能力的固有约束。
- 服务仅绑定 `127.0.0.1`；终端可执行任意命令，请勿改绑外部地址。

## 部署流程（由调用方 Agent 执行）

以下步骤中的 `<WORKSPACE>`、`<SCRIPTS>`、`<GATEWAY_PORT>` 等均为**占位符**，必须按当前电脑实测填写，禁止沿用任何示例代码中的具体值。

1. **确定路径**
   - `<WORKSPACE>`：当前工作区绝对路径，从宿主环境取得。
   - `<SCRIPTS>`：本 Skill 的 `scripts/` 目录绝对路径。
   - `<MANUAL>`：本 Skill 的 `references/TECHNICAL-MANUAL.md`，部署细节以手册为准。

2. **读取「本机设置」**（见下一段落）
   - 若字段齐全且校验通过（IDE 端口可访问、工作区路径存在、网关端口 `/api/v1/health` 有响应），直接复用，跳到步骤 5。
   - 任一校验失败 → 执行步骤 3、4 重新探测，并在成功后**回写**该段落。

3. **探测 Agent 网关端口** `<GATEWAY_PORT>`
   按以下优先级，命中即止；完整规则见手册第 4 节：
   1. 调用方 Agent 从自身环境的 `CODEBUDDY_SERVICE_PROXY_URL` 解析出端口并显式传入，这是跨机器最可靠的方式。
   2. 读取 `WB_GATEWAY_PORT` 环境变量。
   3. 按平台枚举本机 loopback 监听端口，逐个请求 `/api/v1/health`，以响应体含 `AUTH_REQUIRED` 或 `"status"` 作为网关特征。
   4. 仍失败则告知用户无法连接 Agent 面板，IDE 编辑与终端功能仍可用。

4. **确定 IDE 服务端口** `<IDE_PORT>`
   默认 6830，被占用时服务会自动递增（上限 6839）；以启动输出打印的 URL 为准。

5. **启动服务**（后台常驻）
   设置环境变量后启动单进程服务：

   ```
   WB_IDE_ROOT=<WORKSPACE>
   WB_IDE_PORT=<IDE_PORT>
   WB_GATEWAY_PORT=<GATEWAY_PORT>          # 可选，显式指定更可靠
   WB_IDE_MONACO=<MONACO_MIN_DIR>          # 可选，复用已有 Monaco 缓存
   node <SCRIPTS>/server.mjs
   ```

   服务首次启动若缺少 Monaco 资源会自动执行 `npm install` 准备离线编辑器资源；需保证 Node 18+ 与 npm 可用（Node 18 无内置 WebSocket 时会自动安装 `ws`）。
   服务同时自动创建 `<WORKSPACE>/.wb-ide/extensions/` 插件目录；放入 `.mjs` 插件并重启服务即完成安装。

6. **打开界面**
   读取启动输出中的 `http://127.0.0.1:<IDE_PORT>`，用结果呈现工具打开该地址，使其在 WorkBuddy 结果区「网页」页签显示；或提示用户在该页签手动输入地址。

7. **验证并回写**
   请求 `/api/state`，确认 `connected: true`、`monaco: true`、`root` 等于 `<WORKSPACE>`。成功后把实测值写入下方「本机设置」，并填写 `last_verified`。

8. **停止**：结束该后台进程即可，无残留服务。

## 本机设置（运行时缓存）

> **规则**：本段是**加速缓存，不是配置源**。任何值在使用前必须校验；校验失败必须重新探测并回写。
> 本段不参与任何代码逻辑，服务端永远从环境变量或运行时探测取值。
> **发布到 Skill 市场前，请把下表所有值恢复为 `未设置`**，以保证包体与具体电脑无关。

| 字段 | 值 | 说明 |
| --- | --- | --- |
| workspace_root | 未设置 | 上次绑定的工作区绝对路径 |
| scripts_dir | 未设置 | `server.mjs` 所在目录绝对路径 |
| gateway_port | 未设置 | 上次成功的 Agent 网关端口（重启宿主后常变化） |
| ide_port | 未设置 | 上次成功的 IDE 服务端口 |
| monaco_path | 未设置 | Monaco `min` 目录绝对路径，或 `auto` |
| last_verified | 未设置 | ISO 8601 时间戳 |
| platform | 未设置 | `win32` / `darwin` / `linux` |

**首次连接后由 Agent 填写示例（仅示意格式，不是固定值）**：

```
workspace_root: <本次工作区绝对路径>
scripts_dir: <本 Skill scripts 目录绝对路径>
gateway_port: <探测到的端口>
ide_port: <启动输出中的端口>
monaco_path: auto
last_verified: <ISO 8601 时间>
platform: <process.platform>
```

**复用时的校验清单**：

1. `GET http://127.0.0.1:<ide_port>/api/state` 是否返回 200 且 `root` 与当前工作区一致；若服务已停止，直接重新启动（端口可复用）。
2. `GET http://127.0.0.1:<gateway_port>/api/v1/health` 是否返回 `AUTH_REQUIRED` 或 `{"data":{"status":"ok"}}`；若否，重新探测网关。
3. Monaco 静态资源 `GET /monaco/vs/loader.js` 是否 200；若否，检查 `WB_IDE_MONACO` 或让服务自动安装。
4. 任一项失败 → 按步骤 3、4 重新探测，成功后覆盖本段并更新 `last_verified`。

## 关键约束（禁止违反）

- 禁止在 `server.mjs`、`index.html`、脚本或手册中写入任何具体的工作区路径、网关端口、用户目录或安装目录。
- 禁止依赖登录态：Agent 能力来自宿主已鉴权的本地 ACP 端点，不要求用户二次登录。
- 禁止丢弃 ACP `POST /api/v1/acp` 的响应体：`session/update` 事件写在 **POST 响应 SSE 流**上，`resume()` 会导致对话面板永久空白。
- 禁止使用 `x-codebuddy-web-ui` 标记走 Web UI 通道：该通道使用内部 UI 协议，标准 `session/prompt` 不产生可订阅事件。
- 禁止把服务绑定到 `0.0.0.0` 或公网地址。
- 调试器当前仅支持 JavaScript；其他语言走终端，或按手册复用 DAP 适配器。
- 插件在服务端进程内动态 `import` 执行，等价于本地代码，只加载可信来源的 `.mjs`。

## 目录结构（严格两级）

```
work-coddy/
├── README.md                     使用说明、适用人群与能力边界
├── SKILL.md                      本文件
├── scripts/
│   ├── server.mjs                单进程服务（通用，无本机硬编码）
│   ├── index.html                界面
│   └── start.cmd                 Windows 手动启动入口
└── references/
    └── TECHNICAL-MANUAL.md       连接、配置与协议的详细技术手册
```

## 参考

完整协议契约、环境变量表、网关发现决策树、服务 API、CDP 调试协议、插件 API、故障排查与 CodeBuddy IDE 安装目录的可借鉴材料，见 `references/TECHNICAL-MANUAL.md`。
