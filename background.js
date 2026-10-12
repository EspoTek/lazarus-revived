/*
 * Lazarus Revived — service worker.
 *
 * Owns storage, encryption keys, the right-click menu, the toolbar badge and
 * the hourly expiry sweep. Content scripts send "save" / "fieldFocused" /
 * "fieldContext"; the popup and options pages send everything else.
 */
importScripts('lib/heuristics.js', 'lib/crypto.js', 'lib/store.js');

const H = globalThis.LazarusHeuristics;
const C = globalThis.LazarusCrypto;
const S = globalThis.LazarusStore;

const MENU_ROOT = 'lazarus-root';
const MENU_MAX_ITEMS = 12;
const PRUNE_ALARM = 'lazarus-prune';

// ------------------------------------------------------------------ helpers

function serial() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
}
const menuQueue = serial();

function menuCreate(props) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(props, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function escapeMenuTitle(s) {
  return s.replace(/&/g, '&&');
}

async function sessionGet(key) {
  const got = await chrome.storage.session.get(key);
  return key in got ? got[key] : null;
}

// -------------------------------------------------------------- unlock state

let privateKeyCache = null;

async function getPrivateKey() {
  if (privateKeyCache) return privateKeyCache;
  const jwk = await sessionGet('privateJwk');
  if (!jwk) return null;
  privateKeyCache = await C.importPrivateJwk(jwk);
  return privateKeyCache;
}

async function isLocked() {
  const keys = await S.getKeys();
  if (!keys) return false;
  return (await getPrivateKey()) === null;
}

async function unlock(passphrase) {
  const keys = await S.getKeys();
  if (!keys) throw new Error('No passphrase is set.');
  let priv;
  try {
    priv = await C.unlockPrivateKey(passphrase, keys.wrappedPrivate);
  } catch (err) {
    // AES-GCM authentication failure means the passphrase was wrong.
    if (err && err.name === 'OperationError') return false;
    throw err;
  }
  privateKeyCache = priv;
  await chrome.storage.session.set({ privateJwk: await C.exportPrivateJwk(priv) });
  return true;
}

async function lock() {
  privateKeyCache = null;
  await chrome.storage.session.remove('privateJwk');
}

// Returns { text, html } for a stored entry, decrypting if needed.
async function readEntryBody(entry) {
  if (!entry.enc) return { text: entry.text, html: entry.html };
  const priv = await getPrivateKey();
  if (!priv) throw new Error('Lazarus is locked. Unlock it from the toolbar popup first.');
  return JSON.parse(await C.decryptString(priv, entry.enc));
}

async function writeEntryBody(entry, body, keys) {
  delete entry.text;
  delete entry.html;
  delete entry.enc;
  if (keys) {
    entry.enc = await C.encryptString(keys.publicJwk, JSON.stringify(body));
  } else {
    entry.text = body.text;
    entry.html = body.html;
  }
}

// ----------------------------------------------------------------- focus map

async function rememberFocus(tabId, info) {
  await chrome.storage.session.set({ ['focus:' + tabId]: info });
}

async function recallFocus(tabId) {
  return sessionGet('focus:' + tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('focus:' + tabId);
});

// -------------------------------------------------------------------- badge

async function updateBadge(tabId, host) {
  const index = await S.getIndex();
  const n = index.filter((r) => r.host === host).length;
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b7a57' });
  await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
}

// ------------------------------------------------------------- context menu

function rowsForHost(index, host, fieldKey) {
  return index
    .filter((r) => r.host === host)
    .sort((a, b) => {
      const af = a.fieldKey === fieldKey ? 1 : 0;
      const bf = b.fieldKey === fieldKey ? 1 : 0;
      if (af !== bf) return bf - af;
      return b.updatedAt - a.updatedAt;
    });
}

function rebuildMenu(focus) {
  return menuQueue(async () => {
    await chrome.contextMenus.removeAll();
    await menuCreate({ id: MENU_ROOT, title: 'Lazarus: Recover text', contexts: ['editable'] });

    const settings = await S.getSettings();
    const index = await S.getIndex();
    const rows = focus ? rowsForHost(index, focus.host, focus.fieldKey).slice(0, MENU_MAX_ITEMS) : [];
    const locked = await isLocked();

    if (!settings.enabled) {
      await menuCreate({ id: 'lz-disabled', parentId: MENU_ROOT, contexts: ['editable'], enabled: false, title: 'Saving is paused (see options)' });
    } else if (focus && H.hostIsBlocked(focus.host, settings.blockedHosts)) {
      await menuCreate({ id: 'lz-blocked', parentId: MENU_ROOT, contexts: ['editable'], enabled: false, title: 'This site is on your block list' });
    } else if (rows.length === 0) {
      await menuCreate({ id: 'lz-none', parentId: MENU_ROOT, contexts: ['editable'], enabled: false, title: focus ? 'Nothing saved yet for ' + focus.host : 'Nothing saved for this page' });
    } else if (locked && rows.some((r) => r.enc)) {
      await menuCreate({ id: 'lz-unlock', parentId: MENU_ROOT, contexts: ['editable'], title: '🔒 Unlock Lazarus to see saved text…' });
    } else {
      for (const row of rows) {
        const entry = await S.getEntry(row.id);
        const body = await readEntryBody(entry);
        const same = row.fieldKey === focus.fieldKey ? '● ' : '';
        const title = same + H.preview(body.text, 48) + '   (' + entry.fieldLabel + ', ' + H.timeAgo(row.updatedAt) + ')';
        await menuCreate({ id: 'lz:' + row.id, parentId: MENU_ROOT, contexts: ['editable'], title: escapeMenuTitle(title) });
      }
    }
    await menuCreate({ id: 'lz-sep', parentId: MENU_ROOT, contexts: ['editable'], type: 'separator' });
    await menuCreate({ id: 'lz-open', parentId: MENU_ROOT, contexts: ['editable'], title: 'Browse all saved text…' });
  });
}

let menuTimer = null;
function scheduleMenuRebuild(focus, delay) {
  clearTimeout(menuTimer);
  menuTimer = setTimeout(() => {
    rebuildMenu(focus).catch((err) => console.error('Lazarus: menu rebuild failed', err));
  }, delay);
}

function openFullView() {
  return chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?full=1') });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  (async () => {
    if (id === 'lz-open') {
      await openFullView();
    } else if (id === 'lz-unlock') {
      try {
        await chrome.action.openPopup();
      } catch (_) {
        // openPopup needs Chrome 127+; fall back to the full-page view.
        await openFullView();
      }
    } else if (id.startsWith('lz:')) {
      const entry = await S.getEntry(id.slice(3));
      const body = await readEntryBody(entry);
      const res = await chrome.tabs.sendMessage(
        tab.id,
        { type: 'restore', target: 'context', text: body.text, html: body.html },
        { frameId: info.frameId || 0 }
      );
      if (!res || !res.ok) throw new Error(res ? res.reason : 'No response from page');
    }
  })().catch((err) => console.error('Lazarus: context menu action failed', err));
});

