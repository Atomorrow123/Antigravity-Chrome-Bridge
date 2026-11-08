#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const portFile = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
if (!fs.existsSync(portFile)) {
  console.error('DevToolsActivePort not found at:', portFile);
  process.exit(1);
}

const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
const wsUrl = `ws://127.0.0.1:${lines[0]}${lines[1]}`;
console.log('Found DevToolsActivePort endpoint:', wsUrl);

const parsed = new URL(wsUrl);
const key = crypto.randomBytes(16).toString('base64');

const req = http.request({
  hostname: parsed.hostname,
  port: parsed.port,
  path: parsed.pathname,
  method: 'GET',
  headers: {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Key': key,
    'Sec-WebSocket-Version': '13'
  }
});

function sendWsMessage(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
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
}

req.on('upgrade', (_res, socket) => {
  console.log('WebSocket connected! Requesting Browser.getVersion and Target.getTargets...');
  sendWsMessage(socket, { id: 1, method: 'Browser.getVersion', params: {} });
  sendWsMessage(socket, { id: 2, method: 'Target.getTargets', params: {} });

  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length < offset + len) return;
      const msgStr = buf.subarray(offset, offset + len).toString('utf8');
      buf = buf.subarray(offset + len);
      try {
        const msg = JSON.parse(msgStr);
        if (msg.id === 1) {
          console.log('Browser.getVersion:', JSON.stringify(msg.result, null, 2));
        } else if (msg.id === 2) {
          const pages = (msg.result?.targetInfos || []).filter(t => t.type === 'page');
          console.log(`Open Pages in Main Chrome (${pages.length}):`);
          for (const p of pages) {
            console.log(`  - [${p.targetId}] ${p.title} (${p.url})`);
          }
          socket.end();
          process.exit(0);
        } else {
          console.log('CDP Message:', msgStr);
        }
      } catch (_e) {}
    }
  });
});

req.on('error', err => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

req.end();

setTimeout(() => {
  console.log('Timed out waiting for response (check if Chrome is showing an approval prompt).');
  process.exit(2);
}, 12000);
