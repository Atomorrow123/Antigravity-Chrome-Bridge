#!/usr/bin/env node
/**
 * Automated Installer & Launcher for Antigravity Chrome Bridge Extension
 * 1. Ensures the local Bridge Server (127.0.0.1:18765) is running.
 * 2. Launches Chrome with a persistent profile + `--enable-unsafe-extension-debugging` and installs
 *    the unpacked extension automatically via CDP `Extensions.loadUnpacked`.
 * 3. Also optionally opens `chrome://extensions` in the user's default Chrome browser and copies
 *    the extension path to the clipboard for one-click loading into an already-open default profile.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT_DIR, 'extension');
const PROFILE_DIR = path.join(ROOT_DIR, 'chrome-profile');
const SERVER_SCRIPT = path.join(ROOT_DIR, 'server', 'bridge-server.js');
function resolveChromeExecutable() {
  if (process.env.CHROME_EXE && fs.existsSync(process.env.CHROME_EXE)) {
    return process.env.CHROME_EXE;
  }
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return candidates[0];
}
const CHROME_EXE = resolveChromeExecutable();
const DEBUG_PORT = 9333;

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP GET timeout')));
  });
}

// Minimal RFC 6455 WebSocket Client for talking to Chrome's browser CDP endpoint
function cdpSendBrowserCommand(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');

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
      const msgId = 1;
      const payload = Buffer.from(JSON.stringify({ id: msgId, method, params }), 'utf8');
      const mask = crypto.randomBytes(4);
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length;
      } else {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      }
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i & 3];
      }
      socket.write(Buffer.concat([header, mask, masked]));

      let recvBuf = Buffer.alloc(0);
      socket.on('data', chunk => {
        recvBuf = Buffer.concat([recvBuf, chunk]);
        while (recvBuf.length >= 2) {
          const b1 = recvBuf[1];
          let len = b1 & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (recvBuf.length < 4) return;
            len = recvBuf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (recvBuf.length < 10) return;
            len = Number(recvBuf.readBigUInt64BE(2));
            offset = 10;
          }
          if (recvBuf.length < offset + len) return;
          const body = recvBuf.subarray(offset, offset + len).toString('utf8');
          recvBuf = recvBuf.subarray(offset + len);
          try {
            const msg = JSON.parse(body);
            if (msg.id === msgId) {
              socket.end();
              if (msg.error) {
                reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              } else {
                resolve(msg.result);
              }
            }
          } catch (_e) {}
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function spawnPersistentProcess(commandLine, { hidden = false } = {}) {
  const escaped = commandLine.replace(/'/g, "''");
  const psScript = hidden
    ? [
        '$si = New-CimInstance -ClientOnly -ClassName Win32_ProcessStartup -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]8 }',
        `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escaped}'; ProcessStartupInformation = $si } | Out-Null`
      ].join('; ')
    : `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escaped}' } | Out-Null`;
  return new Promise(resolve => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
      { stdio: 'ignore', windowsHide: true }
    );
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

async function ensureBridgeServer() {
  try {
    const status = await httpGetJson('http://127.0.0.1:18765/status', 1200);
    if (status?.ok) return status;
  } catch (_e) {}

  await spawnPersistentProcess(`"${process.execPath}" "${SERVER_SCRIPT}"`, { hidden: true });

  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const status = await httpGetJson('http://127.0.0.1:18765/status', 1000);
      if (status?.ok) return status;
    } catch (_e) {}
  }
  throw new Error('Bridge server failed to start on 127.0.0.1:18765');
}

async function launchAndInstallExtension() {
  console.log('[1/4] Starting local Antigravity Bridge Server on 127.0.0.1:18765...');
  await ensureBridgeServer();

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  let versionInfo = null;
  try {
    versionInfo = await httpGetJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 1000);
  } catch (_e) {
    console.log(`[2/4] Launching Chrome with persistent profile: ${PROFILE_DIR}`);
    const chromeArgs = [
      `"--user-data-dir=${PROFILE_DIR}"`,
      `"--remote-debugging-port=${DEBUG_PORT}"`,
      '--enable-unsafe-extension-debugging',
      `"--load-extension=${EXT_DIR}"`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://example.com'
    ];
    await spawnPersistentProcess(`"${CHROME_EXE}" ${chromeArgs.join(' ')}`);

    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        versionInfo = await httpGetJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 1000);
        if (versionInfo?.webSocketDebuggerUrl) break;
      } catch (_err) {}
    }
  }

  if (!versionInfo?.webSocketDebuggerUrl) {
    throw new Error('Could not connect to Chrome remote debugging port 9333.');
  }

  console.log(`[3/4] Installing unpacked extension via CDP Extensions.loadUnpacked...`);
  try {
    const extRes = await cdpSendBrowserCommand(
      versionInfo.webSocketDebuggerUrl,
      'Extensions.loadUnpacked',
      { path: EXT_DIR }
    );
    console.log(`      Installed Extension ID: ${extRes.id}`);
  } catch (err) {
    console.log(`      Note on Extensions.loadUnpacked: ${err.message}`);
  }

  console.log('[4/4] Waiting for Chrome Extension Service Worker to connect to Bridge Server...');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300));
    const status = await httpGetJson('http://127.0.0.1:18765/status', 1000);
    if (status?.connected) {
      console.log('SUCCESS! Antigravity Chrome Bridge Extension is installed and connected:');
      console.log(JSON.stringify(status, null, 2));
      return;
    }
  }

  const finalStatus = await httpGetJson('http://127.0.0.1:18765/status', 1000);
  console.log('Bridge Status:', JSON.stringify(finalStatus, null, 2));
}

launchAndInstallExtension().catch(err => {
  console.error('Install/Launch Error:', err.message);
  process.exit(1);
});