// --------------------------------------------------------------------- save

function assertString(v, name) {
  if (typeof v !== 'string') throw new Error('Lazarus: bad save payload, ' + name + ' is not a string');
}

async function handleSave(e, sender) {
  ['host', 'origin', 'url', 'title', 'fieldKey', 'fieldLabel', 'fieldType', 'pageLoadId', 'text'].forEach((k) => assertString(e[k], k));
  const settings = await S.getSettings();
  if (!settings.enabled) return null;
  if (H.hostIsBlocked(e.host, settings.blockedHosts)) return null;
  if (e.text.length < settings.minTextLength || e.text.length > settings.maxTextLength) return null;
  if (settings.skipCardNumbers && H.containsCardNumber(e.text)) return null;

  const index = await S.getIndex();
  const existing = index.find((r) => r.origin === e.origin && r.fieldKey === e.fieldKey && r.pageLoadId === e.pageLoadId);
  const now = Date.now();
  const entry = {
    id: existing ? existing.id : crypto.randomUUID(),
    host: e.host,
    origin: e.origin,
    url: e.url,
    title: e.title,
    fieldKey: e.fieldKey,
    fieldLabel: e.fieldLabel,
    fieldType: e.fieldType,
    pageLoadId: e.pageLoadId,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    len: e.text.length
  };
  await writeEntryBody(entry, { text: e.text, html: e.html || null }, await S.getKeys());
  await S.putEntry(entry);
  await S.prune({ max: settings.maxEntries, olderThan: now - settings.retentionDays * 86400000 });

  if (sender.tab) {
    await updateBadge(sender.tab.id, e.host);
    const focus = await recallFocus(sender.tab.id);
    if (focus && focus.host === e.host) scheduleMenuRebuild(focus, 300);
  }
  return entry.id;
}

// --------------------------------------------------------------- list / get

async function listEntries(host) {
  const index = await S.getIndex();
  const rows = index.filter((r) => !host || r.host === host).sort((a, b) => b.updatedAt - a.updatedAt);
  const locked = await isLocked();
  const out = [];
  for (const row of rows) {
    const entry = await S.getEntry(row.id);
    const item = {
      id: entry.id, host: entry.host, origin: entry.origin, url: entry.url, title: entry.title,
      fieldKey: entry.fieldKey, fieldLabel: entry.fieldLabel, fieldType: entry.fieldType,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, len: entry.len,
      enc: Boolean(entry.enc), text: null
    };
    if (!entry.enc || !locked) item.text = (await readEntryBody(entry)).text;
    out.push(item);
  }
  return out;
}

async function getPlain(id) {
  const entry = await S.getEntry(id);
  const body = await readEntryBody(entry);
  return Object.assign({}, entry, { enc: undefined, text: body.text, html: body.html });
}

