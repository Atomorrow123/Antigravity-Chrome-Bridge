---
name: chrome-bridge
description: >-
  Control the local Chrome browser via the Antigravity Chrome Bridge extension (ws://127.0.0.1:18765/ws).
  Use this skill whenever the user asks Antigravity to operate Chrome, open websites, click buttons,
  fill forms, scrape/extract page content, take screenshots, or execute multi-step web tasks in Chrome.
---

# Antigravity Chrome Bridge Skill

Antigravity can directly inspect and control the user's Chrome browser via the **Antigravity Chrome Bridge** extension (`{{BRIDGE_RUNTIME_DIR}}/extension`) and its local WebSocket/HTTP server (`127.0.0.1:18765`).

## 1. Ensure Chrome & Bridge Are Connected

Check connection status with:

```powershell
node "{{BRIDGE_RUNTIME_DIR}}/cli/agy-chrome.js" status
```

If `"connected": false`, launch Chrome with the extension pre-installed and connected by running:

```powershell
node "{{BRIDGE_RUNTIME_DIR}}/scripts/install-and-launch.js"
```

## 2. Core Workflow for Completing Web Tasks

Always follow the **Navigate -> Snapshot -> Interact -> Verify** loop:

1. **Open / Navigate to target URL**:
   ```powershell
   node "{{BRIDGE_RUNTIME_DIR}}/cli/agy-chrome.js" open "https://example.com"
   ```
2. **Capture Interactive Snapshot** (stamps every visible button, link, and input with `[ref=N]`):
   ```powershell
   node "{{BRIDGE_RUNTIME_DIR}}/cli/agy-chrome.js" snapshot
   ```
3. **Interact with Elements** (by `ref` number, CSS selector, or visible text):
   - **Fill input & optionally submit**:
     ```powershell
     node "{{BRIDGE_RUNTIME_DIR}}/cli/agy-chrome.js" fill 1 "search query" --submit
     ```
   - **Click button or link**:
     ```powershell
     node "{{BRIDGE_RUNTIME_DIR}}/cli/agy-chrome.js" click 2
     ```
   - **Scroll / Press key / Wait**:
     ```powershell
     node "{{BRIDGE_RUNTIME_DIR}}/cli/agy-chrome.js" scroll down 600
     node "{{BRIDGE_RUNTIME_DIR}}/cli/agy-chrome.js" press Enter
     node "{{BRIDGE_RUNTIME_DIR}}/cli/agy-chrome.js" wait "Expected Text"
     ```
4. **Evaluate JS or Capture Screenshot**:
   - **Evaluate JS (via Chrome Debugger `Runtime.evaluate`, bypassing page CSP)**:
     ```powershell
     node "{{BRIDGE_RUNTIME_DIR}}/cli/agy-chrome.js" eval "document.title"
     ```
   - **Save PNG Screenshot**:
     ```powershell
     node "{{BRIDGE_RUNTIME_DIR}}/cli/agy-chrome.js" screenshot "C:\path\to\screenshot.png"
     ```
