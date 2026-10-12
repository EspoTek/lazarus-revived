const test = require('node:test');
const assert = require('node:assert/strict');

// Minimal in-memory stand-in for chrome.storage.local.
function fakeChromeStorage() {
  const data = new Map();
  return {
    storage: {
      local: {
        async get(keys) {
          const list = keys === undefined ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (data.has(k)) out[k] = structuredClone(data.get(k));
          return out;
        },
        async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v)); },
        async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k); }
      }
    },
    _data: data
  };
}

globalThis.chrome = fakeChromeStorage();
require('../lib/heuristics.js');
const S = require('../lib/store.js');

function entry(id, host, updatedAt) {
  return { id, host, origin: 'https://' + host, fieldKey: 'k' + id, pageLoadId: 'p', createdAt: updatedAt, updatedAt, len: 5, text: 'hello' };
}

test('settings merge over defaults', async () => {
  const s = await S.getSettings();
  assert.equal(s.retentionDays, 7);
  await S.setSettings({ retentionDays: 30 });
  const s2 = await S.getSettings();
  assert.equal(s2.retentionDays, 30);
  assert.equal(s2.maxEntries, 500);
});

test('put / get / remove / prune / clear', async () => {
  await S.putEntry(entry('a', 'x.com', 100));
  await S.putEntry(entry('b', 'x.com', 200));
  await S.putEntry(entry('c', 'y.com', 300));
  assert.equal((await S.getIndex()).length, 3);
  assert.equal((await S.getEntry('a')).text, 'hello');
  await assert.rejects(S.getEntry('nope'), /no stored entry/);

  // Replacing keeps a single index row.
  await S.putEntry(Object.assign(entry('a', 'x.com', 150), { text: 'changed' }));
  assert.equal((await S.getIndex()).length, 3);
  assert.equal((await S.getEntry('a')).text, 'changed');

  await S.removeEntries(['b']);
  assert.equal((await S.getIndex()).map((r) => r.id).sort().join(), 'a,c');
  assert.equal(chrome._data.has('e:b'), false);

  // Age prune drops a (150 < 200), max prune keeps newest.
  assert.equal(await S.prune({ max: 10, olderThan: 200 }), 1);
  await S.putEntry(entry('d', 'z.com', 400));
  await S.putEntry(entry('e', 'z.com', 500));
  assert.equal(await S.prune({ max: 2, olderThan: 0 }), 1);
  assert.equal((await S.getIndex()).map((r) => r.id).sort().join(), 'd,e');

  assert.equal(await S.clearAllEntries(), 2);
  assert.equal((await S.getIndex()).length, 0);
  assert.equal(chrome._data.has('e:d'), false);
});

test('concurrent puts do not lose index rows', async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => S.putEntry(entry('c' + i, 'x.com', i))));
  assert.equal((await S.getIndex()).length, 20);
});
