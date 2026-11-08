#!/usr/bin/env node
/**
 * Antigravity Chrome Bridge CLI (`agy-chrome.js`)
 * Allows Antigravity or any script to control Chrome directly from the command line.
 * Automatically starts the background bridge server on 127.0.0.1:18765 if not already running.
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.AGY_BRIDGE_PORT || 18765);
const HOST = process.env.AGY_BRIDGE_HOST || '127.0.0.1';
const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'bridge-server.js');

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
    req.on('timeout', () => {
      req.destroy(new Error('HTTP request to bridge server timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function spawnDetachedWindows(commandLine) {
  if (process.platform === 'win32') {
    const escaped = commandLine.replace(/'/g, "''");
    const psScript = [
      '$si = New-CimInstance -ClientOnly -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]8 }',
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escaped}'; ProcessStartupInformation = $si } | Out-Null`
    ].join('; ');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
      { stdio: 'ignore', windowsHide: true }
    );
    child.unref();
  } else {
    const child = spawn('/bin/sh', ['-c', `${commandLine} >/dev/null 2>&1 &`], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  }
}

async function ensureBridgeServer() {
  try {
    const res = await httpRequest('GET', '/status', null, 1500);
    if (res.statusCode === 200 && res.body?.ok) {
      return res.body;
    }
  } catch (_err) {
    // Server not running; spawn persistent background daemon
  }

  spawnDetachedWindows(`"${process.execPath}" "${SERVER_SCRIPT}"`);

  const start = Date.now();
  while (Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const res = await httpRequest('GET', '/status', null, 1000);
      if (res.statusCode === 200 && res.body?.ok) {
        return res.body;
      }
    } catch (_e) {
      // keep polling
    }
  }
  throw new Error('Failed to start local bridge server on 127.0.0.1:18765');
}

async function sendCommand(command, params = {}, timeoutMs = 25000) {
  await ensureBridgeServer();
  const res = await httpRequest(
    'POST',
    '/command',
    { command, params, timeoutMs },
    timeoutMs + 3000
  );
  if (!res.body?.ok) {
    throw new Error(res.body?.error || `Bridge returned HTTP ${res.statusCode}`);
  }
  return res.body.data;
}

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function printSnapshot(snap, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(snap, null, 2));
    return;
  }
  console.log(`=== Page Snapshot (Tab #${snap.tabId}) ===`);
  console.log(`Title   : ${snap.title}`);
  console.log(`URL     : ${snap.url}`);
  console.log(
    `Viewport: ${snap.viewport?.width}x${snap.viewport?.height} (scrollY=${snap.viewport?.scrollY}/${snap.viewport?.scrollHeight})`
  );
  if (snap.headings?.length) {
    console.log(`\n--- Headings ---`);
    for (const h of snap.headings) {
      console.log(`  [${h.level}] ${h.text}`);
    }
  }
  console.log(`\n--- Interactive Elements (${snap.interactiveCount}) ---`);
  for (const el of snap.interactiveElements || []) {
    const parts = [`[ref=${el.ref}]`, `<${el.tag}${el.type ? ` type="${el.type}"` : ''}>`];
    if (el.label) parts.push(`"${el.label}"`);
    if (el.placeholder && el.placeholder !== el.label) parts.push(`placeholder="${el.placeholder}"`);
    if (el.value) parts.push(`value="${el.value}"`);
    if (el.href) parts.push(`-> ${el.href.slice(0, 80)}`);
    console.log(`  ${parts.join(' ')}`);
  }
  if (snap.textPreview) {
    console.log(`\n--- Visible Text Preview ---`);
    console.log(snap.textPreview.slice(0, 2500));
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const subcommand = (rawArgs[0] || 'help').toLowerCase();
  const { positional, flags } = parseFlags(rawArgs.slice(1));
  const tabId = flags.tab !== undefined ? Number(flags.tab) : undefined;

  try {
    switch (subcommand) {
      case 'start-server': {
        const status = await ensureBridgeServer();
        console.log(JSON.stringify(status, null, 2));
        break;
      }

      case 'status': {
        const status = await ensureBridgeServer();
        console.log(JSON.stringify(status, null, 2));
        break;
      }

      case 'ping': {
        const res = await sendCommand('ping');
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'tabs':
      case 'list-tabs': {
        const res = await sendCommand('list_tabs');
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`Open Tabs (${res.count}):`);
          for (const t of res.tabs) {
            console.log(`  [${t.active ? '*' : ' '}Tab #${t.id}] ${t.title} — ${t.url}`);
          }
        }
        break;
      }

      case 'open':
      case 'navigate': {
        const rawUrl = positional[0];
        if (!rawUrl) throw new Error('Usage: agy-chrome open <url> [--tab <id>]');
        const url = /^[a-zA-Z]+:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
        const res = await sendCommand('open_tab', {
          url,
          tabId,
          active: flags.background ? false : true,
          waitUntilComplete: flags.nowait ? false : true
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'activate': {
        const id = positional[0] || tabId;
        if (id === undefined) throw new Error('Usage: agy-chrome activate <tabId>');
        const res = await sendCommand('activate_tab', { tabId: Number(id) });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'close': {
        const id = positional[0] || tabId;
        if (id === undefined) throw new Error('Usage: agy-chrome close <tabId>');
        const res = await sendCommand('close_tab', { tabId: Number(id) });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'reload': {
        const res = await sendCommand('reload_tab', { tabId });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'back': {
        const res = await sendCommand('go_back', { tabId });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'forward': {
        const res = await sendCommand('go_forward', { tabId });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'snapshot':
      case 'snap': {
        const res = await sendCommand('get_snapshot', {
          tabId,
          maxElements: flags.max ? Number(flags.max) : 150
        });
        printSnapshot(res, Boolean(flags.json));
        break;
      }

      case 'click': {
        const target = positional[0];
        if (!target) throw new Error('Usage: agy-chrome click <ref|selector|text> [--tab <id>]');
        const params = { tabId };
        if (/^\d+$/.test(target) || /^ref=\d+$/i.test(target)) {
          params.ref = target.replace(/^ref=/i, '');
        } else {
          params.selector = target;
          params.text = target;
        }
        const res = await sendCommand('click', params);
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'fill':
      case 'type': {
        const target = positional[0];
        const value = positional.slice(1).join(' ');
        if (!target) throw new Error('Usage: agy-chrome fill <ref|selector|text> <value> [--submit] [--tab <id>]');
        const params = {
          tabId,
          value,
          clear: flags.append ? false : true,
          submit: Boolean(flags.submit || flags.enter)
        };
        if (/^\d+$/.test(target) || /^ref=\d+$/i.test(target)) {
          params.ref = target.replace(/^ref=/i, '');
        } else {
          params.selector = target;
          params.text = target;
        }
        const res = await sendCommand('fill', params);
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'press': {
        const key = positional[0] || 'Enter';
        const res = await sendCommand('press_key', {
          tabId,
          key,
          selector: flags.selector,
          ref: flags.ref
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'scroll': {
        const direction = positional[0] || 'down';
        const amount = positional[1] ? Number(positional[1]) : 550;
        const res = await sendCommand('scroll', {
          tabId,
          direction,
          amount,
          selector: flags.selector
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'wait': {
        const target = positional[0];
        if (!target) throw new Error('Usage: agy-chrome wait <selector|text> [--timeout 10000]');
        const res = await sendCommand('wait_for', {
          tabId,
          selector: flags.text ? undefined : target,
          text: flags.selector ? undefined : target,
          timeoutMs: flags.timeout ? Number(flags.timeout) : 10000
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'extract': {
        const mode = positional[0] || 'summary';
        const res = await sendCommand('extract', {
          tabId,
          mode,
          selector: flags.selector
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'eval': {
        const expression = positional.join(' ');
        if (!expression) throw new Error('Usage: agy-chrome eval "<javascript_expression>" [--tab <id>]');
        const res = await sendCommand('eval_js', { tabId, expression });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'screenshot': {
        const outFile =
          positional[0] ||
          path.join(process.cwd(), `chrome-screenshot-${Date.now()}.png`);
        const absOut = path.resolve(outFile);
        const res = await sendCommand('screenshot', {
          tabId,
          savePath: absOut
        });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'cdp': {
        const method = positional[0];
        const rawJson = positional[1] || '{}';
        if (!method) throw new Error('Usage: agy-chrome cdp <Method> [jsonParams] [--tab <id>]');
        const commandParams = JSON.parse(rawJson);
        const res = await sendCommand('cdp', { tabId, method, commandParams });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      default: {
        console.log(`Antigravity Chrome Bridge CLI
Usage:
  node agy-chrome.js status                              Check bridge & extension connection status
  node agy-chrome.js tabs                                List all open Chrome tabs
  node agy-chrome.js open <url> [--tab <id>]             Open URL in a new or specified tab
  node agy-chrome.js activate <tabId>                    Bring tab & window to front
  node agy-chrome.js close <tabId>                       Close specified tab
  node agy-chrome.js snapshot [--tab <id>] [--json]      Get interactive elements (with [ref=N]) & text
  node agy-chrome.js click <ref|selector|text>           Click element by ref number, CSS selector, or text
  node agy-chrome.js fill <ref|selector> "<val>" [--submit]  Fill input/textarea and optionally submit
  node agy-chrome.js press <Key>                         Press keyboard key (Enter, Escape, Tab, ArrowDown...)
  node agy-chrome.js scroll <down|up|top|bottom> [px]    Scroll page
  node agy-chrome.js wait <selector|text>                Wait for element or text to appear
  node agy-chrome.js extract <links|tables|html>         Extract structured data from page
  node agy-chrome.js eval "<js_expression>"              Evaluate JS in page via Chrome Debugger (bypasses CSP)
  node agy-chrome.js screenshot [output.png]             Capture PNG screenshot of tab
  node agy-chrome.js cdp <Method> [jsonParams]           Send raw Chrome DevTools Protocol command`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
