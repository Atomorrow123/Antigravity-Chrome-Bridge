#!/usr/bin/env node
/**
 * Antigravity Chrome Bridge — MCP Stdio Server
 * Exposes Chrome Extension automation capabilities as Model Context Protocol (MCP) tools.
 */

const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.AGY_BRIDGE_PORT || 18765);
const HOST = process.env.AGY_BRIDGE_HOST || '127.0.0.1';
const SERVER_SCRIPT = path.join(__dirname, 'bridge-server.js');

function httpRequest(method, urlPath, bodyObj = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: urlPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': payload.length
            }
          : {},
        timeout: timeoutMs
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(text) });
          } catch (_e) {
            resolve({ statusCode: res.statusCode, body: { raw: text } });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Bridge request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureBridgeDaemon() {
  try {
    const res = await httpRequest('GET', '/status', null, 1200);
    if (res.statusCode === 200 && res.body?.ok) return;
  } catch (_e) {
    // spawn background server
  }
  if (process.platform === 'win32') {
    const cmd = `"${process.execPath}" "${SERVER_SCRIPT}"`.replace(/'/g, "''");
    const psScript = [
      '$si = New-CimInstance -ClientOnly -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]8 }',
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd}'; ProcessStartupInformation = $si } | Out-Null`
    ].join('; ');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
      { stdio: 'ignore', windowsHide: true }
    );
    child.unref();
  } else {
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  }
  await new Promise(r => setTimeout(r, 600));
}

async function callBridge(command, params = {}) {
  await ensureBridgeDaemon();
  const res = await httpRequest('POST', '/command', { command, params }, 30000);
  if (!res.body?.ok) {
    throw new Error(res.body?.error || `Bridge command ${command} failed`);
  }
  return res.body.data;
}

const TOOLS = [
  {
    name: 'chrome_list_tabs',
    description: 'List all open tabs across Chrome windows with their tabId, title, URL, and active state.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'chrome_open_url',
    description: 'Open a URL in a new Chrome tab or navigate an existing tab, waiting until page load completes.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to open (e.g. https://example.com)' },
        tabId: { type: 'number', description: 'Optional existing tabId to navigate instead of opening a new tab' },
        active: { type: 'boolean', description: 'Whether to focus the tab (default true)' }
      },
      required: ['url']
    }
  },
  {
    name: 'chrome_get_snapshot',
    description:
      'Get an interactive snapshot of a Chrome tab: page title, URL, headings, visible text preview, and all interactive elements stamped with [ref=N] IDs for clicking or filling.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Optional tabId (defaults to active tab)' },
        maxElements: { type: 'number', description: 'Maximum interactive elements to return (default 150)' }
      }
    }
  },
  {
    name: 'chrome_click',
    description: 'Click an element on the page by its snapshot ref ID, CSS selector, or visible text.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref number from chrome_get_snapshot (e.g. "1", "2")' },
        selector: { type: 'string', description: 'CSS selector to click' },
        text: { type: 'string', description: 'Visible text or label of the button/link to click' },
        tabId: { type: 'number', description: 'Optional tabId' }
      }
    }
  },
  {
    name: 'chrome_fill',
    description: 'Fill/type text into an input, textarea, select, or contenteditable element, optionally pressing Enter to submit.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'Text to type into the field' },
        ref: { type: 'string', description: 'Element ref number from chrome_get_snapshot' },
        selector: { type: 'string', description: 'CSS selector of the input field' },
        text: { type: 'string', description: 'Placeholder or label text of the input field' },
        submit: { type: 'boolean', description: 'Press Enter / submit form after filling (default false)' },
        tabId: { type: 'number', description: 'Optional tabId' }
      },
      required: ['value']
    }
  },
  {
    name: 'chrome_press_key',
    description: 'Send a keyboard key press (e.g. Enter, Escape, Tab, ArrowDown, Backspace) to the page.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name (e.g. Enter, Escape, Tab, ArrowDown)' },
        tabId: { type: 'number', description: 'Optional tabId' }
      },
      required: ['key']
    }
  },
  {
    name: 'chrome_scroll',
    description: 'Scroll the page up, down, to top, or to bottom.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Pixels to scroll (default 550)' },
        tabId: { type: 'number', description: 'Optional tabId' }
      }
    }
  },
  {
    name: 'chrome_eval_js',
    description: 'Evaluate a JavaScript expression in the page context via Chrome Debugger (supports async/await and bypasses page CSP).',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate' },
        tabId: { type: 'number', description: 'Optional tabId' }
      },
      required: ['expression']
    }
  },
  {
    name: 'chrome_screenshot',
    description: 'Capture a PNG screenshot of the tab and save it to a local file path.',
    inputSchema: {
      type: 'object',
      properties: {
        savePath: { type: 'string', description: 'Absolute file path to save the PNG screenshot' },
        tabId: { type: 'number', description: 'Optional tabId' }
      },
      required: ['savePath']
    }
  },
  {
    name: 'chrome_wait_for',
    description: 'Wait for a CSS selector or visible text to appear on the page.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        text: { type: 'string', description: 'Visible text to wait for' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 10000)' },
        tabId: { type: 'number', description: 'Optional tabId' }
      }
    }
  }
];

function sendJsonRpc(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.method === 'initialize') {
    sendJsonRpc({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'antigravity-chrome-bridge',
          version: '1.0.0'
        }
      }
    });
    return;
  }

  if (msg.method === 'notifications/initialized') {
    return;
  }

  if (msg.method === 'ping') {
    sendJsonRpc({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'tools/list') {
    sendJsonRpc({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: TOOLS }
    });
    return;
  }

  if (msg.method === 'tools/call') {
    const toolName = msg.params?.name;
    const args = msg.params?.arguments || {};

    const commandMap = {
      chrome_list_tabs: 'list_tabs',
      chrome_open_url: 'open_tab',
      chrome_get_snapshot: 'get_snapshot',
      chrome_click: 'click',
      chrome_fill: 'fill',
      chrome_press_key: 'press_key',
      chrome_scroll: 'scroll',
      chrome_eval_js: 'eval_js',
      chrome_screenshot: 'screenshot',
      chrome_wait_for: 'wait_for'
    };

    const bridgeCommand = commandMap[toolName];
    if (!bridgeCommand) {
      sendJsonRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }]
        }
      });
      return;
    }

    try {
      const data = await callBridge(bridgeCommand, args);
      sendJsonRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
        }
      });
    } catch (err) {
      sendJsonRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `Error: ${err.message}` }]
        }
      });
    }
    return;
  }

  if (msg.id !== undefined) {
    sendJsonRpc({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` }
    });
  }
}

ensureBridgeDaemon();

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    handleRpcMessage(parsed);
  } catch (_err) {
    // Ignore malformed lines
  }
});
