// Antigravity Chrome Bridge — Side Panel Controller

const statusPill = document.getElementById('sp-status-pill');
const statusText = document.getElementById('sp-status-text');
const tabTitle = document.getElementById('sp-tab-title');
const tabUrl = document.getElementById('sp-tab-url');
const btnRefresh = document.getElementById('sp-btn-refresh');
const btnHighlight = document.getElementById('sp-btn-highlight');
const btnReconnect = document.getElementById('sp-btn-reconnect');
const cmdForm = document.getElementById('sp-cmd-form');
const cmdRadios = Array.from(document.querySelectorAll('input[name="command"]'));
const targetLabel = document.getElementById('sp-target-label');
const targetInput = document.getElementById('sp-target-input');
const valueGroup = document.getElementById('sp-value-group');
const valueInput = document.getElementById('sp-value-input');
const btnExec = document.getElementById('sp-btn-exec');
const resultCode = document.getElementById('sp-result-code');
const elCount = document.getElementById('sp-el-count');
const elFilter = document.getElementById('sp-el-filter');
const elList = document.getElementById('sp-el-list');
const logList = document.getElementById('sp-log-list');
const btnClear = document.getElementById('sp-btn-clear');

let cachedElements = [];

function getSelectedCommand() {
  const checked = cmdRadios.find(r => r.checked);
  return checked ? checked.value : 'click';
}

function syncCommandFormFields() {
  const cmd = getSelectedCommand();
  if (cmd === 'click') {
    targetLabel.textContent = '目标元素 (ref 编号 / CSS 选择器 / 文本)';
    targetInput.placeholder = '例如：1 或 #search-btn 或 登录';
    valueGroup.hidden = true;
  } else if (cmd === 'fill') {
    targetLabel.textContent = '目标输入框 (ref 编号 / CSS 选择器 / 占位符)';
    targetInput.placeholder = '例如：2 或 input[name="q"]';
    valueGroup.hidden = false;
  } else if (cmd === 'open_tab') {
    targetLabel.textContent = '目标网址 (URL)';
    targetInput.placeholder = '例如：https://www.apple.com.cn';
    valueGroup.hidden = true;
  } else if (cmd === 'eval_js') {
    targetLabel.textContent = 'JavaScript 表达式 (通过 CDP 执行)';
    targetInput.placeholder = '例如：document.title';
    valueGroup.hidden = true;
  }
}

for (const radio of cmdRadios) {
  radio.addEventListener('change', syncCommandFormFields);
}

