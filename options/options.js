(function () {
  'use strict';

  const H = globalThis.LazarusHeuristics;
  const $ = (id) => document.getElementById(id);
  const CHECKS = ['enabled', 'saveContentEditable', 'skipSensitiveFields', 'skipCardNumbers', 'respectAutocompleteOff', 'saveInIncognito'];
  const NUMBERS = ['retentionDays', 'maxEntries', 'minTextLength', 'maxTextLength'];

  async function call(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res) throw new Error('No response from the extension background');
    if (!res.ok) throw new Error(res.error);
    return res.result;
  }

  let savedTimer = null;
  function flashSaved() {
    $('saved').hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { $('saved').hidden = true; }, 1200);
  }

  function showEncError(msg) {
    $('encError').textContent = msg || '';
    $('encError').hidden = !msg;
  }

  async function load() {
    const status = await call({ type: 'status' });
    const s = status.settings;
    for (const k of CHECKS) $(k).checked = Boolean(s[k]);
    for (const k of NUMBERS) $(k).value = s[k];
    $('blockedHosts').value = s.blockedHosts.join('\n');
    $('stats').textContent = status.count + ' entries saved.';
    $('encNone').hidden = status.hasPassphrase;
    $('encSet').hidden = !status.hasPassphrase;
    $('lockState').textContent = status.locked ? 'Currently locked.' : 'Currently unlocked for this browser session.';
  }

  async function saveSettings() {
    const patch = {};
    for (const k of CHECKS) patch[k] = $(k).checked;
    for (const k of NUMBERS) {
      const el = $(k);
      const v = Number(el.value);
      if (!Number.isFinite(v) || v < Number(el.min) || v > Number(el.max)) {
        el.reportValidity();
        return;
      }
      patch[k] = Math.round(v);
    }
    patch.blockedHosts = H.parseBlocklist($('blockedHosts').value);
    await call({ type: 'setSettings', patch });
    flashSaved();
    await load();
  }

  for (const k of CHECKS.concat(NUMBERS)) $(k).addEventListener('change', saveSettings);
  $('blockedHosts').addEventListener('change', saveSettings);

  $('setForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showEncError('');
    const a = $('newPass').value, b = $('newPass2').value;
    if (a !== b) return showEncError('The two passphrases do not match.');
    if (a.length < 6) return showEncError('Use at least 6 characters.');
    try {
      await call({ type: 'setPassphrase', passphrase: a });
      $('newPass').value = $('newPass2').value = '';
      flashSaved();
      await load();
    } catch (err) {
      showEncError(err.message);
    }
  });

  $('changeForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showEncError('');
    const ok = await call({ type: 'changePassphrase', oldPassphrase: $('oldPass').value, newPassphrase: $('chgPass').value })
      .catch((err) => { showEncError(err.message); return null; });
    if (ok === null) return;
    if (!ok) return showEncError('Current passphrase is wrong.');
    $('oldPass').value = $('chgPass').value = '';
    flashSaved();
    await load();
  });

  $('removeForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showEncError('');
    const ok = await call({ type: 'removePassphrase', passphrase: $('rmPass').value })
      .catch((err) => { showEncError(err.message); return null; });
    if (ok === null) return;
    if (!ok) return showEncError('Current passphrase is wrong.');
    $('rmPass').value = '';
    flashSaved();
    await load();
  });

  $('exportBtn').addEventListener('click', async () => {
    try {
      const data = await call({ type: 'export' });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'lazarus-export-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
      $('dataMsg').textContent = 'Exported ' + data.length + ' entries.';
    } catch (err) {
      $('dataMsg').textContent = 'Export failed: ' + err.message;
    }
  });

  let clearArmed = false;
  $('clearBtn').addEventListener('click', async () => {
    if (!clearArmed) {
      clearArmed = true;
      $('clearBtn').textContent = 'Click again to confirm';
      setTimeout(() => { clearArmed = false; $('clearBtn').textContent = 'Delete all saved text'; }, 4000);
      return;
    }
    clearArmed = false;
    $('clearBtn').textContent = 'Delete all saved text';
    const n = await call({ type: 'clearAll' });
    $('dataMsg').textContent = 'Deleted ' + n + ' entries.';
    await load();
  });

  load().catch((err) => showEncError('Failed to load settings: ' + err.message));
})();
