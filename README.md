<p align="center">
  <img src="assets/icon-128.png" width="96" alt="Antigravity Chrome Bridge Logo">
</p>

<h1 align="center">Antigravity Chrome Bridge (v1.0)</h1>

<p align="center">本地 Chrome 扩展（Manifest V3）+ 零依赖双引擎 WebSocket 桥接服务 + Antigravity 原生插件（MCP + Skill + CLI）</p>

<p align="center">
  <a href="https://github.com/Atomorrow123/Antigravity-Chrome-Bridge">GitHub</a> ·
  <a href="https://github.com/Atomorrow123/Antigravity-Chrome-Bridge/releases">Releases 下载压缩包</a> ·
  贡献作者：<strong>齐天大圣123</strong> &amp; <strong>Antigravity Agent</strong>
</p>

---

## ✨ 项目简介

**Antigravity Chrome Bridge** 让 **Antigravity** 能够直接连接并操控你本地的 Google Chrome 浏览器，完成多标签页调度、交互快照提取（自动打标 `[ref=N]`）、元素点击、表单输入、绕过页面 CSP 的 JS 执行以及高清网页截图等自动化任务。

- **零第三方依赖**：纯 Node.js 标准库实现 RFC 6455 WebSocket 桥接服务（`127.0.0.1:18765`）与 MCP Stdio 服务端，无需 `npm install`。
- **双引擎控制架构**：支持 **Chrome Manifest V3 扩展直连**（自带 Popup 状态面板与 Side Panel 实时操控台）以及 **CDP 远程调试回退引擎**。
- **开箱即用插件包**：一键安装为标准 Antigravity Plugin（自动注册 10 个 `chrome_*` MCP 工具与 `chrome-bridge` Skill 技能）。

---

## 📦 仓库目录结构

```text
Antigravity-Chrome-Bridge/
├── install.bat                  # Windows 双击一键安装 Antigravity 插件与 MCP 服务
├── install.ps1                  # PowerShell 安装/卸载脚本
├── install.sh                   # macOS / Linux 安装/卸载脚本
├── install.js                   # 跨平台核心安装器（自动适配当前机器用户路径）
├── launch-chrome-bridge.bat     # 一键启动桥接服务 + 自动挂载扩展的独立 Chrome 窗口
│
├── browser-extension/           # 【1. 浏览器扩展】Chrome Manifest V3 扩展包
│   ├── manifest.json            # 可直接在 chrome://extensions「加载已解压的扩展程序」选择此目录
│   ├── service-worker.js        # 后台保活与 WebSocket / chrome.debugger 调度
│   ├── content/                 # 页面交互快照（[ref=N]）、模拟点击输入与高亮 Toast
│   ├── popup/                   # 扩展弹窗控制面板
│   └── sidepanel/               # Chrome 侧边栏实时日志与操控中心
│
└── antigravity-package/         # 【2. Antigravity 安装包】标准 Antigravity Plugin 插件包
    ├── plugin.json              # Antigravity 插件清单
    ├── mcp_config.json.template # MCP 服务配置模板（安装时自动渲染绝对路径）
    ├── skills/chrome-bridge/    # Chrome Bridge 技能工作流指引（SKILL.md）
    └── runtime/                 # 本地 WebSocket 桥接服务 + MCP Stdio 服务 + CLI 工具
```

---

## 🚀 快速安装（两步完成）