function updateStatusUI(status) {
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

function renderElements(elements = [], query = '') {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? elements.filter(el => {
        const hay = `#${el.ref} ${el.tag} ${el.label || ''} ${el.placeholder || ''} ${el.selector || ''}`.toLowerCase();
        return hay.includes(q);
      })
    : elements;

  elCount.textContent = String(filtered.length);
  elList.textContent = '';

  if (!filtered.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-hint';
    empty.textContent = elements.length
      ? '没有匹配筛选条件的节点'
      : '当前页面未扫描到可交互元素';
    elList.appendChild(empty);
    return;
  }

  for (const el of filtered.slice(0, 90)) {
    const li = document.createElement('li');
    li.className = 'el-item';

    const left = document.createElement('div');
    left.className = 'el-desc';

    const refBadge = document.createElement('span');
    refBadge.className = 'el-ref';
    refBadge.textContent = `#${el.ref}`;

    const tagSpan = document.createElement('span');
    tagSpan.className = 'el-tag';
    tagSpan.textContent = el.tag;

    const text = document.createElement('span');
    text.className = 'el-text';
    text.textContent = el.label || el.placeholder || el.selector || '';

    left.appendChild(refBadge);
    left.appendChild(tagSpan);
    left.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'el-actions';

    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'btn-mini';
    pickBtn.textContent = '填入';
    pickBtn.setAttribute('aria-label', `填入节点 #${el.ref}`);
    pickBtn.addEventListener('click', () => {
      targetInput.value = String(el.ref);
      targetInput.focus();
    });

    const clickBtn = document.createElement('button');
    clickBtn.type = 'button';
    clickBtn.className = 'btn-mini';
    clickBtn.textContent = '点击';
    clickBtn.setAttribute('aria-label', `直接点击节点 #${el.ref}`);
    clickBtn.addEventListener('click', async () => {
      resultCode.textContent = `// 正在点击 #${el.ref}...`;
      const res = await chrome.runtime.sendMessage({
        type: 'AGY_RUN_LOCAL_COMMAND',
        command: 'click',
        params: { ref: String(el.ref) }
      });
      resultCode.textContent = res?.ok
        ? JSON.stringify(res.data, null, 2)
        : `Error: ${res?.error || '点击失败'}`;
      await syncState();
    });

    actions.appendChild(pickBtn);
    actions.appendChild(clickBtn);
    li.appendChild(left);
    li.appendChild(actions);
    elList.appendChild(li);
  }
}

function renderLogs(logs = []) {
  logList.textContent = '';
  if (!logs.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-hint';
    empty.textContent = '等待 Antigravity 下发操控指令...';
    logList.appendChild(empty);
    return;
  }

  for (const item of logs.slice(0, 30)) {
    const li = document.createElement('li');
    li.className = 'log-item';

    const left = document.createElement('div');
    left.className = 'el-desc';

    const badge = document.createElement('span');
    const isOk = item.status === 'ok';
    badge.className = `log-badge ${isOk ? 'log-badge-ok' : 'log-badge-err'}`;
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = isOk ? '✓' : '!';

    const summary = document.createElement('span');
    summary.className = 'log-summary';
    summary.textContent = item.summary || item.command;

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = `${item.durationMs ?? 0} ms`;

    left.appendChild(badge);
    left.appendChild(summary);
    li.appendChild(left);
    li.appendChild(time);
    logList.appendChild(li);
  }
}

async function syncState() {
  const res = await chrome.runtime.sendMessage({ type: 'AGY_GET_STATE' });
  if (res && res.ok) {
    updateStatusUI(res.status);
    renderLogs(res.logs || []);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    tabTitle.textContent = tab.title || '未命名标签页';
    tabUrl.textContent = tab.url || '';
  }
}

async function takeSnapshot() {
  resultCode.textContent = '// 正在扫描当前页面快照...';
  const res = await chrome.runtime.sendMessage({
    type: 'AGY_RUN_LOCAL_COMMAND',
    command: 'get_snapshot',
    params: {}
  });
  if (res && res.ok) {
    const snap = res.data;
    tabTitle.textContent = snap.title || tabTitle.textContent;
    tabUrl.textContent = snap.url || tabUrl.textContent;
    cachedElements = snap.interactiveElements || [];
    renderElements(cachedElements, elFilter.value);
    resultCode.textContent = JSON.stringify(
      {
        title: snap.title,
        url: snap.url,
        interactiveCount: snap.interactiveCount,
        headings: snap.headings,
        textPreview: (snap.textPreview || '').slice(0, 400)
      },
      null,
      2
    );
  } else {
    resultCode.textContent = `Error: ${res?.error || '无法读取该页面'}`;
  }
  await syncState();
}

elFilter.addEventListener('input', () => {
  renderElements(cachedElements, elFilter.value);
});

btnRefresh.addEventListener('click', takeSnapshot);

btnHighlight.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'AGY_RUN_LOCAL_COMMAND',
    command: 'highlight_selector',
    params: { selector: 'a[href], button, input, textarea, select, [role="button"]' }
  });
  await syncState();
});

btnReconnect.addEventListener('click', async () => {
  updateStatusUI('connecting');
  await chrome.runtime.sendMessage({ type: 'AGY_RECONNECT' });
  setTimeout(syncState, 350);
});

cmdForm.addEventListener('submit', async event => {
  event.preventDefault();
  const command = getSelectedCommand();
  const target = targetInput.value.trim();
  const value = valueInput.value;

  let params = {};
  if (command === 'click') {
    params = /^\d+$/.test(target) ? { ref: target } : { selector: target, text: target };
  } else if (command === 'fill') {
    params = /^\d+$/.test(target)
      ? { ref: target, value }
      : { selector: target, text: target, value };
  } else if (command === 'open_tab') {
    params = { url: /^https?:\/\//i.test(target) ? target : `https://${target}` };
  } else if (command === 'eval_js') {
    params = { expression: target || value };
  }

  btnExec.disabled = true;
  resultCode.textContent = `// 正在执行 ${command}...`;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'AGY_RUN_LOCAL_COMMAND',
      command,
      params
    });

    if (res && res.ok) {
      resultCode.textContent = JSON.stringify(res.data, null, 2);
    } else {
      resultCode.textContent = `Error: ${res?.error || '执行失败'}`;
    }
  } finally {
    btnExec.disabled = false;
  }
  await syncState();
});

// IME-safe Enter submit for inputs inside form
for (const inputEl of [targetInput, valueInput]) {
  inputEl.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.isComposing) {
      event.preventDefault();
    }
  });
}

btnClear.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'AGY_CLEAR_LOGS' });
  await syncState();
});

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'AGY_STATUS_UPDATE') {
    updateStatusUI(msg.status);
  } else if (msg?.type === 'AGY_LOG_ENTRY') {
    syncState();
  }
});

chrome.tabs.onActivated.addListener(() => {
  syncState();
});

syncCommandFormFields();
syncState();
