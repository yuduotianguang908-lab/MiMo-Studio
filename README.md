# MiMo Studio

![HTML5](https://img.shields.io/badge/Vanilla-HTML%20%2F%20CSS%20%2F%20JS-E34F26?style=flat-square&logo=html5&logoColor=white)
![Storage](https://img.shields.io/badge/Storage-IndexedDB-blue?style=flat-square)
![Version](https://img.shields.io/badge/Version-v2.0-brightgreen?style=flat-square)
![API](https://img.shields.io/badge/OpenAI--Compatible-API-412991?style=flat-square)

[English](#-english) | [简体中文](#-简体中文)

---

## 📖 English

A lightweight, zero-build AI chat workbench built with vanilla HTML, CSS, and JavaScript. Pre-configured for the **Xiaomi MiMo API** (`mimo-v2.6-flash` / `mimo-v2.6-pro`), while supporting any custom **OpenAI Chat Completions-compatible** endpoint.

**v2.0** refactors the original single-file prototype into a modular `HTML / CSS / JS` architecture and upgrades local persistence to **IndexedDB**.

### ✨ Key Features

- **Modular Zero-Build Architecture**: Cleanly separated `index.html`, `css/`, and `js/` modules—no Node.js bundler or framework overhead required.
- **IndexedDB Persistence**: Upgraded storage layer to handle larger conversation histories and attachments reliably without hitting `localStorage` quota bottlenecks.
- **Streaming & Parameter Control**: Supports SSE streaming with real-time abort (`AbortController`), custom Model ID / Endpoint, parameter presets, temperature tuning, thinking-mode toggle, and token/latency metrics.
- **Tree-Structured Branching**: Edit historical user prompts to fork new conversation paths, regenerate responses, and switch seamlessly between branches.
- **Session & File Workflows**: Multi-session management (pin, rename, search), reusable system prompt Skills, drag-and-drop text/code file reading, image attachments, and Markdown/JSON export & import.

### 🚀 Quick Start

> ⚠️ **Important**: Serve the project over HTTP (e.g., **VS Code Live Server**). Do **not** open `index.html` directly via `file://`, as browsers enforce strict restrictions on `IndexedDB`, ES modules, and CORS under the `file://` protocol.

1. Clone or download this repository.
2. Open the project root in VS Code and launch **Live Server** (or run any static HTTP server such as `python -m http.server`).
3. Open the local URL in your browser, enter your MiMo API Key (or any OpenAI-compatible Endpoint & Key) in settings, and start chatting.

### 📌 Transparency & Documentation

- **Changelog & QA**: See [`CHANGELOG.md`](./CHANGELOG.md) and [`TEST_REPORT.md`](./TEST_REPORT.md) for v2.0 refactoring details and verification records.
- **Privacy**: Pure client-side application. API keys and chat histories stay strictly in your browser's local storage and are only sent to the API endpoint you configure.
- **Authorship**: Product requirements, feature iteration, and end-to-end testing were directed by the author; code implementation and v2.0 refactoring were generated with AI assistance.

---

## 📖 简体中文

一个基于原生 HTML、CSS 和 JavaScript 构建的轻量级零构建 AI 聊天工作台。默认面向**小米 MiMo API**（`mimo-v2.6-flash` / `mimo-v2.6-pro`），同时兼容任意遵循 **OpenAI Chat Completions** 规范的自定义接口端点。

**v2.0** 将原本的单文件原型重构为模块化的 `HTML / CSS / JS` 目录结构，并将本地持久化存储升级为 **IndexedDB**。

### ✨ 主要特性

- **模块化零构建架构**：拆分后的 `index.html`、`css/` 与 `js/` 结构清晰，无需前端打包工具即可直接运行与二次修改。
- **IndexedDB 本地存储升级**：突破传统 `localStorage` 容量限制，更稳定地承载长对话历史与文件附件。
- **流式对话与参数控制**：支持 SSE 流式输出、随时中断请求（`AbortController`）、自定义模型 ID / Endpoint、参数预设、温度调节、思考模式开关，以及 Token 用量与响应耗时统计。
- **树状消息分支**：支持编辑历史用户消息并分叉重发、重新生成助手回复，以及在不同分支回复间自由切换。
- **会话与文件交互**：支持多会话管理（置顶、重命名、搜索）、预设系统指令技能（Skills）、文本/代码文件拖入读取、图片附件上传，以及会话导出（Markdown / JSON）与导入（JSON）。

### 🚀 快速运行

> ⚠️ **运行注意**：请使用 **VS Code Live Server** 或任意静态 HTTP 服务打开项目根目录；**不要直接双击 `index.html`**，因为浏览器对 `file://` 协议下的 `IndexedDB`、模块资源加载与跨域请求有严格限制。

1. 下载或克隆本仓库到本地。
2. 用 VS Code 打开项目根目录，点击右下角 **Go Live** 启动 Live Server（或使用 `python -m http.server` 等静态服务）。
3. 在浏览器中打开本地地址，在设置中填入你的 MiMo API Key（或任意兼容 OpenAI 格式的接口地址与密钥）即可开始使用。

### 📌 说明与文档

- **更新与测试记录**：v2.0 重构详情与验证情况见仓库内的 [`CHANGELOG.md`](./CHANGELOG.md) 与 [`TEST_REPORT.md`](./TEST_REPORT.md)。
- **数据隐私**：纯前端本地运行，你的 API Key 与对话历史仅保存在浏览器本地，只会直连发往你自己配置的 API 端点。
- **开发方式**：本项目由个人提出需求、规划迭代方向并完成实测验证，代码编写与 v2.0 模块化重构由 AI 辅助生成。