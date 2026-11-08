// Antigravity Chrome Bridge — Background Service Worker (Manifest V3)
// Connects Chrome to the local Antigravity Bridge Server over WebSocket (ws://127.0.0.1:18765/ws)

const DEFAULT_WS_URL = 'ws://127.0.0.1:18765/ws';
const ALARM_NAME = 'agy-bridge-keepalive';
const MAX_LOGS = 60;

// Active WebSocket reference for the current Service Worker lifecycle
let activeSocket = null;
let isConnecting = false;

// --- Storage Helpers (Rule 7: Persist all state in chrome.storage) ---

async function getSettings() {
  const data = await chrome.storage.local.get({
    wsUrl: DEFAULT_WS_URL,
    autoConnect: true
  });
  return data;
}

async function setConnectionStatus(status, detail = '') {
  await chrome.storage.session.set({
    connectionStatus: status,
    connectionDetail: detail,
    updatedAt: Date.now()
  });

  if (status === 'connected') {
    await chrome.action.setBadgeText({ text: 'ON' });
    await chrome.action.setBadgeBackgroundColor({ color: '#34C759' });
  } else if (status === 'connecting') {
    await chrome.action.setBadgeText({ text: '...' });
    await chrome.action.setBadgeBackgroundColor({ color: '#007AFF' });
  } else {
    await chrome.action.setBadgeText({ text: 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: '#8E8E93' });
  }

  // Broadcast status update to open popup/sidepanel
  try {
    await chrome.runtime.sendMessage({
      type: 'AGY_STATUS_UPDATE',
      status,
      detail,
      timestamp: Date.now()
    });
  } catch (_err) {
    // No popup or sidepanel listening
  }
}

async function appendLog(entry) {
  const { commandLogs = [] } = await chrome.storage.session.get({ commandLogs: [] });
  const nextItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...entry
  };
  const updated = [nextItem, ...commandLogs].slice(0, MAX_LOGS);
  await chrome.storage.session.set({ commandLogs: updated });

  try {
    await chrome.runtime.sendMessage({
      type: 'AGY_LOG_ENTRY',
      entry: nextItem
    });
  } catch (_err) {
    // No UI open
  }
}

// --- Tab & Content Script Helpers ---

async function resolveTargetTab(tabId) {
  if (tabId !== undefined && tabId !== null) {
    return await chrome.tabs.get(Number(tabId));
  }
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTabs.length > 0 && !activeTabs[0].url?.startsWith('chrome-extension://')) {
    return activeTabs[0];
  }
  const allTabs = await chrome.tabs.query({});
  const webTab = allTabs.find(
    t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://') || t.url.startsWith('file://'))
  );
  if (webTab) return webTab;
  if (activeTabs.length > 0) return activeTabs[0];
  throw new Error('No accessible browser tab found.');
}

async function waitForTabLoad(tabId, timeoutMs = 15000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return tab;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.get(tabId).then(resolve).catch(reject);
    }, timeoutMs);

    function listener(updatedTabId, changeInfo, updatedTab) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(updatedTab);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScriptAndSend(tabId, action, params = {}) {
  const payload = { target: 'agy-content', action, params };
  try {
    const res = await chrome.tabs.sendMessage(tabId, payload);
    if (res && typeof res === 'object') {
      if (!res.ok) throw new Error(res.error || 'Content script returned an error.');
      return res.data;
    }
  } catch (_initialErr) {
    // Inject content script and CSS on demand for pre-existing tabs
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/content.css']
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js']
    });
    const retryRes = await chrome.tabs.sendMessage(tabId, payload);
    if (!retryRes || !retryRes.ok) {
      throw new Error(retryRes?.error || 'Failed to communicate with content script after injection.');
    }
    return retryRes.data;
  }
}

// --- Chrome Debugger (CDP) Helper ---

async function runWithDebugger(tabId, callback) {
  const target = { tabId: Number(tabId) };
  let attachedHere = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attachedHere = true;
  } catch (err) {
    const msg = String(err?.message || err);
    if (!msg.includes('Another debugger is already attached')) {
      throw err;
    }
  }
  try {
    return await callback(target);
  } finally {
    if (attachedHere) {
      try {
        await chrome.debugger.detach(target);
      } catch (_detachErr) {
        // Ignore if already detached
      }
    }
  }
}

// --- Command Dispatcher (Invoked by Bridge Server or Extension UI) ---

