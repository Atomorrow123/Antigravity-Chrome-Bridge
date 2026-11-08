# Antigravity Chrome Bridge

本地 Chrome 扩展（Manifest V3）+ WebSocket 桥接服务 + CLI 与 MCP 工具链，让 Antigravity 能够直接操控 Chrome 浏览器完成网页浏览、元素点击、表单填写、数据抓取、JS 执行与截图等任务。

## 目录结构

- `extension/` — Manifest V3 Chrome 扩展源码
  - `manifest.json` — 扩展配置
  - `service-worker.js` — 后台 Service Worker，自动连接 `ws://127.0.0.1:18765/ws` 并调度标签页、Content Script 与 `chrome.debugger` (CDP)
  - `content/content.js` & `content/content.css` — 注入页面的交互快照生成（自动标记 `[data-agy-ref]`）、模拟真实点击/输入、高亮动画与状态 Toast
  - `popup/` — 扩展弹窗面板
  - `sidepanel/` — Chrome 侧边栏实时操控中心
- `server/bridge-server.js` — 零依赖本地 WebSocket + HTTP 控制服务端（端口 `18765`）
- `server/mcp-stdio.js` — 标准 MCP (Model Context Protocol) Server，已注册至 `~/.gemini/config/mcp_config.json`
- `cli/agy-chrome.js` — 命令行操控工具
- `scripts/install-and-launch.js` — 一键启动桥接服务并通过 CDP `Extensions.loadUnpacked` 自动安装扩展到持久化 Chrome 实例

## 快速使用

### 1. 自动启动并安装扩展
```powershell
node scripts/install-and-launch.js
```
（如果要在其他已打开的日常 Chrome 窗口中同时加载，也可在 `chrome://extensions` 开启右上角**开发者模式**，点击**加载已解压的扩展程序**并选择 `extension` 文件夹，扩展会自动连入同一个本地 Bridge 服务。）

### 2. CLI 常用指令
```powershell
node cli/agy-chrome.js status                         # 查看连接状态
node cli/agy-chrome.js tabs                           # 列出所有标签页
node cli/agy-chrome.js open "https://www.baidu.com"   # 打开网页
node cli/agy-chrome.js snapshot                       # 获取带 [ref=N] 编号的页面交互快照
node cli/agy-chrome.js fill 1 "Antigravity" --submit  # 向指定 ref 或选择器输入内容并回车
node cli/agy-chrome.js click 2                        # 点击指定 ref、选择器或文本的元素
node cli/agy-chrome.js eval "document.title"          # 执行任意 JS 表达式（绕过页面 CSP）
node cli/agy-chrome.js screenshot "./page.png"        # 截取当前标签页 PNG
```
