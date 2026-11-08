#!/usr/bin/env node
/**
 * Antigravity Chrome Bridge — Dual-Engine Local Control Server (Extension WS + Direct CDP DevToolsActivePort)
 * Zero external dependencies. Listens on http://127.0.0.1:18765
 * - Engine 1: Chrome Extension WebSocket (ws://127.0.0.1:18765/ws)
 * - Engine 2: Chrome Remote Debugging (DevToolsActivePort in %LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort)
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.AGY_BRIDGE_PORT || 18765);
const HOST = process.env.AGY_BRIDGE_HOST || '127.0.0.1';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const CONTENT_JS_PATH = path.join(__dirname, '..', 'extension', 'content', 'content.js');
const CONTENT_CSS_PATH = path.join(__dirname, '..', 'extension', 'content', 'content.css');
const ICON_128_PATH = path.join(__dirname, '..', 'extension', 'icons', 'icon-128.png');

process.stdout?.on?.('error', () => {});
process.stderr?.on?.('error', () => {});

const clients = new Set();
const pendingRequests = new Map();
const recentHistory = [];

function recordHistory(item) {
  recentHistory.unshift({ timestamp: new Date().toISOString(), ...item });
  if (recentHistory.length > 100) recentHistory.pop();
}

// --- RFC 6455 Server Frame Helpers ---

function encodeWsFrame(opcode, payloadBuffer, mask = false) {
  const len = payloadBuffer.length;
  const maskBit = mask ? 0x80 : 0x00;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = maskBit | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  if (!mask) {
    return Buffer.concat([header, payloadBuffer]);
  }
  const maskKey = crypto.randomBytes(4);
  const maskedPayload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = payloadBuffer[i] ^ maskKey[i & 3];
  }
  return Buffer.concat([header, maskKey, maskedPayload]);
}

function sendWsText(socket, text, mask = false) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  const payload = Buffer.from(String(text), 'utf8');
  socket.write(encodeWsFrame(0x01, payload, mask));
  return true;
}

function attachWsParser(socket, onMessage, onClose, isClient = false) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let currentOpcode = 0;

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const byte0 = buffer[0];
      const byte1 = buffer[1];
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) {
        return;
      }

      let maskKey = null;
      if (masked) {
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
      buffer = buffer.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x08) {
        try {
          socket.write(encodeWsFrame(0x08, Buffer.alloc(0), isClient));
          socket.end();
        } catch (_e) {}
        onClose();
        return;
      } else if (opcode === 0x09) {
        if (!socket.destroyed) {
          socket.write(encodeWsFrame(0x0a, payload, isClient));
        }
      } else if (opcode === 0x0a) {
        // Pong
      } else if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
        if (opcode !== 0x00) currentOpcode = opcode;
        fragments.push(payload);
        if (fin) {
          const fullPayload = Buffer.concat(fragments);
          fragments = [];
          if (currentOpcode === 0x01) {
            onMessage(fullPayload.toString('utf8'));
          }
        }
      }
    }
  });

  socket.on('close', onClose);
  socket.on('error', () => onClose());
}

// --- Engine 2: Direct CDP Client via Chrome's DevToolsActivePort ---

function getDevToolsActivePortEndpoint() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'DevToolsActivePort'),
    path.join(__dirname, '..', 'chrome-profile', 'DevToolsActivePort')
  ];
  for (const portFile of candidates) {
    if (portFile && fs.existsSync(portFile)) {
      try {
        const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        if (lines.length >= 2 && lines[0] && lines[1]) {
          return `ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`;
        }
      } catch (_e) {}
    }
  }
  return null;
}

class DirectCdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.lastActiveTargetId = null;
  }

  async connect(timeoutMs = 5000) {
    const parsed = new URL(this.wsUrl);
    const key = crypto.randomBytes(16).toString('base64');

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout connecting to Chrome Remote Debugging at ${this.wsUrl}`));
      }, timeoutMs);

      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13'
        }
      });

      req.on('upgrade', (_res, socket) => {
        clearTimeout(timer);
        this.socket = socket;
        socket.setNoDelay(true);
        attachWsParser(
          socket,
          rawText => {
            try {
              const msg = JSON.parse(rawText);
              if (msg.id && this.pending.has(msg.id)) {
                const p = this.pending.get(msg.id);
                clearTimeout(p.timer);
                this.pending.delete(msg.id);
                if (msg.error) {
                  p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                } else {
                  p.resolve(msg.result);
                }
              }
            } catch (_e) {}
          },
          () => {
            this.socket = null;
            for (const p of this.pending.values()) {
              clearTimeout(p.timer);
              p.reject(new Error('CDP WebSocket closed'));
            }
            this.pending.clear();
          },
          true
        );
        resolve(this);
      });

      req.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      req.end();
    });
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        return reject(new Error('CDP socket is not connected'));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      sendWsText(this.socket, JSON.stringify(payload), true);
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.end();
      } catch (_e) {}
    }
  }
}

let cachedLastTargetId = null;

async function withCdpBrowser(fn) {
  const wsUrl = getDevToolsActivePortEndpoint();
  if (!wsUrl) {
    throw new Error('No Chrome Extension or Remote Debugging DevToolsActivePort found.');
  }
  const cdp = new DirectCdpSession(wsUrl);
  await cdp.connect(5000);
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

async function resolveCdpPageTarget(cdp, requestedTabId) {
  const { targetInfos = [] } = await cdp.send('Target.getTargets');
  const pages = targetInfos.filter(t => t.type === 'page');
  if (pages.length === 0) {
    throw new Error('No open page targets in Chrome.');
  }

  if (requestedTabId !== undefined && requestedTabId !== null) {
    const reqStr = String(requestedTabId);
    // Match by 1-based index or targetId prefix
    if (/^\d+$/.test(reqStr)) {
      const idx = Number(reqStr) - 1;
      if (pages[idx]) {
        cachedLastTargetId = pages[idx].targetId;
        return pages[idx];
      }
    }
    const byId = pages.find(p => p.targetId === reqStr || p.targetId.startsWith(reqStr));
    if (byId) {
      cachedLastTargetId = byId.targetId;
      return byId;
    }
  }

  if (cachedLastTargetId) {
    const cached = pages.find(p => p.targetId === cachedLastTargetId);
    if (cached && !cached.url.startsWith('chrome://')) return cached;
  }

  // Prefer normal web pages over chrome:// pages
  const webPage = pages.find(p => p.url.startsWith('http://') || p.url.startsWith('https://'));
  return webPage || pages[0];
}

async function ensureHelperInjectedInCdpSession(cdp, sessionId) {
  const checkRes = await cdp.send(
    'Runtime.evaluate',
    {
      expression: 'Boolean(globalThis.__AGY_BRIDGE_API__)',
      returnByValue: true
    },
    sessionId
  );

  if (!checkRes?.result?.value) {
    const cssCode = fs.readFileSync(CONTENT_CSS_PATH, 'utf8');
    const jsCode = fs.readFileSync(CONTENT_JS_PATH, 'utf8');
    const injectExpr = `(() => {
      if (!document.getElementById('agy-bridge-injected-style')) {
        const style = document.createElement('style');
        style.id = 'agy-bridge-injected-style';
        style.textContent = ${JSON.stringify(cssCode)};
        (document.head || document.documentElement).appendChild(style);
      }
    })();\n${jsCode}`;
    await cdp.send(
      'Runtime.evaluate',
      {
        expression: injectExpr,
        returnByValue: true
      },
      sessionId
    );
  }
}

async function runCdpContentAction(cdp, target, action, params = {}) {
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true
  });
  await ensureHelperInjectedInCdpSession(cdp, sessionId);
  const evalRes = await cdp.send(
    'Runtime.evaluate',
    {
      expression: `globalThis.__AGY_BRIDGE_API__.handleContentAction(${JSON.stringify(action)}, ${JSON.stringify(params)})`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    },
    sessionId
  );
  if (evalRes.exceptionDetails) {
    throw new Error(
      evalRes.exceptionDetails.exception?.description ||
        evalRes.exceptionDetails.text ||
        `Content action ${action} failed`
    );
  }
  return evalRes.result?.value;
}

async function executeViaDirectCdp(command, params = {}) {
  return await withCdpBrowser(async cdp => {
    switch (command) {
      case 'ping': {
        const ver = await cdp.send('Browser.getVersion');
        return {
          pong: true,
          mode: 'remote-debugging-cdp',
          browser: ver.product,
          timestamp: Date.now()
        };
      }

      case 'list_tabs': {
        const { targetInfos = [] } = await cdp.send('Target.getTargets');
        const pages = targetInfos.filter(t => t.type === 'page');
        return {
          mode: 'remote-debugging-cdp',
          count: pages.length,
          tabs: pages.map((p, idx) => ({
            id: idx + 1,
            targetId: p.targetId,
            title: p.title || '',
            url: p.url || '',
            active: p.targetId === cachedLastTargetId || idx === 0,
            status: 'complete'
          }))
        };
      }

      case 'open_tab':
      case 'navigate': {
        const { url, tabId } = params;
        if (!url) throw new Error('Parameter "url" is required');
        let targetId;
        if (tabId !== undefined && tabId !== null) {
          const target = await resolveCdpPageTarget(cdp, tabId);
          targetId = target.targetId;
          const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
          await cdp.send('Page.navigate', { url }, sessionId);
          await cdp.send('Target.activateTarget', { targetId });
        } else {
          const created = await cdp.send('Target.createTarget', { url });
          targetId = created.targetId;
          await cdp.send('Target.activateTarget', { targetId });
        }
        cachedLastTargetId = targetId;
        await new Promise(r => setTimeout(r, 900));
        const { targetInfos = [] } = await cdp.send('Target.getTargets');
        const pages = targetInfos.filter(t => t.type === 'page');
        const idx = pages.findIndex(p => p.targetId === targetId);
        const info = pages[idx] || { targetId, title: '', url };
        return {
          tabId: idx >= 0 ? idx + 1 : targetId,
          targetId,
          title: info.title,
          url: info.url,
          status: 'complete'
        };
      }

      case 'activate_tab': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        await cdp.send('Target.activateTarget', { targetId: target.targetId });
        cachedLastTargetId = target.targetId;
        return {
          activated: true,
          tabId: params.tabId,
          targetId: target.targetId,
          title: target.title,
          url: target.url
        };
      }

      case 'close_tab': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        await cdp.send('Target.closeTarget', { targetId: target.targetId });
        return { closed: true, targetId: target.targetId };
      }

      case 'reload_tab': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        await cdp.send('Page.reload', {}, sessionId);
        await new Promise(r => setTimeout(r, 700));
        return { reloaded: true, targetId: target.targetId, title: target.title, url: target.url };
      }

      case 'get_snapshot':
      case 'snapshot': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        cachedLastTargetId = target.targetId;
        const snap = await runCdpContentAction(cdp, target, 'snapshot', params);
        return { tabId: params.tabId || target.targetId, ...snap };
      }

      case 'click': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        cachedLastTargetId = target.targetId;
        const res = await runCdpContentAction(cdp, target, 'click', params);
        return { tabId: params.tabId || target.targetId, ...res };
      }

      case 'fill':
      case 'type': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        cachedLastTargetId = target.targetId;
        const res = await runCdpContentAction(cdp, target, 'fill', params);
        return { tabId: params.tabId || target.targetId, ...res };
      }

      case 'press_key': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        cachedLastTargetId = target.targetId;
        const res = await runCdpContentAction(cdp, target, 'press_key', params);
        return { tabId: params.tabId || target.targetId, ...res };
      }

      case 'scroll': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        cachedLastTargetId = target.targetId;
        const res = await runCdpContentAction(cdp, target, 'scroll', params);
        return { tabId: params.tabId || target.targetId, ...res };
      }

      case 'wait_for': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        cachedLastTargetId = target.targetId;
        const res = await runCdpContentAction(cdp, target, 'wait_for', params);
        return { tabId: params.tabId || target.targetId, ...res };
      }

      case 'extract': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        cachedLastTargetId = target.targetId;
        const res = await runCdpContentAction(cdp, target, 'extract', params);
        return { tabId: params.tabId || target.targetId, ...res };
      }

      case 'eval_js': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        cachedLastTargetId = target.targetId;
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const evalRes = await cdp.send(
          'Runtime.evaluate',
          {
            expression: String(params.expression || params.code),
            awaitPromise: true,
            returnByValue: true,
            userGesture: true
          },
          sessionId
        );
        if (evalRes.exceptionDetails) {
          throw new Error(
            evalRes.exceptionDetails.exception?.description ||
              evalRes.exceptionDetails.text ||
              'JS evaluation failed'
          );
        }
        return {
          tabId: params.tabId || target.targetId,
          title: target.title,
          url: target.url,
          value: evalRes.result?.value
        };
      }

      case 'screenshot': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        cachedLastTargetId = target.targetId;
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        return {
          tabId: params.tabId || target.targetId,
          title: target.title,
          url: target.url,
          dataUrl: `data:image/png;base64,${shot.data}`
        };
      }

      case 'cdp': {
        const target = await resolveCdpPageTarget(cdp, params.tabId);
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const response = await cdp.send(params.method, params.commandParams || {}, sessionId);
        return {
          tabId: params.tabId || target.targetId,
          method: params.method,
          response
        };
      }

      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  });
}

// --- Dispatch Command (Extension First, Direct CDP Fallback) ---

function getActiveClient() {
  let latest = null;
  for (const client of clients) {
    if (!client.socket.destroyed && client.socket.writable) {
      if (!latest || client.lastSeen >= latest.lastSeen) {
        latest = client;
      }
    }
  }
  return latest;
}

async function dispatchCommand(command, params = {}, timeoutMs = 25000) {
  const extClient = getActiveClient();
  if (extClient) {
    const reqId = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(reqId);
        reject(new Error(`Extension command "${command}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      pendingRequests.set(reqId, { resolve, reject, timer, command });

      const sent = sendWsText(
        extClient.socket,
        JSON.stringify({
          type: 'request',
          id: reqId,
          command,
          params
        })
      );

      if (!sent) {
        clearTimeout(timer);
        pendingRequests.delete(reqId);
        reject(new Error('Failed to write command to extension WebSocket.'));
      }
    });
  }

  // Fallback to Direct CDP (DevToolsActivePort on main Chrome)
  return await executeViaDirectCdp(command, params);
}

// --- HTTP Server ---

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>Antigravity Bridge · 本地控制中心</title>
  <link rel="icon" type="image/png" href="/icon.png">
  <style>
    :root {
      --bg-light: #f5f5f7;
      --bg-dark: #000000;
      --surface-light: #ffffff;
      --surface-dark: #1c1c1e;
      --surface-sunken-light: #efeff4;
      --surface-sunken-dark: #121214;
      --text-light: #1d1d1f;
      --text-dark: #f5f5f7;
      --text-sec-light: #636366;
      --text-sec-dark: #98989d;
      --border-light: rgba(0, 0, 0, 0.08);
      --border-dark: rgba(255, 255, 255, 0.10);
      --accent-light: #0071e3;
      --accent-dark: #2997ff;
      --green-light: #1d8333;
      --green-dark: #30d158;
      --amber-light: #9e5800;
      --amber-dark: #ffd60a;

      --bg: var(--bg-light);
      --surface: var(--surface-light);
      --surface-sunken: var(--surface-sunken-light);
      --text: var(--text-light);
      --text-sec: var(--text-sec-light);
      --border: var(--border-light);
      --accent: var(--accent-light);
      --ok: var(--green-light);
      --warn: var(--amber-light);

      @media (prefers-color-scheme: dark) {
        --bg: var(--bg-dark);
        --surface: var(--surface-dark);
        --surface-sunken: var(--surface-sunken-dark);
        --text: var(--text-dark);
        --text-sec: var(--text-sec-dark);
        --border: var(--border-dark);
        --accent: var(--accent-dark);
        --ok: var(--green-dark);
        --warn: var(--amber-dark);
      }

      @supports (color: light-dark(white, black)) {
        --bg: light-dark(var(--bg-light), var(--bg-dark));
        --surface: light-dark(var(--surface-light), var(--surface-dark));
        --surface-sunken: light-dark(var(--surface-sunken-light), var(--surface-sunken-dark));
        --text: light-dark(var(--text-light), var(--text-dark));
        --text-sec: light-dark(var(--text-sec-light), var(--text-sec-dark));
        --border: light-dark(var(--border-light), var(--border-dark));
        --accent: light-dark(var(--accent-light), var(--accent-dark));
        --ok: light-dark(var(--green-light), var(--green-dark));
        --warn: light-dark(var(--amber-light), var(--amber-dark));
      }

      color-scheme: light dark;
      --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif;
      --font-mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", monospace;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      background: color-mix(in oklab, var(--bg) 92%, var(--text) 8%);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
      padding: 16px;
      -webkit-font-smoothing: antialiased;
    }

    .stage-shell {
      max-width: 1040px;
      min-height: calc(100vh - 32px);
      margin: 0 auto;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 32px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05), 0 20px 48px rgba(0, 0, 0, 0.07), inset 0 1px 0 rgba(255, 255, 255, 0.65);
      padding: 18px 24px 44px;
    }

    header {
      position: sticky;
      top: 14px;
      z-index: 10;
      max-width: 960px;
      margin: 0 auto;
      border-radius: 9999px;
      backdrop-filter: saturate(180%) blur(20px);
      background: color-mix(in oklab, var(--surface) 82%, transparent);
      border: 0.5px solid var(--border);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04), 0 8px 24px rgba(0, 0, 0, 0.04);
    }

    .nav-inner {
      padding: 11px 18px 11px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .brand { display: flex; align-items: center; gap: 12px; }
    .brand img { filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.16)); }
    .brand h1 { font-size: 16.5px; font-weight: 600; letter-spacing: -0.02em; }
    .brand p { font-size: 12px; color: var(--text-sec); }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 5.5px 14px;
      border-radius: 9999px;
      font-size: 12.5px;
      font-weight: 600;
      background: color-mix(in oklab, var(--ok) 14%, transparent);
      color: var(--ok);
      white-space: nowrap;
    }
    .pill[data-state="warn"] {
      background: color-mix(in oklab, var(--warn) 15%, transparent);
      color: var(--warn);
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }

    main {
      max-width: 960px;
      margin: 22px auto 0;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .bento {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 14px;
    }

    .card {
      background: var(--surface);
      border: 0.5px solid var(--border);
      border-radius: 26px;
      padding: 22px 24px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03), 0 8px 24px rgba(0, 0, 0, 0.04);
    }

    .kpi-label { font-size: 12.5px; font-weight: 500; color: var(--text-sec); }
    .kpi-value {
      margin-top: 6px;
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -0.03em;
      font-variant-numeric: tabular-nums;
    }
    .kpi-sub { margin-top: 4px; font-size: 12px; color: var(--text-sec); font-family: var(--font-mono); }

    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .section-head h2 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
    .btn {
      font: inherit;
      font-size: 12.5px;
      font-weight: 600;
      padding: 6.5px 16px;
      border-radius: 9999px;
      border: none;
      background: #0071e3;
      color: #fff;
      cursor: pointer;
    }
    .btn:focus-visible { outline: 2.5px solid var(--accent); outline-offset: 2px; }

    .log-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 320px;
      overflow-y: auto;
      scrollbar-width: thin;
    }
    .log-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 9.5px 14px;
      border-radius: 14px;
      background: var(--surface-sunken);
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .log-time { color: var(--text-sec); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .empty { color: var(--text-sec); font-size: 13px; padding: 18px 0; text-align: center; }
  </style>
</head>
<body>
  <div class="stage-shell">
    <header>
      <div class="nav-inner">
        <div class="brand">
          <img src="/icon.png" alt="" width="36" height="36">
          <div>
            <h1>Antigravity Chrome Bridge</h1>
            <p>静默后台守护进程 · Local WebSocket &amp; CDP Engine</p>
          </div>
        </div>
        <div id="conn-pill" class="pill" role="status" aria-live="polite">
          <span class="dot" aria-hidden="true"></span>
          <span id="conn-text">读取状态中</span>
        </div>
      </div>
    </header>

    <main>
      <section class="bento" aria-label="核心运行指标">
        <div class="card">
          <div class="kpi-label">驱动引擎</div>
          <div id="kpi-mode" class="kpi-value">—</div>
          <div id="kpi-endpoint" class="kpi-sub">ws://127.0.0.1:${PORT}/ws</div>
        </div>
        <div class="card">
          <div class="kpi-label">已连接扩展实例</div>
          <div id="kpi-clients" class="kpi-value">0</div>
          <div id="kpi-tabs" class="kpi-sub">等待浏览器握手中</div>
        </div>
        <div class="card">
          <div class="kpi-label">静默守护时长</div>
          <div id="kpi-uptime" class="kpi-value">0s</div>
          <div class="kpi-sub">Port ${PORT} · 无窗口后台模式</div>
        </div>
      </section>

      <section class="card" aria-labelledby="logs-title">
        <div class="section-head">
          <h2 id="logs-title">实时桥接事件与指令日志</h2>
          <button type="button" id="refresh-btn" class="btn">立即刷新</button>
        </div>
        <ul id="logs-ul" class="log-list" role="list">
          <li class="empty">暂无最近指令记录</li>
        </ul>
      </section>
    </main>
  </div>

  <script>
    function fmtUptime(sec) {
      if (sec < 60) return sec + 's';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
      return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    }

    async function load() {
      try {
        const [stRes, lgRes] = await Promise.all([fetch('/status'), fetch('/logs')]);
        const st = await stRes.json();
        const lg = await lgRes.json();

        const pill = document.getElementById('conn-pill');
        const connText = document.getElementById('conn-text');
        if (st.connected) {
          pill.dataset.state = 'ok';
          connText.textContent = '已就绪 · 浏览器已连接';
        } else {
          pill.dataset.state = 'warn';
          connText.textContent = '守护运行中 · 待浏览器连接';
        }

        const modeMap = {
          'extension-websocket': 'Extension WS',
          'remote-debugging-cdp': 'Direct CDP',
          'disconnected': 'Standby'
        };
        document.getElementById('kpi-mode').textContent = modeMap[st.mode] || st.mode;
        document.getElementById('kpi-clients').textContent = String(st.extensionClientCount || 0);
        const totalTabs = (st.clients || []).reduce((acc, c) => acc + (c.tabCount || 0), 0);
        document.getElementById('kpi-tabs').textContent = st.extensionClientCount
          ? '共受控 ' + totalTabs + ' 个标签页'
          : '打开装有扩展的 Chrome 即自动连接';
        document.getElementById('kpi-uptime').textContent = fmtUptime(st.uptimeSec || 0);

        const ul = document.getElementById('logs-ul');
        ul.textContent = '';
        const items = lg.logs || [];
        if (!items.length) {
          const li = document.createElement('li');
          li.className = 'empty';
          li.textContent = '暂无最近指令记录';
          ul.appendChild(li);
        } else {
          for (const item of items.slice(0, 30)) {
            const li = document.createElement('li');
            li.className = 'log-row';
            const left = document.createElement('span');
            left.textContent = (item.status === 'error' ? '! ' : '✓ ') + (item.command || item.event || 'event');
            const right = document.createElement('span');
            right.className = 'log-time';
            const t = item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : '';
            right.textContent = (item.durationMs !== undefined ? item.durationMs + ' ms · ' : '') + t;
            li.appendChild(left);
            li.appendChild(right);
            ul.appendChild(li);
          }
        }
      } catch (_e) {}
    }

    document.getElementById('refresh-btn').addEventListener('click', load);
    load();
    setInterval(load, 2500);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const urlObj = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && urlObj.pathname === '/icon.png') {
    if (fs.existsSync(ICON_128_PATH)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      return res.end(fs.readFileSync(ICON_128_PATH));
    }
  }

  if (req.method === 'GET' && urlObj.pathname === '/' && (req.headers.accept || '').includes('text/html')) {
    const html = renderDashboardHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'GET' && (urlObj.pathname === '/' || urlObj.pathname === '/status' || urlObj.pathname === '/health')) {
    const activeExt = getActiveClient();
    const cdpEndpoint = getDevToolsActivePortEndpoint();
    return sendJson(res, 200, {
      ok: true,
      service: 'antigravity-chrome-bridge',
      port: PORT,
      connected: Boolean(activeExt || cdpEndpoint),
      mode: activeExt ? 'extension-websocket' : cdpEndpoint ? 'remote-debugging-cdp' : 'disconnected',
      remoteDebuggingEndpoint: cdpEndpoint,
      extensionClientCount: clients.size,
      clients: Array.from(clients).map(c => ({
        id: c.id,
        version: c.version,
        tabCount: c.tabCount,
        connectedAt: c.connectedAt,
        lastSeen: new Date(c.lastSeen).toISOString()
      })),
      uptimeSec: Math.round(process.uptime())
    });
  }

  if (req.method === 'GET' && urlObj.pathname === '/logs') {
    return sendJson(res, 200, {
      ok: true,
      count: recentHistory.length,
      logs: recentHistory
    });
  }

  if (req.method === 'POST' && urlObj.pathname === '/command') {
    try {
      const body = await readJsonBody(req);
      const { command, params = {}, timeoutMs = 25000 } = body;
      if (!command) {
        return sendJson(res, 400, { ok: false, error: 'Missing "command" field in request body.' });
      }

      const start = Date.now();
      const data = await dispatchCommand(command, params, timeoutMs);

      if (command === 'screenshot' && params.savePath && data?.dataUrl) {
        const base64Prefix = 'data:image/png;base64,';
        const b64 = data.dataUrl.startsWith(base64Prefix)
          ? data.dataUrl.slice(base64Prefix.length)
          : data.dataUrl;
        const absPath = path.resolve(params.savePath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, Buffer.from(b64, 'base64'));
        data.savedPath = absPath;
        delete data.dataUrl;
      }

      recordHistory({
        command,
        status: 'ok',
        durationMs: Date.now() - start
      });

      return sendJson(res, 200, { ok: true, data });
    } catch (err) {
      recordHistory({
        command: 'error',
        status: 'error',
        error: err.message
      });
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: `Route not found: ${req.method} ${urlObj.pathname}` });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');

  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n');

  socket.write(responseHeaders);
  socket.setNoDelay(true);

  const clientInfo = {
    id: crypto.randomUUID().slice(0, 8),
    socket,
    version: '1.0.0',
    tabCount: 0,
    connectedAt: new Date().toISOString(),
    lastSeen: Date.now()
  };
  clients.add(clientInfo);

  let closed = false;
  function handleClose() {
    if (closed) return;
    closed = true;
    clients.delete(clientInfo);
  }

  attachWsParser(
    socket,
    rawText => {
      clientInfo.lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(rawText);
      } catch (_err) {
        return;
      }

      if (msg.type === 'hello') {
        clientInfo.version = msg.version || '1.0.0';
        clientInfo.tabCount = msg.tabCount || 0;
        recordHistory({ event: 'extension_connected', clientId: clientInfo.id, tabCount: clientInfo.tabCount });
        return;
      }

      if (msg.type === 'heartbeat') {
        sendWsText(socket, JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }

      if (msg.type === 'event') {
        recordHistory({ event: msg.event, data: msg.data });
        return;
      }

      if (msg.type === 'response' && msg.id) {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.id);
          if (msg.ok) {
            pending.resolve(msg.data);
          } else {
            pending.reject(new Error(msg.error || 'Extension command failed'));
          }
        }
      }
    },
    handleClose,
    false
  );
});

setInterval(() => {
  for (const client of clients) {
    if (!client.socket.destroyed && client.socket.writable) {
      sendWsText(client.socket, JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    }
  }
}, 20000).unref();

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[Antigravity Bridge] Port ${PORT} is already active.`);
    process.exit(0);
  }
  console.error('[Antigravity Bridge] Server error:', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[Antigravity Bridge] Listening on http://${HOST}:${PORT} (WebSocket: ws://${HOST}:${PORT}/ws)`);
});