> **前置要求**：已安装 [Node.js](https://nodejs.org/)（建议 v18+）与 Google Chrome 浏览器。

### 第一步：安装 Antigravity 插件端

克隆仓库（或从 [Releases](https://github.com/Atomorrow123/Antigravity-Chrome-Bridge/releases) 下载 `Antigravity-Chrome-Bridge.zip` 解压）：

```bash
git clone https://github.com/Atomorrow123/Antigravity-Chrome-Bridge.git
cd Antigravity-Chrome-Bridge
```

- **Windows（双击或命令行）**：双击 `install.bat`，或运行：
  ```powershell
  ./install.ps1
  ```
- **macOS / Linux**：
  ```bash
  chmod +x install.sh && ./install.sh
  ```

安装完成后，组件将自动部署至 `~/.gemini/config/plugins/antigravity-chrome-bridge`，**重启一次 Antigravity IDE** 即可生效。

*(如需卸载，运行 `node install.js --uninstall` 或 `./install.ps1 -Uninstall` 即可。)*

### 第二步：在 Chrome 浏览器加载扩展

任选以下两种方式之一：

1. **加载到日常 Chrome 浏览器（推荐）**：
   - 打开 Chrome 访问 `chrome://extensions`，开启右上角 **「开发者模式」(Developer mode)**。
   - 点击左上角 **「加载已解压的扩展程序」(Load unpacked)**。
   - 选择安装后的永久扩展目录（运行安装脚本时已自动复制到剪贴板）：
     - Windows: `C:\Users\<你的用户名>\.gemini\config\plugins\antigravity-chrome-bridge\runtime\extension`
     - macOS/Linux: `~/.gemini/config/plugins/antigravity-chrome-bridge/runtime/extension`
     - 或直接选择本仓库下的 `browser-extension` 目录。
2. **一键启动专属受控 Chrome 实例**：
   - 双击运行 `launch-chrome-bridge.bat`（或执行 `node antigravity-package/runtime/scripts/install-and-launch.js`）。

当扩展图标徽标变为绿色 **`ON`**，即表示已成功连接本地桥接服务！

---

## 🛠️ 内置 MCP 工具与 CLI 指令

### MCP 工具列表（`antigravity-chrome-bridge`）

| 工具名称 | 功能说明 |
| :--- | :--- |
| `chrome_list_tabs` | 列出所有打开的 Chrome 标签页（`tabId`、标题、URL、激活状态） |
| `chrome_open_url` | 新建标签页或跳转已有标签页至目标 URL 并等待加载完成 |
| `chrome_get_snapshot` | 提取页面标题、正文摘要及带 `[ref=N]` 编号的全部可交互元素快照 |
| `chrome_click` | 通过 `ref` 编号、CSS 选择器或可见文本精准点击元素 |
| `chrome_fill` | 向输入框、`textarea`、`select` 或富文本区域填入内容并支持自动回车提交 |
| `chrome_press_key` | 发送键盘按键（如 `Enter`、`Escape`、`Tab`、`ArrowDown`） |
| `chrome_scroll` | 控制页面向上、向下、回到顶部或滚到底部 |
| `chrome_eval_js` | 通过 Chrome Debugger `Runtime.evaluate` 执行任意异步 JS 表达式（绕过页面 CSP） |
| `chrome_screenshot` | 截取当前标签页高清 PNG 截图并保存到本地路径 |
| `chrome_wait_for` | 等待指定 CSS 选择器或目标文本出现在页面中 |

### CLI 命令行工具（`agy-chrome.js`）

```powershell
node antigravity-package/runtime/cli/agy-chrome.js status                         # 查看桥接状态
node antigravity-package/runtime/cli/agy-chrome.js tabs                           # 列出所有标签页
node antigravity-package/runtime/cli/agy-chrome.js open "https://example.com"     # 打开网页
node antigravity-package/runtime/cli/agy-chrome.js snapshot                       # 获取 [ref=N] 交互快照
node antigravity-package/runtime/cli/agy-chrome.js fill 1 "Antigravity" --submit  # 输入并提交
node antigravity-package/runtime/cli/agy-chrome.js click 2                        # 点击元素
node antigravity-package/runtime/cli/agy-chrome.js eval "document.title"          # 执行 JS
node antigravity-package/runtime/cli/agy-chrome.js screenshot "./page.png"        # 网页截图
```

---

## 贡献作者

- **齐天大圣123** ([Atomorrow123](https://github.com/Atomorrow123))
- **Antigravity Agent**

## License

[MIT](LICENSE) © 2026 齐天大圣123 & Antigravity Agent
