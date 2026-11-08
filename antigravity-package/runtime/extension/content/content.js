// Antigravity Chrome Bridge — Content Script
// Provides DOM inspection, interactive snapshot generation, and human-like element interaction.

if (!globalThis.__AGY_BRIDGE_INJECTED__) {
  globalThis.__AGY_BRIDGE_INJECTED__ = true;

  let toastTimeoutId = null;

  function showToast(message, durationMs = 2200) {
    let toast = document.getElementById('agy-bridge-status-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'agy-bridge-status-toast';
      toast.className = 'agy-bridge-toast';
      const dot = document.createElement('span');
      dot.className = 'agy-bridge-toast-dot';
      const textSpan = document.createElement('span');
      textSpan.id = 'agy-bridge-status-toast-text';
      toast.appendChild(dot);
      toast.appendChild(textSpan);
      (document.body || document.documentElement).appendChild(toast);
    }
    const textSpan = document.getElementById('agy-bridge-status-toast-text');
    if (textSpan) {
      textSpan.textContent = message;
    }
    requestAnimationFrame(() => {
      toast.classList.add('agy-visible');
    });
    if (toastTimeoutId) {
      clearTimeout(toastTimeoutId);
    }
    toastTimeoutId = setTimeout(() => {
      toast.classList.remove('agy-visible');
    }, durationMs);
  }

  function flashElementHighlight(el, labelText = 'Antigravity') {
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const box = document.createElement('div');
    box.className = 'agy-bridge-highlight-box';
    box.style.left = `${Math.max(0, rect.left - 3)}px`;
    box.style.top = `${Math.max(0, rect.top - 3)}px`;
    box.style.width = `${rect.width + 6}px`;
    box.style.height = `${rect.height + 6}px`;

    const label = document.createElement('div');
    label.className = 'agy-bridge-highlight-label';
    label.textContent = labelText;
    box.appendChild(label);

    (document.body || document.documentElement).appendChild(box);
    setTimeout(() => {
      box.remove();
    }, 1100);
  }

  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  function getCssSelector(el) {
    if (!el || !(el instanceof Element)) return '';
    if (el.id) {
      return `#${CSS.escape(el.id)}`;
    }
    const ref = el.getAttribute('data-agy-ref');
    if (ref) {
      return `[data-agy-ref="${ref}"]`;
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
      let part = cur.nodeName.toLowerCase();
      if (cur.id) {
        part = `#${CSS.escape(cur.id)}`;
        parts.unshift(part);
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.nodeName === cur.nodeName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function getElementLabel(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl && labelEl.innerText) return labelEl.innerText.trim();
    }

    if (el.id) {
      const assocLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (assocLabel && assocLabel.innerText) return assocLabel.innerText.trim();
    }

    const parentLabel = el.closest('label');
    if (parentLabel && parentLabel.innerText) {
      return parentLabel.innerText.trim().slice(0, 80);
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();

    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();

    const text = (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 100);
  }

  function resolveTargetElement(params = {}) {
    const { ref, selector, xpath, text, index = 0 } = params;

    if (ref !== undefined && ref !== null && String(ref).trim() !== '') {
      const cleanRef = String(ref).replace(/^ref=/i, '').trim();
      const byRef = document.querySelector(`[data-agy-ref="${CSS.escape(cleanRef)}"]`);
      if (byRef) return byRef;
    }

    if (selector) {
      // Also allow passing a numeric ref directly in selector
      if (/^\d+$/.test(String(selector).trim())) {
        const byNumericRef = document.querySelector(`[data-agy-ref="${String(selector).trim()}"]`);
        if (byNumericRef) return byNumericRef;
      }
      try {
        const matches = Array.from(document.querySelectorAll(selector));
        const visibleMatches = matches.filter(isElementVisible);
        if (visibleMatches[index]) return visibleMatches[index];
        if (matches[index]) return matches[index];
      } catch (_err) {
        // Fallback to text search if selector is invalid CSS
      }
    }

    if (xpath) {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      if (result.snapshotLength > index) {
        return result.snapshotItem(index);
      }
    }

    const searchText = text || selector;
    if (searchText) {
      const needle = String(searchText).toLowerCase().trim();
      const candidates = Array.from(
        document.querySelectorAll(
          'button, a, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], label, summary, h1, h2, h3, span, div'
        )
      ).filter(isElementVisible);

      // Exact match first
      for (const el of candidates) {
        const label = getElementLabel(el).toLowerCase();
        if (label === needle) return el;
      }
      // Substring match on interactive elements first
      for (const el of candidates) {
        const label = getElementLabel(el).toLowerCase();
        if (label.includes(needle) && el.matches('button, a, input, textarea, select, [role="button"], [role="link"]')) {
          return el;
        }
      }
      // General substring match
      for (const el of candidates) {
        const label = getElementLabel(el).toLowerCase();
        if (label.includes(needle)) return el;
      }
    }

    return null;
  }

  async function highlightManyElements(elements) {
    const BATCH_SIZE = 20;
    for (let i = 0; i < elements.length; i += BATCH_SIZE) {
      const batch = elements.slice(i, i + BATCH_SIZE);
      await new Promise(resolve =>
        requestAnimationFrame(() => {
          batch.forEach((el, idx) => {
            flashElementHighlight(el, `#${i + idx + 1}`);
          });
          resolve();
        })
      );
      if (globalThis.scheduler?.yield) {
        await globalThis.scheduler.yield();
      }
    }
  }

  function buildPageSnapshot(options = {}) {
    const maxElements = options.maxElements || 150;
    const maxTextLength = options.maxTextLength || 6000;

    const interactiveSelector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'textarea',
      'select',
      'summary',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="combobox"]',
      '[role="searchbox"]',
      '[role="textbox"]',
      '[contenteditable="true"]'
    ].join(', ');

    const rawElements = Array.from(document.querySelectorAll(interactiveSelector));
    const interactiveElements = [];
    let refCounter = 1;

    for (const el of rawElements) {
      if (!isElementVisible(el)) continue;
      if (interactiveElements.length >= maxElements) break;

      const refId = String(refCounter++);
      el.setAttribute('data-agy-ref', refId);
      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || undefined;
      const role = el.getAttribute('role') || undefined;
      const label = getElementLabel(el);
      const placeholder = el.getAttribute('placeholder') || undefined;
      const name = el.getAttribute('name') || undefined;
      const href = tag === 'a' ? el.getAttribute('href') || undefined : undefined;
      const value =
        'value' in el && typeof el.value === 'string' && el.type !== 'password'
          ? el.value.slice(0, 120)
          : undefined;
      const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';

      interactiveElements.push({
        ref: refId,
        tag,
        type,
        role,
        label: label || undefined,
        placeholder,
        name,
        value: value || undefined,
        href,
        disabled: disabled || undefined,
        selector: getCssSelector(el),
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    }

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .filter(isElementVisible)
      .slice(0, 30)
      .map(h => ({
        level: h.tagName.toLowerCase(),
        text: (h.innerText || h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140)
      }))
      .filter(h => h.text.length > 0);

    const bodyText = (document.body?.innerText || '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, maxTextLength);

    return {
      title: document.title,
      url: location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        scrollHeight: Math.round(document.documentElement.scrollHeight)
      },
      headings,
      interactiveCount: interactiveElements.length,
      interactiveElements,
      textPreview: bodyText
    };
  }

  async function clickElement(params = {}) {
    const el = resolveTargetElement(params);
    if (!el) {
      throw new Error(
        `Element not found for ${JSON.stringify({
          ref: params.ref,
          selector: params.selector,
          text: params.text
        })}`
      );
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    await new Promise(r => setTimeout(r, 120));

    const label = getElementLabel(el) || el.tagName.toLowerCase();
    flashElementHighlight(el, `Click: ${label.slice(0, 24)}`);
    showToast(`Antigravity clicked: ${label.slice(0, 36)}`);

    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY
    };

    el.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    el.dispatchEvent(new MouseEvent('mousedown', eventInit));
    if (typeof el.focus === 'function') {
      el.focus({ preventScroll: true });
    }
    el.dispatchEvent(new PointerEvent('pointerup', eventInit));
    el.dispatchEvent(new MouseEvent('mouseup', eventInit));
    el.dispatchEvent(new MouseEvent('click', eventInit));

    return {
      clicked: true,
      tag: el.tagName.toLowerCase(),
      label,
      ref: el.getAttribute('data-agy-ref') || undefined,
      selector: getCssSelector(el),
      href: el.getAttribute('href') || undefined
    };
  }

  function setNativeValue(el, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(el, 'value')?.set;
    const prototype = Object.getPrototypeOf(el);
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(el, value);
    } else if (valueSetter) {
      valueSetter.call(el, value);
    } else {
      el.value = value;
    }
  }

  async function fillElement(params = {}) {
    const { value = '', clear = true, submit = false } = params;
    const el = resolveTargetElement(params);
    if (!el) {
      throw new Error(
        `Input element not found for ${JSON.stringify({
          ref: params.ref,
          selector: params.selector,
          text: params.text
        })}`
      );
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise(r => setTimeout(r, 100));

    const label = getElementLabel(el) || el.tagName.toLowerCase();
    flashElementHighlight(el, `Fill: ${String(value).slice(0, 20)}`);
    showToast(`Antigravity typed into: ${label.slice(0, 32)}`);

    if (typeof el.focus === 'function') {
      el.focus({ preventScroll: true });
    }

    if (el.tagName.toLowerCase() === 'select') {
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } else if (el.isContentEditable) {
      if (clear) {
        el.textContent = '';
      }
      el.textContent = clear ? String(value) : (el.textContent || '') + String(value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: String(value) }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } else {
      const nextVal = clear ? String(value) : (el.value || '') + String(value);
      setNativeValue(el, nextVal);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: String(value) }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }

    if (submit) {
      await new Promise(r => setTimeout(r, 80));
      const keyInit = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      };
      el.dispatchEvent(new KeyboardEvent('keydown', keyInit));
      el.dispatchEvent(new KeyboardEvent('keypress', keyInit));
      el.dispatchEvent(new KeyboardEvent('keyup', keyInit));

      const form = el.closest('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          form.submit();
        }
      }
    }

    return {
      filled: true,
      tag: el.tagName.toLowerCase(),
      label,
      value: String(value),
      submitted: Boolean(submit),
      selector: getCssSelector(el)
    };
  }

  async function pressKeyOnPage(params = {}) {
    const { key = 'Enter', selector, ref } = params;
    const target = (selector || ref ? resolveTargetElement(params) : null) || document.activeElement || document.body;

    if (target && typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }

    const keyMap = {
      Enter: 13,
      Escape: 27,
      Tab: 9,
      Backspace: 8,
      ArrowDown: 40,
      ArrowUp: 38,
      ArrowLeft: 37,
      ArrowRight: 39,
      Space: 32
    };
    const keyCode = keyMap[key] || key.charCodeAt(0) || 0;
    const eventInit = {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true
    };

    target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    showToast(`Antigravity pressed key: ${key}`);

    return {
      pressed: true,
      key,
      targetTag: target?.tagName?.toLowerCase()
    };
  }

  async function scrollPage(params = {}) {
    const { direction = 'down', amount = 550, x, y, selector } = params;
    const container = selector ? document.querySelector(selector) : window;
    const isWindow = !container || container === window;

    if (typeof x === 'number' || typeof y === 'number') {
      container.scrollTo({
        left: typeof x === 'number' ? x : 0,
        top: typeof y === 'number' ? y : 0,
        behavior: 'smooth'
      });
    } else if (direction === 'top') {
      container.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (direction === 'bottom') {
      const maxScroll = isWindow
        ? document.documentElement.scrollHeight
        : container.scrollHeight;
      container.scrollTo({ top: maxScroll, behavior: 'smooth' });
    } else if (direction === 'up') {
      container.scrollBy({ top: -Math.abs(amount), behavior: 'smooth' });
    } else {
      container.scrollBy({ top: Math.abs(amount), behavior: 'smooth' });
    }

    await new Promise(r => setTimeout(r, 200));
    return {
      scrolled: true,
      direction,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.round(document.documentElement.scrollHeight)
    };
  }

  async function waitForCondition(params = {}) {
    const { selector, text, timeoutMs = 10000 } = params;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (selector) {
        const el = document.querySelector(selector);
        if (el && isElementVisible(el)) {
          return {
            found: true,
            elapsedMs: Date.now() - start,
            selector,
            label: getElementLabel(el)
          };
        }
      }
      if (text) {
        const bodyText = document.body?.innerText || '';
        if (bodyText.toLowerCase().includes(String(text).toLowerCase())) {
          return {
            found: true,
            elapsedMs: Date.now() - start,
            text
          };
        }
      }
      await new Promise(r => requestAnimationFrame(r));
    }

    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${selector || text}`);
  }

  async function extractPageData(params = {}) {
    const { mode = 'summary', selector, maxItems = 100 } = params;

    if (selector) {
      const nodes = Array.from(document.querySelectorAll(selector)).slice(0, maxItems);
      return {
        selector,
        count: nodes.length,
        items: nodes.map((el, idx) => ({
          index: idx,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
          html: el.outerHTML.slice(0, 1000),
          href: el.getAttribute('href') || undefined,
          src: el.getAttribute('src') || undefined
        }))
      };
    }

    if (mode === 'links') {
      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter(isElementVisible)
        .slice(0, maxItems)
        .map(a => ({
          text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim(),
          href: a.href
        }));
      return { count: links.length, links };
    }

    if (mode === 'tables') {
      const tables = Array.from(document.querySelectorAll('table')).slice(0, 10).map(table => {
        const rows = Array.from(table.querySelectorAll('tr')).slice(0, 100).map(tr =>
          Array.from(tr.querySelectorAll('th, td')).map(cell =>
            (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim()
          )
        );
        return rows;
      });
      return { tableCount: tables.length, tables };
    }

    if (mode === 'html') {
      return {
        title: document.title,
        url: location.href,
        html: document.documentElement.outerHTML.slice(0, 50000)
      };
    }

    return buildPageSnapshot(params);
  }

  async function handleContentAction(action, params = {}) {
    switch (action) {
      case 'snapshot':
        return buildPageSnapshot(params);
      case 'click':
        return await clickElement(params);
      case 'fill':
      case 'type':
        return await fillElement(params);
      case 'press_key':
        return await pressKeyOnPage(params);
      case 'scroll':
        return await scrollPage(params);
      case 'wait_for':
        return await waitForCondition(params);
      case 'extract':
        return await extractPageData(params);
      case 'toast':
        showToast(params.message || 'Antigravity Connected', params.durationMs || 2500);
        return { shown: true };
      case 'highlight_selector': {
        const matches = Array.from(document.querySelectorAll(params.selector || 'a, button')).filter(isElementVisible);
        await highlightManyElements(matches.slice(0, 60));
        return { highlightedCount: Math.min(matches.length, 60) };
      }
      default:
        throw new Error(`Unknown content script action: ${action}`);
    }
  }

  globalThis.__AGY_BRIDGE_API__ = {
    handleContentAction,
    buildPageSnapshot,
    clickElement,
    fillElement,
    pressKeyOnPage,
    scrollPage,
    waitForCondition,
    extractPageData,
    showToast
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'agy-content') {
      return false;
    }
    (async () => {
      try {
        const data = await handleContentAction(message.action, message.params || {});
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  });
}
