/*
 * End-to-end check: launches Chrome for Testing headless with the extension
 * loaded, types into tests/e2e/page.html through the DevTools protocol, and
 * asserts on what the service worker stored.  Run: node tests/e2e/run.js
 *
 * Env: CHROME (path to a Chromium/Chrome-for-Testing binary).
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const CHROME = process.env.CHROME;
if (!CHROME) throw new Error('Set CHROME to a Chromium / Chrome for Testing binary');
const PORT = 8765 + Math.floor(Math.random() * 1000);
const DEVTOOLS_PORT = 9800 + Math.floor(Math.random() * 1000);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- tiny static server for the test page -------------------------------
const server = http.createServer((req, res) => {
  if (req.url !== '/page.html' && req.url !== '/') {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  fs.createReadStream(path.join(__dirname, 'page.html')).pipe(res);
});

// --- minimal CDP client --------------------------------------------------
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && c.waiting.has(msg.id)) {
        const { resolve, reject } = c.waiting.get(msg.id);
        c.waiting.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else c.events.push(msg);
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result.value;
  }
  close() { this.ws.close(); }
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`);
  return res.json();
}
async function waitForTarget(pred, label) {
  for (let i = 0; i < 100; i++) {
    const t = (await targets().catch(() => [])).find(pred);
    if (t) return t;
    await sleep(200);
  }
  throw new Error('target not found: ' + label);
}

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lazarus-e2e-'));
  log('launching', CHROME);
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${DEVTOOLS_PORT}`,
    `--load-extension=${ROOT}`, `--disable-extensions-except=${ROOT}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', (d) => { stderr += d; });

  try {
    // Chrome ships component extensions with their own background.js
    // workers, so identify ours by a global it defines.
    let sw = null;
    for (let i = 0; i < 50 && !sw; i++) {
      for (const t of (await targets().catch(() => [])).filter((t) => t.type === 'service_worker')) {
        const c = await CDP.connect(t.webSocketDebuggerUrl);
        if ((await c.eval('typeof LazarusStore')) === 'object') { sw = c; log('service worker:', t.url); break; }
        c.close();
      }
      if (!sw) await sleep(300);
    }
    if (!sw) throw new Error('Lazarus service worker target not found');

    const pageTarget = await waitForTarget((t) => t.type === 'page', 'page');
    const page = await CDP.connect(pageTarget.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/page.html` });
    await sleep(1500);
    assert.equal(await page.eval('document.title'), 'Lazarus e2e page');

    // Type (trusted input events) into each field.
    async function type(selector, text) {
      await page.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await page.send('Input.insertText', { text });
    }
    log('typing');
    await type('#msg', 'Dear forum, this is a long post that I would hate to lose.');
    await type('#name', 'Ada Lovelace');
    await type('#pw', 'hunter2hunter2');
    await type('#cc', '4242424242424242');
    await type('#otp', '123456');
    await type('#notes', 'my card is 5555 5555 5555 4444 ok');
    await type('#rich', 'Rich text body here');
    await sleep(2000); // debounce + save

    const dump = async () => sw.eval('chrome.storage.local.get(null)');
    let all = await dump();
    const byLabel = (a) => Object.fromEntries(Object.values(a).filter((v) => v && v.fieldKey).map((v) => [v.fieldLabel, v]));
    let saved = byLabel(all);
    log('saved fields:', Object.keys(saved));
    assert.ok(saved['Message'], 'textarea saved');
    assert.equal(saved['Message'].text, 'Dear forum, this is a long post that I would hate to lose.');
    assert.ok(saved['Your name'], 'text input saved');
    assert.ok(saved['Rich editor'], 'contenteditable saved');
    assert.equal(saved['Rich editor'].text.trim(), 'Rich text body here');
    assert.ok(!saved['password'], 'password NOT saved');
    assert.ok(!saved['payment'], 'cc-number NOT saved');
    assert.ok(!saved['otp_code'], 'otp NOT saved');
    assert.ok(!saved['notes'], 'text containing a card number NOT saved');
    assert.equal(all.index.length, 3);

    // Typing more into the same field updates the same entry.
    await type('#msg', ' More text.');
    await sleep(2000);
    all = await dump();
    saved = byLabel(all);
    assert.equal(all.index.length, 3, 'same page-load => same entry');
    assert.match(saved['Message'].text, / More text\.$/);

    // Restore: wipe the textarea, then ask the worker to restore into the focused field.
    log('restore');
    await page.eval(`(() => { const t = document.querySelector('#msg'); t.value = ''; t.focus(); return t.value; })()`);
    await sleep(300);
    // No "tabs" permission by design, so tab URLs are invisible to the worker;
    // the focus record the content script sent carries the tab id instead.
    const tabId = await sw.eval('chrome.storage.session.get(null).then(all => Number(Object.keys(all).find(k => k.startsWith("focus:")).slice(6)))');
    assert.ok(Number.isInteger(tabId), 'focus record exists for the tab');
    await sw.eval(`handleMessage({ type: 'restore', id: ${JSON.stringify(saved['Message'].id)}, tabId: ${tabId} }, {})`);
    assert.equal(await page.eval(`document.querySelector('#msg').value`), saved['Message'].text);

    // Context menu rebuild for the focused field must not throw.
    await sw.eval(`rebuildMenu({ frameId: 0, host: '127.0.0.1', origin: 'http://127.0.0.1:${PORT}', fieldKey: ${JSON.stringify(saved['Message'].fieldKey)} })`);

    // Encryption: set passphrase, verify ciphertext at rest, lock/unlock, decrypt.
    log('passphrase');
    assert.equal(await sw.eval(`handleMessage({ type: 'setPassphrase', passphrase: 'correct horse' }, {})`), true);
    all = await dump();
    for (const row of all.index) {
      const e = all['e:' + row.id];
      assert.ok(e.enc && e.enc.ct, 'entry encrypted');
      assert.equal(e.text, undefined, 'no plaintext at rest');
    }
    assert.ok(all.keys.publicJwk && all.keys.wrappedPrivate);
    let status = await sw.eval(`handleMessage({ type: 'status' }, {})`);
    assert.equal(status.locked, false);
    await sw.eval(`handleMessage({ type: 'lock' }, {})`);
    status = await sw.eval(`handleMessage({ type: 'status' }, {})`);
    assert.equal(status.locked, true);
    let list = await sw.eval(`handleMessage({ type: 'list', host: '127.0.0.1' }, {})`);
    assert.ok(list.every((r) => r.text === null), 'locked list hides text');

    // Saving while locked still works (public-key encryption).
    await type('#name', ' Byron');
    await sleep(2000);
    all = await dump();
    assert.equal(all.index.length, 3);

    assert.equal(await sw.eval(`handleMessage({ type: 'unlock', passphrase: 'wrong' }, {})`), false);
    assert.equal(await sw.eval(`handleMessage({ type: 'unlock', passphrase: 'correct horse' }, {})`), true);
    list = await sw.eval(`handleMessage({ type: 'list', host: '127.0.0.1' }, {})`);
    assert.ok(list.some((r) => r.text === 'Ada Lovelace Byron'), 'edit made while locked decrypts after unlock');

    // Remove passphrase: back to plaintext.
    assert.equal(await sw.eval(`handleMessage({ type: 'removePassphrase', passphrase: 'correct horse' }, {})`), true);
    all = await dump();
    assert.equal(all.keys, undefined);
    assert.ok(Object.values(all).filter((v) => v && v.fieldKey).every((v) => typeof v.text === 'string'));

    // Blocklist: host blocked => nothing new saved.
    log('blocklist');
    await sw.eval(`handleMessage({ type: 'setSettings', patch: { blockedHosts: ['127.0.0.1'] } }, {})`);
    await sleep(300);
    await type('#name', ' Blocked');
    await sleep(2000);
    all = await dump();
    assert.ok(!Object.values(all).some((v) => v && v.text && v.text.includes('Blocked')), 'blocked host not saved');

    // Clear all.
    await sw.eval(`handleMessage({ type: 'clearAll' }, {})`);
    all = await dump();
    assert.equal((all.index || []).length, 0);
    assert.ok(!Object.keys(all).some((k) => k.startsWith('e:')));

    log('ALL E2E CHECKS PASSED');
    sw.close(); page.close();
  } finally {
    chrome.kill('SIGKILL');
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
    if (process.exitCode) console.error(stderr.slice(-2000));
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
