/*
 * Lazarus Revived — content script.
 *
 * Runs in every frame. Listens (at the document level, capture phase) for
 * typing in text inputs, textareas and contenteditable regions, and ships a
 * debounced copy of the text to the service worker. It never reads password
 * fields, and with the default settings it also skips fields whose name /
 * label / autocomplete marks them as secrets or financial identifiers.
 *
 * It also answers "restore" requests from the context menu and the popup.
 */
(function () {
  'use strict';

  if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.id) return;

  const H = globalThis.LazarusHeuristics;
  const DEBOUNCE_MS = 750;      // quiet time before a save
  const MAX_WAIT_MS = 5000;     // but never wait longer than this while typing
  const PAGE_LOAD_ID = crypto.randomUUID();
  const IS_INCOGNITO = Boolean(chrome.extension && chrome.extension.inIncognitoContext);

  let settings = Object.assign({}, H.DEFAULT_SETTINGS);
  let lastFocusedEl = null;
  let lastContextEl = null;

  const pending = new Map();        // el -> { timer, firstAt }
  const lastSaved = new WeakMap();  // el -> last text sent

  // ---------------------------------------------------------------- settings

  chrome.storage.local.get('settings').then((got) => {
    settings = Object.assign({}, H.DEFAULT_SETTINGS, got.settings || {});
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = Object.assign({}, H.DEFAULT_SETTINGS, changes.settings.newValue || {});
    }
  });

  function savingAllowedHere() {
    if (!settings.enabled) return false;
    if (IS_INCOGNITO && !settings.saveInIncognito) return false;
    if (H.hostIsBlocked(location.hostname, settings.blockedHosts)) return false;
    return true;
  }

  // ---------------------------------------------------------- field helpers

  function editableFrom(node) {
    if (!(node instanceof Element)) return null;
    if (node instanceof HTMLTextAreaElement) return node;
    if (node instanceof HTMLInputElement) {
      return H.SAVEABLE_INPUT_TYPES.has(node.type.toLowerCase()) ? node : null;
    }
    const host = node.closest('[contenteditable]');
    if (host && host.isContentEditable) return host;
    return null;
  }

  function isFormControl(el) {
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  }

  function labelText(el) {
    const parts = [];
    if (el.labels) for (const l of el.labels) parts.push(l.textContent);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      for (const id of by.split(/\s+/)) {
        const n = el.getRootNode().getElementById ? el.getRootNode().getElementById(id) : document.getElementById(id);
        if (n) parts.push(n.textContent);
      }
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function isAutofilled(el) {
    try { return el.matches(':autofill'); } catch (_) { return false; }
  }

  function isSensitive(el) {
    if (el instanceof HTMLInputElement && el.type === 'password') return true;
    if (!settings.skipSensitiveFields) return false;
    if (H.isSensitiveAutocomplete(el.getAttribute('autocomplete'))) return true;
    const texts = [
      el.getAttribute('name'), el.id, el.getAttribute('aria-label'),
      el.getAttribute('placeholder'), el.getAttribute('data-testid'),
      el.title, labelText(el)
    ];
    return texts.some(H.isSensitiveAttributeText);
  }

  function autocompleteOff(el) {
    const own = (el.getAttribute('autocomplete') || '').toLowerCase() === 'off';
    const form = el.form || el.closest('form');
    const formOff = form && (form.getAttribute('autocomplete') || '').toLowerCase() === 'off';
    return own || Boolean(formOff);
  }

  function fieldType(el) {
    if (el instanceof HTMLTextAreaElement) return 'textarea';
    if (el instanceof HTMLInputElement) return el.type.toLowerCase() || 'text';
    return 'contenteditable';
  }

  function indexAmongFields(el) {
    const all = document.querySelectorAll('input, textarea, [contenteditable]');
    return Array.prototype.indexOf.call(all, el);
  }

  function fieldIdentity(el) {
    const form = el.form || el.closest('form');
    let formId = 'noform';
    if (form) {
      formId = form.id || form.getAttribute('name') ||
        ('f' + Array.prototype.indexOf.call(document.forms, form));
    }
    const own = el.getAttribute('name') || el.id || el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') || el.getAttribute('data-testid') ||
      ('n' + indexAmongFields(el));
    const key = location.pathname + '#' + formId + '#' + fieldType(el) + '#' + own;
    return key.slice(0, 300);
  }

  function fieldLabel(el) {
    const l = el.getAttribute('aria-label') || labelText(el) || el.getAttribute('placeholder') ||
      el.getAttribute('name') || el.id || el.getAttribute('title') || fieldType(el);
    return l.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function readValue(el) {
    if (isFormControl(el)) return { text: el.value, html: null };
    return { text: el.innerText, html: el.innerHTML };
  }

  function shouldSave(el) {
    if (!savingAllowedHere()) return false;
    if (!el.isConnected) return false;
    if (isSensitive(el)) return false;
    if (isAutofilled(el)) return false;
    if (el.hasAttribute('data-lazarus-ignore')) return false;
    if (!isFormControl(el) && !settings.saveContentEditable) return false;
    if (settings.respectAutocompleteOff && autocompleteOff(el)) return false;
    return true;
  }

  // ----------------------------------------------------------------- saving

  function schedule(el) {
    let p = pending.get(el);
    if (!p) {
      p = { timer: null, firstAt: Date.now() };
      pending.set(el, p);
    }
    clearTimeout(p.timer);
    const waited = Date.now() - p.firstAt;
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - waited));
    p.timer = setTimeout(() => flush(el), delay);
  }

  function flush(el) {
    const p = pending.get(el);
    if (p) clearTimeout(p.timer);
    pending.delete(el);
    if (!chrome.runtime.id) return; // extension was reloaded; this world is dead
    if (!shouldSave(el)) return;

    const { text, html } = readValue(el);
    if (text.length < settings.minTextLength) return;
    if (text.length > settings.maxTextLength) return;
    if (lastSaved.get(el) === text) return;
    if (settings.skipCardNumbers && H.containsCardNumber(text)) return;
    lastSaved.set(el, text);

    const entry = {
      host: location.hostname,
      origin: location.origin,
      url: (location.origin + location.pathname).slice(0, 500), // never the query string
      title: (document.title || '').slice(0, 200),
      fieldKey: fieldIdentity(el),
      fieldLabel: fieldLabel(el),
      fieldType: fieldType(el),
      pageLoadId: PAGE_LOAD_ID,
      text,
      html: html && html.length <= settings.maxTextLength * 3 ? html : null
    };
    chrome.runtime.sendMessage({ type: 'save', entry });
  }

  function flushAll() {
    for (const el of Array.from(pending.keys())) flush(el);
  }

  // --------------------------------------------------------------- restoring

  function nativeSetValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, value);
  }

  function selectAllIn(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function restoreInto(el, text, html) {
    el.focus();
    if (isFormControl(el)) {
      let ok = false;
      try {
        el.select();
        ok = document.execCommand('insertText', false, text) && el.value === text;
      } catch (_) {
        ok = false;
      }
      if (!ok) {
        nativeSetValue(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }
    selectAllIn(el);
    let ok = false;
    if (html) ok = document.execCommand('insertHTML', false, html) && el.innerText.trim().length > 0;
    if (!ok) {
      selectAllIn(el);
      ok = document.execCommand('insertText', false, text) && el.innerText.trim().length > 0;
    }
    if (!ok) {
      el.innerText = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return true;
  }

  function pickTarget(which) {
    let el = which === 'context' ? lastContextEl : lastFocusedEl;
    if (el && !el.isConnected) el = null;
    if (!el) {
      const active = document.activeElement;
      el = active ? editableFrom(active.shadowRoot ? active.shadowRoot.activeElement || active : active) : null;
    }
    return el;
  }

  // ------------------------------------------------------------------ events

  function notifyFocus(el, kind) {
    if (!chrome.runtime.id) return;
    chrome.runtime.sendMessage({
      type: kind,
      host: location.hostname,
      origin: location.origin,
      fieldKey: fieldIdentity(el),
      saveable: shouldSave(el)
    });
  }

  document.addEventListener('input', (ev) => {
    const el = editableFrom(ev.composedPath()[0]);
    if (!el) return;
    if (!ev.isTrusted) return; // only what the user actually typed/pasted
    schedule(el);
  }, true);

  document.addEventListener('focusin', (ev) => {
    const el = editableFrom(ev.composedPath()[0]);
    if (!el) return;
    lastFocusedEl = el;
    notifyFocus(el, 'fieldFocused');
  }, true);

  document.addEventListener('contextmenu', (ev) => {
    const el = editableFrom(ev.composedPath()[0]);
    if (!el) return;
    lastContextEl = el;
    lastFocusedEl = el;
    notifyFocus(el, 'fieldContext');
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
  window.addEventListener('pagehide', flushAll);
  window.addEventListener('beforeunload', flushAll);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'restore') {
      const el = pickTarget(msg.target);
      if (!el) {
        sendResponse({ ok: false, reason: 'No text field is focused in this page. Click into a field first.' });
        return;
      }
      restoreInto(el, msg.text, msg.html);
      lastSaved.set(el, msg.text);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'whoami') {
      const el = pickTarget('focused');
      sendResponse({
        host: location.hostname,
        origin: location.origin,
        isTop: window === window.top,
        fieldKey: el ? fieldIdentity(el) : null,
        allowed: savingAllowedHere(),
        incognito: IS_INCOGNITO
      });
      return;
    }
  });
})();
