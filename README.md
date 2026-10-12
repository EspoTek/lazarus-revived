# Lazarus Revived — form recovery for Chrome

Remember [Lazarus: Form Recovery](https://addons.mozilla.org/en-US/firefox/addon/lazarus-form-recovery/)?
You'd write a long forum post, hit submit, the session had expired, and the text
was gone — unless Lazarus had quietly saved it as you typed. This is that, rebuilt
as a Manifest V3 Chrome extension with no dependencies, no build step, and no
network access at all.

## What it does

- **Saves as you type.** Text inputs, textareas and rich-text editors
  (`contenteditable`) in every frame of every page are snapshotted ~¾ s after you
  stop typing (and at least every 5 s while you keep going). Leaving the page
  flushes immediately.
- **Right-click to recover.** Right-click any text field → **Lazarus: Recover text**
  → pick a snapshot. Entries for the same field are listed first (marked ●).
  Restores go through the browser's own editing commands so React/Vue/ProseMirror
  style editors see them as real input.
- **Toolbar popup.** Browse, search, expand, copy, restore or delete snapshots for
  the current site (or all sites). The badge shows how many snapshots exist for the
  site you're on. One click pauses saving on the current site for good.
- **Expiry.** Snapshots live for 7 days by default (max 500), then are swept hourly.

## Security limits (all adjustable in Options)

| Limit | Default |
| --- | --- |
| `type=password` fields | never saved, cannot be turned on |
| Fields whose name / id / label / placeholder / `autocomplete` look like secrets or identifiers (card number, CVV, one-time code, SSN/TFN, IBAN, PIN, token, passport, MFA…) | skipped |
| Text containing a Luhn-valid 13–19 digit payment-card number | skipped |
| Fields Chrome just autofilled | skipped |
| Incognito windows | skipped (even if you enable the extension there) |
| Sites on the block list (ships with a few login portals; add your bank) | skipped |
| `autocomplete="off"` | honoured only if you turn that on — far too many ordinary sites set it |
| Query strings | never stored, only origin + path |
| Per-entry size | 200 000 characters |
| Retention | 7 days, 500 entries |
| Page-level opt-out | a `data-lazarus-ignore` attribute on the field |

Everything stays in the extension's local storage on your machine. The only
permissions requested are `storage`, `unlimitedStorage`, `contextMenus` and
`alarms`, plus content scripts on http/https pages. There is no host permission
for reading tab URLs; the content script tells the worker what site it's on.

### Optional passphrase (Lazarus-style hybrid encryption)

Without a passphrase, snapshots are stored in the clear, with the same protection
as Chrome's own history and autofill (your OS user account). If you set a
passphrase in Options:

- An RSA-2048 key pair is generated. The public key is kept in the clear; the
  private key is wrapped with AES-256-GCM under a PBKDF2-SHA256 key
  (310 000 iterations) derived from your passphrase.
- Each snapshot is encrypted with a fresh AES-256-GCM key, wrapped to the public
  key. **Saving keeps working while locked**, exactly like the original Lazarus;
  only reading/restoring needs the passphrase.
- The unlocked private key lives in `chrome.storage.session` (memory only) until
  you lock it or close the browser.
- There is no recovery path if you forget the passphrase.

## Install

Lazarus Revived is not on the Chrome Web Store, so it is loaded as an unpacked
extension. It works in Chrome, Edge, Brave, Vivaldi and other Chromium browsers.

### From a release (recommended)

1. Download `lazarus-revived-<version>.zip` from the
   [latest release](https://github.com/EspoTek/lazarus-revived/releases/latest)
   and unzip it somewhere permanent (Chrome loads the files from that folder
   every time it starts, so don't delete it afterwards).
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder.
5. Pin the icon from the puzzle-piece menu if you like. Visit any page with a
   form and start typing; the badge counts snapshots for the current site.

To update, download the new zip, unzip it over the same folder, and click the
reload arrow on the extension's card. Your saved text and settings are kept.

Optional: to save on `file://` pages, enable *Allow access to file URLs* on the
extension's card. To use it in Incognito you must both allow it there and turn
on *Save in Incognito windows* in Options.

### From source

```
git clone https://github.com/EspoTek/lazarus-revived.git
```

then **Load unpacked** on the cloned folder, as above. `scripts/package.sh`
builds the same zip the releases ship.

## Layout

```
manifest.json         MV3 manifest
background.js         service worker: storage, keys, context menu, badge, expiry
content.js            per-frame capture + restore
lib/heuristics.js     sensitivity rules, Luhn, blocklist matching (shared, tested)
lib/crypto.js         RSA-OAEP + AES-GCM hybrid encryption (shared, tested)
lib/store.js          chrome.storage.local layout + index (shared, tested)
popup/                toolbar popup, also opens as a full tab (?full=1)
options/              settings, block list, passphrase, export, clear
tests/*.test.js       node --test unit tests (pure logic, Web Crypto round-trips)
tests/e2e/run.js      headless Chrome-for-Testing end-to-end check
scripts/make_icons.py icon generator (uv run --with pillow)
```

## Tests

```
npm test                                # unit tests
CHROME="/path/to/Google Chrome for Testing" node tests/e2e/run.js   # end to end
```

The e2e run needs a Chromium build that still honours `--load-extension`
(Chrome for Testing, Chromium, or a Playwright/Puppeteer download). Branded
Google Chrome 137+ ignores that flag.
