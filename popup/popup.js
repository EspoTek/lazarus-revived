/* Popup / full-page browser of saved text. */
(function () {
  'use strict';

  const H = globalThis.LazarusHeuristics;
  const $ = (id) => document.getElementById(id);
  const FULL = new URLSearchParams(location.search).get('full') === '1';

  let tab = null;          // active tab, if we can talk to it
  let page = null;         // whoami from the content script
  let status = null;
  let entries = [];

  if (FULL) document.body.classList.add('full');

  async function call(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res) throw new Error('No response from the extension background');
    if (!res.ok) throw new Error(res.error);
    return res.result;
  }

  function notice(text) {
    const n = $('notice');
    n.textContent = text || '';
    n.hidden = !text;
  }

  // Ask the page which site it is. Fails on chrome:// and the Web Store,
  // which is expected: we then show all sites.
  async function findPage() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) return;
    tab = active;
    try {
      page = await chrome.tabs.sendMessage(active.id, { type: 'whoami' });
    } catch (err) {
      if (!/Receiving end does not exist|Could not establish connection/.test(String(err.message))) throw err;
      page = null;
    }
  }

  function currentHost() {
    return $('allSites').checked || !page ? null : page.host;
  }

  function render() {
    const q = $('search').value.trim().toLowerCase();
    const list = $('list');
    list.textContent = '';
    const visible = entries.filter((e) => {
      if (!q) return true;
      const hay = [(e.text || ''), e.fieldLabel, e.host, e.title].join(' ').toLowerCase();
      return hay.includes(q);
    });
    $('empty').hidden = visible.length > 0;
    $('count').textContent = visible.length + ' of ' + status.count + ' saved';

    for (const e of visible) {
      const li = document.createElement('li');
      li.className = 'entry';
      if (page && e.fieldKey === page.fieldKey) li.classList.add('same');

      const pv = document.createElement('div');
      pv.className = 'preview';
      pv.textContent = e.text === null ? '🔒 (encrypted — unlock to read)' : e.text;
      pv.title = 'Click to expand';
      pv.addEventListener('click', () => li.classList.toggle('open'));

      const meta = document.createElement('div');
      meta.className = 'meta';
      const bits = [];
      if (page && e.fieldKey === page.fieldKey) bits.push(['tag', '● this field']);
      bits.push(['', e.fieldLabel]);
      bits.push(['', H.timeAgo(e.updatedAt)]);
      bits.push(['', e.len + ' chars']);
      if (!currentHost()) bits.push(['', e.host]);
      if (e.title) bits.push(['', e.title]);
      for (const [cls, text] of bits) {
        const s = document.createElement('span');
        if (cls) s.className = cls;
        s.textContent = text;
        meta.appendChild(s);
      }

      const actions = document.createElement('div');
      actions.className = 'actions';
      const restore = document.createElement('button');
      restore.className = 'restore';
      restore.textContent = 'Restore into field';
      restore.disabled = !page || !page.fieldKey || e.text === null || page.origin !== e.origin;
      restore.title = restore.disabled
        ? 'Click into a text field on the same site first'
        : 'Replace the contents of the last focused field with this text';
      restore.addEventListener('click', () => doRestore(e, restore));
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.disabled = e.text === null;
      copy.addEventListener('click', () => doCopy(e, copy));
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = 'Delete';
      del.addEventListener('click', () => doDelete(e));
      actions.append(restore, copy, del);

      li.append(pv, meta, actions);
      list.appendChild(li);
    }
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = old; }, 1200);
  }

  async function doRestore(e, btn) {
    try {
      await call({ type: 'restore', id: e.id, tabId: tab.id });
      flash(btn, 'Restored ✓');
      if (!FULL) setTimeout(() => window.close(), 500);
    } catch (err) {
      notice(err.message);
    }
  }

  async function doCopy(e, btn) {
    const full = await call({ type: 'get', id: e.id });
    await navigator.clipboard.writeText(full.text);
    flash(btn, 'Copied ✓');
  }

  async function doDelete(e) {
    await call({ type: 'delete', ids: [e.id] });
    await reload();
  }

  async function reload() {
    status = await call({ type: 'status' });
    $('lockBtn').hidden = !status.hasPassphrase || status.locked;
    $('unlock').hidden = !status.locked;
    if (status.locked) $('passphrase').focus();

    const host = currentHost();
    $('site').textContent = host ? host : (page ? '' : 'all sites');
    entries = await call({ type: 'list', host });
    render();

    const pause = $('pauseBtn');
    if (page && page.isTop) {
      const blocked = H.hostIsBlocked(page.host, status.settings.blockedHosts);
      pause.hidden = false;
      pause.textContent = blocked ? 'Resume saving on ' + page.host : 'Never save on ' + page.host;
    } else {
      pause.hidden = true;
    }
    if (!status.settings.enabled) notice('Saving is paused in options.');
    else if (page && page.incognito && !status.settings.saveInIncognito) notice('Incognito window: nothing is being saved here.');
    else notice('');
  }

  // ------------------------------------------------------------- wiring

  $('search').addEventListener('input', render);
  $('allSites').addEventListener('change', reload);
  $('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('fullBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html?full=1') });
    window.close();
  });
  $('lockBtn').addEventListener('click', async () => {
    await call({ type: 'lock' });
    await reload();
  });
  $('unlockForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await call({ type: 'unlock', passphrase: $('passphrase').value });
    $('unlockError').hidden = ok;
    $('unlockError').textContent = ok ? '' : 'Wrong passphrase.';
    if (ok) {
      $('passphrase').value = '';
      await reload();
    }
  });
  $('pauseBtn').addEventListener('click', async () => {
    const settings = status.settings;
    const list = settings.blockedHosts.slice();
    const blocked = H.hostIsBlocked(page.host, list);
    const next = blocked
      ? list.filter((p) => !H.hostMatchesPattern(page.host, p))
      : list.concat([page.host]);
    await call({ type: 'setSettings', patch: { blockedHosts: next } });
    await reload();
  });
  let clearArmed = false;
  $('clearBtn').addEventListener('click', async () => {
    if (!clearArmed) {
      clearArmed = true;
      $('clearBtn').textContent = 'Really delete everything?';
      setTimeout(() => { clearArmed = false; $('clearBtn').textContent = 'Clear all'; }, 4000);
      return;
    }
    clearArmed = false;
    $('clearBtn').textContent = 'Clear all';
    await call({ type: 'clearAll' });
    await reload();
  });

  (async () => {
    await findPage();
    if (FULL || !page) $('allSites').checked = true;
    await reload();
  })().catch((err) => notice('Error: ' + err.message));
})();