async function executeCommand(command, params = {}) {
  const startTime = Date.now();
  try {
    let result;
    switch (command) {
      case 'ping': {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        result = {
          pong: true,
          extensionVersion: chrome.runtime.getManifest().version,
          activeTab: tabs[0]
            ? { id: tabs[0].id, title: tabs[0].title, url: tabs[0].url }
            : null,
          timestamp: Date.now()
        };
        break;
      }

      case 'list_tabs': {
        const tabs = await chrome.tabs.query({});
        const lastFocusedWin = await chrome.windows.getLastFocused().catch(() => null);
        result = {
          focusedWindowId: lastFocusedWin?.id || null,
          count: tabs.length,
          tabs: tabs.map(t => ({
            id: t.id,
            windowId: t.windowId,
            index: t.index,
            title: t.title || '',
            url: t.url || '',
            active: Boolean(t.active),
            pinned: Boolean(t.pinned),
            status: t.status
          }))
        };
        break;
      }

      case 'open_tab':
      case 'navigate': {
        const { url, tabId, active = true, waitUntilComplete = true } = params;
        if (!url) throw new Error('Parameter "url" is required for open_tab / navigate.');

        let targetTab;
        if (tabId !== undefined && tabId !== null) {
          targetTab = await chrome.tabs.update(Number(tabId), { url, active: Boolean(active) });
        } else {
          targetTab = await chrome.tabs.create({ url, active: Boolean(active) });
        }

        if (waitUntilComplete) {
          targetTab = await waitForTabLoad(targetTab.id, params.timeoutMs || 15000);
        }

        result = {
          tabId: targetTab.id,
          windowId: targetTab.windowId,
          title: targetTab.title || '',
          url: targetTab.url || url,
          status: targetTab.status
        };
        break;
      }

      case 'activate_tab': {
        if (params.tabId === undefined) throw new Error('Parameter "tabId" is required.');
        const updatedTab = await chrome.tabs.update(Number(params.tabId), { active: true });
        if (updatedTab.windowId) {
          await chrome.windows.update(updatedTab.windowId, { focused: true });
        }
        result = {
          activated: true,
          tabId: updatedTab.id,
          title: updatedTab.title,
          url: updatedTab.url
        };
        break;
      }

      case 'close_tab': {
        if (params.tabId === undefined) throw new Error('Parameter "tabId" is required.');
        await chrome.tabs.remove(Number(params.tabId));
        result = { closed: true, tabId: Number(params.tabId) };
        break;
      }

      case 'reload_tab': {
        const tab = await resolveTargetTab(params.tabId);
        await chrome.tabs.reload(tab.id, { bypassCache: Boolean(params.bypassCache) });
        const loaded = await waitForTabLoad(tab.id, params.timeoutMs || 15000);
        result = { reloaded: true, tabId: loaded.id, title: loaded.title, url: loaded.url };
        break;
      }

      case 'go_back': {
        const tab = await resolveTargetTab(params.tabId);
        await chrome.tabs.goBack(tab.id);
        const loaded = await waitForTabLoad(tab.id, 10000);
        result = { navigatedBack: true, tabId: loaded.id, title: loaded.title, url: loaded.url };
        break;
      }

      case 'go_forward': {
        const tab = await resolveTargetTab(params.tabId);
        await chrome.tabs.goForward(tab.id);
        const loaded = await waitForTabLoad(tab.id, 10000);
        result = { navigatedForward: true, tabId: loaded.id, title: loaded.title, url: loaded.url };
        break;
      }

      case 'get_snapshot':
      case 'snapshot': {
        const tab = await resolveTargetTab(params.tabId);
        const snap = await ensureContentScriptAndSend(tab.id, 'snapshot', params);
        result = {
          tabId: tab.id,
          ...snap
        };
        break;
      }

      case 'click': {
        const tab = await resolveTargetTab(params.tabId);
        const clickRes = await ensureContentScriptAndSend(tab.id, 'click', params);
        result = { tabId: tab.id, ...clickRes };
        break;
      }

      case 'fill':
      case 'type': {
        const tab = await resolveTargetTab(params.tabId);
        const fillRes = await ensureContentScriptAndSend(tab.id, 'fill', params);
        result = { tabId: tab.id, ...fillRes };
        break;
      }

      case 'press_key': {
        const tab = await resolveTargetTab(params.tabId);
        const keyRes = await ensureContentScriptAndSend(tab.id, 'press_key', params);
        result = { tabId: tab.id, ...keyRes };
        break;
      }

      case 'scroll': {
        const tab = await resolveTargetTab(params.tabId);
        const scrollRes = await ensureContentScriptAndSend(tab.id, 'scroll', params);
        result = { tabId: tab.id, ...scrollRes };
        break;
      }

      case 'wait_for': {
        const tab = await resolveTargetTab(params.tabId);
        const waitRes = await ensureContentScriptAndSend(tab.id, 'wait_for', params);
        result = { tabId: tab.id, ...waitRes };
        break;
      }

      case 'extract': {
        const tab = await resolveTargetTab(params.tabId);
        const extractRes = await ensureContentScriptAndSend(tab.id, 'extract', params);
        result = { tabId: tab.id, ...extractRes };
        break;
      }

      case 'highlight_selector': {
        const tab = await resolveTargetTab(params.tabId);
        const hlRes = await ensureContentScriptAndSend(tab.id, 'highlight_selector', params);
        result = { tabId: tab.id, ...hlRes };
        break;
      }

      case 'eval_js': {
        const tab = await resolveTargetTab(params.tabId);
        const expression = params.expression || params.code;
        if (!expression) throw new Error('Parameter "expression" is required for eval_js.');

        // Execute via Chrome Debugger Runtime.evaluate so page CSP never blocks dynamic expressions
        const evalOutput = await runWithDebugger(tab.id, async target => {
          const cdpRes = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
            expression: String(expression),
            returnByValue: true,
            awaitPromise: true,
            userGesture: true
          });
          if (cdpRes.exceptionDetails) {
            throw new Error(
              cdpRes.exceptionDetails.exception?.description ||
                cdpRes.exceptionDetails.text ||
                'JS evaluation exception'
            );
          }
          return cdpRes.result?.value;
        });

        result = {
          tabId: tab.id,
          url: tab.url,
          value: evalOutput
        };
        break;
      }

      case 'screenshot': {
        const tab = await resolveTargetTab(params.tabId);
        let dataUrl = null;
        try {
          if (tab.active) {
            dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          }
        } catch (_captureErr) {
          dataUrl = null;
        }

        if (!dataUrl) {
          // Fallback to CDP Page.captureScreenshot for background or unfocused tabs
          const base64Data = await runWithDebugger(tab.id, async target => {
            const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
              format: 'png'
            });
            return shot.data;
          });
          dataUrl = `data:image/png;base64,${base64Data}`;
        }

        result = {
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          dataUrl
        };
        break;
      }

      case 'cdp': {
        const tab = await resolveTargetTab(params.tabId);
        if (!params.method) throw new Error('Parameter "method" is required for cdp command.');
        const cdpResponse = await runWithDebugger(tab.id, async target => {
          return await chrome.debugger.sendCommand(target, params.method, params.commandParams || {});
        });
        result = {
          tabId: tab.id,
          method: params.method,
          response: cdpResponse
        };
        break;
      }

      case 'get_cookies': {
        const tab = await resolveTargetTab(params.tabId);
        const targetUrl = params.url || tab.url;
        const cookies = await chrome.cookies.getAll({ url: targetUrl });
        result = { url: targetUrl, count: cookies.length, cookies };
        break;
      }

      case 'download': {
        if (!params.url) throw new Error('Parameter "url" is required for download.');
        const downloadId = await chrome.downloads.download({
          url: params.url,
          filename: params.filename || undefined,
          saveAs: Boolean(params.saveAs)
        });
        result = { downloadId, url: params.url };
        break;
      }

      default:
        throw new Error(`Unsupported bridge command: ${command}`);
    }

    await appendLog({
      command,
      status: 'ok',
      durationMs: Date.now() - startTime,
      summary: summarizeCommand(command, params)
    });

    return result;
  } catch (err) {
    const errorMsg = err?.message || String(err);
    await appendLog({
      command,
      status: 'error',
      durationMs: Date.now() - startTime,
      summary: `${summarizeCommand(command, params)} -> ${errorMsg}`
    });
    throw err;
  }
}

