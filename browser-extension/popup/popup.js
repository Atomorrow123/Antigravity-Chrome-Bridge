// Antigravity Chrome Bridge — Popup Controller

const statusPill = document.getElementById('status-pill');
const statusText = document.getElementById('status-text');
const wsUrlInput = document.getElementById('ws-url-input');
const reconnectForm = document.getElementById('reconnect-form');
const btnReconnect = document.getElementById('btn-reconnect');
const btnSnapshot = document.getElementById('btn-snapshot');
const btnHighlight = document.getElementById('btn-highlight');
const btnSidepanel = document.getElementById('btn-sidepanel');
const btnClearLogs = document.getElementById('btn-clear-logs');
const snapshotMeta = document.getElementById('snapshot-meta');
const highlightMeta = document.getElementById('highlight-meta');
const logList = document.getElementById('log-list');
const activeTabLabel = document.getElementById('active-tab-label');

function applyConnectionStatus(status) {
  if (status === 'connected') {
    statusPill.dataset.status = 'connected';
    statusText.textContent = '已连接';
  } else if (status === 'connecting') {
    statusPill.dataset.status = 'connecting';
    statusText.textContent = '连接中';
  } else {
    statusPill.dataset.status = 'disconnected';
    statusText.textContent = '待连接';
  }
}

function renderLogs(logs = []) {
  logList.textContent = '';
  if (!logs.length) {
    const empty = document.createElement('li');
    empty.className = 'log-empty';
    empty.textContent = '暂无指令执行记录';
    logList.appendChild(empty);
    return;
  }

  for (const item of logs.slice(0, 20)) {
    const li = document.createElement('li');
    li.className = 'log-item';

    const left = document.createElement('div');
    left.className = 'log-left';

    const badge = document.createElement('span');
    const isOk = item.status === 'ok';
    badge.className = `log-badge ${isOk ? 'log-badge-ok' : 'log-badge-err'}`;
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = isOk ? '✓' : '!';

    const summary = document.createElement('span');
    summary.className = 'log-summary';
    summary.textContent = item.summary || item.command;

    const meta = document.createElement('span');
    meta.className = 'log-meta';
    meta.textContent = `${item.durationMs ?? 0} ms`;

    left.appendChild(badge);
    left.appendChild(summary);
    li.appendChild(left);
    li.appendChild(meta);
    logList.appendChild(li);
  }
}

async function refreshState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'AGY_GET_STATE' });
    if (res && res.ok) {
      if (res.wsUrl && document.activeElement !== wsUrlInput) {
        wsUrlInput.value = res.wsUrl;
      }
      applyConnectionStatus(res.status);
      renderLogs(res.logs || []);
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const shortTitle = (tab.title || '当前标签页').slice(0, 24);
      activeTabLabel.textContent = `Tab #${tab.id} · ${shortTitle}`;
    }
  } catch (err) {
    activeTabLabel.textContent = err?.message || '状态读取异常';
  }
}

reconnectForm.addEventListener('submit', async event => {
  event.preventDefault();
  btnReconnect.disabled = true;
  applyConnectionStatus('connecting');
  try {
    await chrome.runtime.sendMessage({
      type: 'AGY_RECONNECT',
      wsUrl: wsUrlInput.value.trim()
    });
  } finally {
    setTimeout(() => {
      btnReconnect.disabled = false;
      refreshState();
    }, 350);
  }
});

btnSnapshot.addEventListener('click', async () => {
  snapshotMeta.textContent = '正在扫描...';
  const res = await chrome.runtime.sendMessage({
    type: 'AGY_RUN_LOCAL_COMMAND',
    command: 'get_snapshot',
    params: {}
  });
  if (res && res.ok) {
    snapshotMeta.textContent = `${res.data.interactiveCount} 个可交互节点`;
    activeTabLabel.textContent = `已捕获 ${res.data.interactiveCount} 个交互元素`;
  } else {
    snapshotMeta.textContent = '扫描失败';
    activeTabLabel.textContent = res?.error || '当前页面不支持快照';
  }
  await refreshState();
});

btnHighlight.addEventListener('click', async () => {
  highlightMeta.textContent = '正在标记...';
  const res = await chrome.runtime.sendMessage({
    type: 'AGY_RUN_LOCAL_COMMAND',
    command: 'highlight_selector',
    params: { selector: 'a[href], button, input, textarea, select, [role="button"]' }
  });
  if (res && res.ok) {
    highlightMeta.textContent = `已高亮 ${res.data.highlightedCount} 处`;
    activeTabLabel.textContent = `已在页面高亮 ${res.data.highlightedCount} 个控件`;
  } else {
    highlightMeta.textContent = '高亮受限';
    activeTabLabel.textContent = res?.error || '当前页面无法注入高亮';
  }
  await refreshState();
});

// Rule 2: Explicit button in popup to open the Side Panel
btnSidepanel.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  }
});

btnClearLogs.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'AGY_CLEAR_LOGS' });
  await refreshState();
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'AGY_STATUS_UPDATE') {
    applyConnectionStatus(msg.status);
  } else if (msg?.type === 'AGY_LOG_ENTRY') {
    refreshState();
  }
});

refreshState();
