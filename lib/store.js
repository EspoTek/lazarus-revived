/*
 * Thin layer over chrome.storage.local. Only the service worker touches
 * storage; popup and options go through messages.
 *
 * Layout:
 *   settings            -> settings object (merged over DEFAULT_SETTINGS)
 *   index               -> [{ id, host, origin, fieldKey, pageLoadId,
 *                             createdAt, updatedAt, len, enc }]
 *   e:<id>              -> full entry; plaintext { text, html? } or
 *                          encrypted { enc: { k, iv, ct } } of JSON {text, html}
 *   keys                -> { publicJwk, wrappedPrivate } when a passphrase is set
 */
(function (root) {
  'use strict';

  const local = () => root.chrome.storage.local;

  // Serialise index mutations: the worker is single threaded but awaits
  // interleave, and a lost update would orphan e:<id> blobs.
  let chain = Promise.resolve();
  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  async function getSettings() {
    const { settings } = await local().get('settings');
    return Object.assign({}, root.LazarusHeuristics.DEFAULT_SETTINGS, settings || {});
  }

  async function setSettings(patch) {
    const current = await getSettings();
    const next = Object.assign({}, current, patch);
    await local().set({ settings: next });
    return next;
  }

  async function getIndex() {
    const { index } = await local().get('index');
    return index || [];
  }

  async function getKeys() {
    const { keys } = await local().get('keys');
    return keys || null;
  }

  async function setKeys(keys) {
    if (keys) await local().set({ keys });
    else await local().remove('keys');
  }

  async function getEntry(id) {
    const key = 'e:' + id;
    const got = await local().get(key);
    if (!(key in got)) throw new Error('Lazarus: no stored entry with id ' + id);
    return got[key];
  }

  // Insert or replace an entry and its index row.
  function putEntry(entry) {
    return withLock(async () => {
      const index = await getIndex();
      const row = {
        id: entry.id,
        host: entry.host,
        origin: entry.origin,
        fieldKey: entry.fieldKey,
        pageLoadId: entry.pageLoadId,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        len: entry.len,
        enc: Boolean(entry.enc)
      };
      const i = index.findIndex((r) => r.id === entry.id);
      if (i >= 0) index[i] = row; else index.push(row);
      await local().set({ index, ['e:' + entry.id]: entry });
    });
  }

  function removeEntries(ids) {
    const set = new Set(ids);
    return withLock(async () => {
      const index = await getIndex();
      const kept = index.filter((r) => !set.has(r.id));
      await local().set({ index: kept });
      await local().remove([...set].map((id) => 'e:' + id));
      return kept;
    });
  }

  // Drop the oldest rows above `max`, and anything older than `olderThan`.
  function prune({ max, olderThan }) {
    return withLock(async () => {
      const index = await getIndex();
      const sorted = index.slice().sort((a, b) => b.updatedAt - a.updatedAt);
      const drop = [];
      sorted.forEach((r, i) => {
        if (i >= max || r.updatedAt < olderThan) drop.push(r.id);
      });
      if (drop.length === 0) return 0;
      const dropSet = new Set(drop);
      await local().set({ index: index.filter((r) => !dropSet.has(r.id)) });
      await local().remove(drop.map((id) => 'e:' + id));
      return drop.length;
    });
  }

  function clearAllEntries() {
    return withLock(async () => {
      const index = await getIndex();
      await local().remove(index.map((r) => 'e:' + r.id).concat(['index']));
      return index.length;
    });
  }

  const api = {
    withLock,
    getSettings,
    setSettings,
    getIndex,
    getKeys,
    setKeys,
    getEntry,
    putEntry,
    removeEntries,
    prune,
    clearAllEntries
  };

  root.LazarusStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
