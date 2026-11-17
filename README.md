# MiMo Studio

[中文说明](#中文说明) | [English](#english)

---

## 中文说明

一个基于原生 HTML、CSS 和 JavaScript 构建的轻量级单文件 AI 聊天工作台（默认面向小米 MiMo API，亦支持自定义兼容 OpenAI Chat Completions 规范的端点）。

### 主要特性

- **流式对话与参数控制**：支持 SSE 流式输出、随时中断请求（`AbortController`）、`mimo-v2.6-flash` / `mimo-v2.6-pro` 与自定义模型 ID / Endpoint、参数预设、温度调节、思考模式开关，以及 Token 用量与响应耗时统计。
- **树状消息分支**：支持编辑历史用户消息并分叉重发、重新生成助手回复，以及在不同分支回复间自由切换。
- **会话与文件交互**：支持多会话管理（置顶、重命名、搜索）、预设系统指令技能（Skills）、文本/代码文件拖入读取、图片附件上传，以及会话导出（Markdown / JSON）与导入（JSON）。
- **纯内存运行与边界说明**：API Key 与会话数据仅暂存于当前页面内存，不落盘 `localStorage` 或本地数据库，刷新即焚；当前为纯浏览器版本，未接入后端代理、RAG、网页搜索或 MCP。

### 本地使用

1. 直接用现代浏览器打开 `index.html`（或通过 VS Code Live Server 等本地静态服务打开）。
2. 点击右上角 **Run settings**，填入你的 MiMo API Key（仅暂存于当前页面内存）。
3. 选择模型与参数后即可开始对话。

---

## English

A lightweight, single-file AI chat workbench built with vanilla HTML, CSS, and JavaScript. Designed primarily for the Xiaomi MiMo API, and configurable for any OpenAI Chat Completions-compatible endpoint.

### Features

- **Streaming & Run Controls**: Supports SSE streaming, mid-stream cancellation (`AbortController`), `mimo-v2.6-flash` / `mimo-v2.6-pro`, custom model ID & API endpoint, parameter presets, temperature tuning, thinking mode toggle, plus token usage and response duration tracking.
- **Tree-Structured Branches**: Edit previous prompts to fork the conversation, regenerate assistant responses, and switch cleanly between alternative branches.
- **Sessions & Attachments**: Includes multi-session management (pin, rename, search), built-in Skills presets, drag-and-drop / picker support for text/code files and PNG/JPEG/WebP images, Markdown/JSON export, JSON import, and dark/light/system themes.
- **In-Memory Only & Scope**: API keys and conversation trees live strictly in browser page memory (no `localStorage`, IndexedDB, or server persistence; cleared on refresh). Pure client-side implementation without backend proxy, RAG, web search, or MCP.

### Local Usage

1. Open `index.html` in a modern browser (or serve it locally via VS Code Live Server).
2. Click **Run settings** in the top-right corner and enter your MiMo API Key (stored in memory only).
3. Choose your model and parameters to start chatting.
