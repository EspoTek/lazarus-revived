/*
 * Pure, dependency-free helpers shared by the content script, the service
 * worker and the Node test-suite. Loaded as a classic script everywhere
 * (content_scripts list, importScripts, <script src>) and exported for Node
 * via the module.exports tail.
 */
(function (root) {
  'use strict';

  // Input types whose values are worth saving.
  const SAVEABLE_INPUT_TYPES = new Set([
    '', 'text', 'search', 'email', 'url', 'tel', 'number'
  ]);

  // autocomplete tokens that always mark a field as sensitive.
  const SENSITIVE_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-.*)$/;

  // Fragments in name/id/label/placeholder that indicate a secret or a
  // financial / government identifier. False positives only mean "not
  // saved", so err on the side of matching.
  const SENSITIVE_WORDS = new RegExp([
    'passw', 'passcode', '\\bpwd\\b', 'secret', '\\btoken\\b', '\\botp\\b', 'one.?time',
    'verification.?code', 'security.?code', 'auth.?code', 'confirmation.?code',
    '\\bcvv\\b', '\\bcvc\\b', '\\bcvn\\b', '\\bcsc\\b', 'card.?num', 'cardnumber',
    'credit.?card', 'ccnum', '\\bcc[-_]', '\\bpan\\b', '\\biban\\b', '\\bswift\\b', '\\bbic\\b',
    'routing', 'account.?num', 'acct.?num', '\\bssn\\b', 'social.?security', 'tax.?id',
    '\\btfn\\b', 'national.?id', 'passport', '\\bpin\\b', '\\bmfa\\b', '\\b2fa\\b', '\\btotp\\b',
    'authenticator', 'licen[cs]e.?num', 'medicare', 'driver.?licen'
  ].join('|'), 'i');

  function isSensitiveAttributeText(text) {
    if (!text) return false;
    const raw = String(text);
    // "otp_code" / "card-number": treat separators as word boundaries too.
    const spaced = raw.replace(/[_\-.]+/g, ' ');
    return SENSITIVE_WORDS.test(raw) || SENSITIVE_WORDS.test(spaced);
  }

  function isSensitiveAutocomplete(value) {
    if (!value) return false;
    // autocomplete may carry several tokens, e.g. "section-blue shipping cc-number".
    return String(value).toLowerCase().split(/\s+/).some((t) => SENSITIVE_AUTOCOMPLETE.test(t));
  }

  // Luhn check on a digit string.
  function luhnValid(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = digits.charCodeAt(i) - 48;
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  // True when the text contains something that looks like a payment card
  // number: 13-19 digits, optionally separated by spaces or dashes, that pass
  // the Luhn check.
  function containsCardNumber(text) {
    if (!text) return false;
    const re = /(?:\d[ -]?){12,18}\d/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const digits = m[0].replace(/[ -]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return true;
      // Overlapping windows: step back so a longer run can also be tried shorter.
      re.lastIndex = m.index + 1;
    }
    return false;
  }

  // Blocklist pattern matching. "example.com" blocks the host and every
  // subdomain; "*.example.com" blocks only subdomains; "sub.example.com"
  // blocks that host and its subdomains too.
  function hostMatchesPattern(host, pattern) {
    host = String(host || '').toLowerCase();
    pattern = String(pattern || '').trim().toLowerCase();
    if (!host || !pattern) return false;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".example.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern || host.endsWith('.' + pattern);
  }

  function hostIsBlocked(host, patterns) {
    return (patterns || []).some((p) => hostMatchesPattern(host, p));
  }

  function parseBlocklist(text) {
    return String(text || '')
      .split(/[\n,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && !s.startsWith('#'));
  }

  // Short single-line preview of a saved text.
  function preview(text, max) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  function timeAgo(ts, now) {
    now = now || Date.now();
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    const d = Math.round(h / 24);
    return d + 'd ago';
  }

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    retentionDays: 7,
    maxEntries: 500,
    maxTextLength: 200000,
    minTextLength: 3,
    skipSensitiveFields: true,
    skipCardNumbers: true,
    respectAutocompleteOff: false,
    saveContentEditable: true,
    saveInIncognito: false,
    blockedHosts: [
      'accounts.google.com',
      'login.microsoftonline.com',
      'login.live.com',
      'appleid.apple.com',
      'signin.aws.amazon.com',
      'id.atlassian.com',
      'auth.openai.com'
    ]
  });

  const api = {
    SAVEABLE_INPUT_TYPES,
    DEFAULT_SETTINGS,
    isSensitiveAttributeText,
    isSensitiveAutocomplete,
    luhnValid,
    containsCardNumber,
    hostMatchesPattern,
    hostIsBlocked,
    parseBlocklist,
    preview,
    timeAgo
  };

  root.LazarusHeuristics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