function summarizeCommand(command, params = {}) {
  if (command === 'open_tab' || command === 'navigate') return `${command}(${params.url || ''})`;
  if (command === 'click') return `click(${params.ref || params.selector || params.text || ''})`;
  if (command === 'fill' || command === 'type') {
    return `${command}(${params.ref || params.selector || ''} = "${String(params.value || '').slice(0, 20)}")`;
  }
  if (command === 'eval_js') return `eval_js(${String(params.expression || params.code || '').slice(0, 32)})`;
  return command;
}

// --- WebSocket Connection to Local Antigravity Bridge Server ---

async function connectWebSocket(force = false) {
  if (activeSocket && (activeSocket.readyState === WebSocket.OPEN || activeSocket.readyState === WebSocket.CONNECTING)) {
    if (!force) return;
    try {
      activeSocket.close();
    } catch (_e) {
      // Ignore
    }
    activeSocket = null;
  }

  if (isConnecting && !force) return;

  const { wsUrl, autoConnect } = await getSettings();
  if (!autoConnect && !force) {
    await setConnectionStatus('disconnected', 'Auto-connect paused');
    return;
  }

  isConnecting = true;
  await setConnectionStatus('connecting', wsUrl);

  try {
    const socket = new WebSocket(wsUrl);
    activeSocket = socket;

    socket.addEventListener('open', async () => {
      isConnecting = false;
      await setConnectionStatus('connected', wsUrl);
      const tabs = await chrome.tabs.query({});
      socket.send(
        JSON.stringify({
          type: 'hello',
          client: 'antigravity-chrome-extension',
          version: chrome.runtime.getManifest().version,
          tabCount: tabs.length,
          timestamp: Date.now()
        })
      );
    });

    socket.addEventListener('message', async event => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch (_err) {
        return;
      }

      if (msg.type === 'ping') {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
        return;
      }

      if (msg.type === 'request' && msg.id && msg.command) {
        try {
          const data = await executeCommand(msg.command, msg.params || {});
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                type: 'response',
                id: msg.id,
                ok: true,
                data
              })
            );
          }
        } catch (err) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(
              JSON.stringify({
                type: 'response',
                id: msg.id,
                ok: false,
                error: err?.message || String(err)
              })
            );
          }
        }
      }
    });

    socket.addEventListener('close', async () => {
      isConnecting = false;
      if (activeSocket === socket) {
        activeSocket = null;
      }
      await setConnectionStatus('disconnected', 'Waiting for local bridge server...');
    });

    socket.addEventListener('error', async () => {
      isConnecting = false;
    });
  } catch (err) {
    isConnecting = false;
    await setConnectionStatus('disconnected', err?.message || 'Connection failed');
  }
}