// ---------------------------------------------------------- passphrase mgmt

async function reencryptAll(transform) {
  const index = await S.getIndex();
  for (const row of index) {
    const entry = await S.getEntry(row.id);
    await transform(entry);
    await S.putEntry(entry);
  }
  return index.length;
}

async function setPassphrase(passphrase) {
  if (await S.getKeys()) throw new Error('A passphrase is already set. Change or remove it instead.');
  if (typeof passphrase !== 'string' || passphrase.length < 6) throw new Error('Passphrase must be at least 6 characters.');
  const keys = await C.setupPassphrase(passphrase);
  await S.setKeys(keys);
  await unlock(passphrase);
  await reencryptAll(async (entry) => writeEntryBody(entry, await readEntryBody(entry), keys));
  return true;
}

async function changePassphrase(oldPass, newPass) {
  if (typeof newPass !== 'string' || newPass.length < 6) throw new Error('Passphrase must be at least 6 characters.');
  if (!(await unlock(oldPass))) return false;
  const keys = await S.getKeys();
  keys.wrappedPrivate = await C.rewrapPrivateKey(await getPrivateKey(), newPass);
  await S.setKeys(keys);
  return true;
}

async function removePassphrase(passphrase) {
  if (!(await unlock(passphrase))) return false;
  await reencryptAll(async (entry) => writeEntryBody(entry, await readEntryBody(entry), null));
  await S.setKeys(null);
  await lock();
  return true;
}

// ---------------------------------------------------------------- messages

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'save':
      return handleSave(msg.entry, sender);

    case 'fieldFocused':
    case 'fieldContext': {
      if (!sender.tab) return null;
      const focus = { frameId: sender.frameId || 0, host: msg.host, origin: msg.origin, fieldKey: msg.fieldKey, at: Date.now() };
      await rememberFocus(sender.tab.id, focus);
      scheduleMenuRebuild(focus, msg.type === 'fieldContext' ? 0 : 150);
      return null;
    }

    case 'status': {
      const keys = await S.getKeys();
      const index = await S.getIndex();
      return { hasPassphrase: Boolean(keys), locked: await isLocked(), count: index.length, settings: await S.getSettings() };
    }
    case 'list':
      return listEntries(msg.host || null);
    case 'get':
      return getPlain(msg.id);
    case 'delete':
      await S.removeEntries(msg.ids);
      return true;
    case 'clearAll':
      return S.clearAllEntries();
    case 'restore': {
      const body = await readEntryBody(await S.getEntry(msg.id));
      const focus = await recallFocus(msg.tabId);
      const opts = focus ? { frameId: focus.frameId } : {};
      const res = await chrome.tabs.sendMessage(msg.tabId, { type: 'restore', target: 'focused', text: body.text, html: body.html }, opts);
      if (!res) throw new Error('No response from the page');
      if (!res.ok) throw new Error(res.reason);
      return true;
    }
    case 'badge':
      if (sender.tab) await updateBadge(sender.tab.id, msg.host);
      return null;

    case 'unlock':
      return unlock(msg.passphrase);
    case 'lock':
      await lock();
      return true;
    case 'setPassphrase':
      return setPassphrase(msg.passphrase);
    case 'changePassphrase':
      return changePassphrase(msg.oldPassphrase, msg.newPassphrase);
    case 'removePassphrase':
      return removePassphrase(msg.passphrase);

    case 'getSettings':
      return S.getSettings();
    case 'setSettings': {
      const next = await S.setSettings(msg.patch);
      const now = Date.now();
      await S.prune({ max: next.maxEntries, olderThan: now - next.retentionDays * 86400000 });
      return next;
    }
    case 'export': {
      const rows = await listEntries(null);
      const out = [];
      for (const r of rows) out.push(await getPlain(r.id));
      return out;
    }
    default:
      throw new Error('Lazarus: unknown message type ' + msg.type);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => {
      console.error('Lazarus:', msg.type, err);
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
  );
  return true;
});

// ------------------------------------------------------------- lifecycle

async function pruneNow() {
  const settings = await S.getSettings();
  return S.prune({ max: settings.maxEntries, olderThan: Date.now() - settings.retentionDays * 86400000 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 60 });
  rebuildMenu(null).catch((err) => console.error('Lazarus: initial menu failed', err));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(PRUNE_ALARM, { periodInMinutes: 60 });
  pruneNow().catch((err) => console.error('Lazarus: startup prune failed', err));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRUNE_ALARM) pruneNow().catch((err) => console.error('Lazarus: prune failed', err));
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.sendMessage(tabId, { type: 'whoami' }).then(
    (res) => { if (res && res.host) return updateBadge(tabId, res.host); },
    () => chrome.action.setBadgeText({ tabId, text: '' }) // no content script in this tab (chrome://, store, etc.)
  );
});