// --- Top-Level Synchronous Event Registration (Mandatory Rule #7) ---

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      wsUrl: DEFAULT_WS_URL,
      autoConnect: true
    });
  }

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'agy-open-sidepanel',
      title: '打开 Antigravity 操控侧边栏 (Side Panel)',
      contexts: ['all']
    });
    chrome.contextMenus.create({
      id: 'agy-send-snapshot',
      title: '发送当前网页快照给 Antigravity',
      contexts: ['page', 'selection']
    });
  });

  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  await connectWebSocket(true);
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  await connectWebSocket(true);
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === ALARM_NAME) {
    if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
      await connectWebSocket(false);
    } else {
      try {
        activeSocket.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
      } catch (_err) {
        await connectWebSocket(true);
      }
    }
  }
});

// Rule 9: Context menus must show user feedback after action
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'agy-open-sidepanel' && tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    if (tab.id) {
      await ensureContentScriptAndSend(tab.id, 'toast', {
        message: 'Antigravity Side Panel opened'
      }).catch(() => {});
    }
  } else if (info.menuItemId === 'agy-send-snapshot' && tab?.id) {
    try {
      const snap = await executeCommand('get_snapshot', { tabId: tab.id });
      if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
        activeSocket.send(
          JSON.stringify({
            type: 'event',
            event: 'user_snapshot',
            data: snap
          })
        );
      }
      await ensureContentScriptAndSend(tab.id, 'toast', {
        message: `已捕获页面快照 (${snap.interactiveCount} 个可交互元素)`
      });
    } catch (err) {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: 'Antigravity Chrome Bridge',
        message: `无法在此页面捕获快照: ${err?.message || err}`
      });
    }
  }
});

// Wake up / reconnect when tabs change
chrome.tabs.onActivated.addListener(async () => {
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
    await connectWebSocket(false);
  }
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
      await connectWebSocket(false);
    }
  }
});

// Handle messages from Popup and Side Panel (Rule 5: return true for async sendResponse)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  (async () => {
    try {
      switch (message.type) {
        case 'AGY_GET_STATE': {
          const settings = await getSettings();
          const session = await chrome.storage.session.get({
            connectionStatus: activeSocket?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
            connectionDetail: settings.wsUrl,
            commandLogs: []
          });
          const isOpen = activeSocket && activeSocket.readyState === WebSocket.OPEN;
          sendResponse({
            ok: true,
            wsUrl: settings.wsUrl,
            autoConnect: settings.autoConnect,
            status: isOpen ? 'connected' : session.connectionStatus,
            detail: session.connectionDetail,
            logs: session.commandLogs
          });
          break;
        }

        case 'AGY_RECONNECT': {
          if (message.wsUrl) {
            await chrome.storage.local.set({ wsUrl: message.wsUrl, autoConnect: true });
          }
          await connectWebSocket(true);
          sendResponse({ ok: true });
          break;
        }

        case 'AGY_RUN_LOCAL_COMMAND': {
          const data = await executeCommand(message.command, message.params || {});
          sendResponse({ ok: true, data });
          break;
        }

        case 'AGY_CLEAR_LOGS': {
          await chrome.storage.session.set({ commandLogs: [] });
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});

// Initial kick-off when service worker boots
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
connectWebSocket(false);
