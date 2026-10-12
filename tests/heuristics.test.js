const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/heuristics.js');

test('sensitive attribute words', () => {
  const yes = ['password', 'confirm_password', 'cardNumber', 'card-number', 'cvv', 'cc-csc', 'otp_code', 'one-time code',
    'verification code', 'ssn', 'tax id', 'TFN', 'iban', 'pin', 'routing_number', 'account number', 'Passport number',
    'mfa-token', 'secret_key', 'Driver licence number'];
  for (const s of yes) assert.equal(H.isSensitiveAttributeText(s), true, s);
  const no = ['email', 'username', 'comment', 'body', 'message', 'shipping_address', 'japan', 'company', 'q', 'title',
    'spanish', 'account_name', 'bio', 'description', 'search'];
  for (const s of no) assert.equal(H.isSensitiveAttributeText(s), false, s);
});

test('sensitive autocomplete tokens', () => {
  assert.equal(H.isSensitiveAutocomplete('current-password'), true);
  assert.equal(H.isSensitiveAutocomplete('section-blue shipping cc-number'), true);
  assert.equal(H.isSensitiveAutocomplete('one-time-code'), true);
  assert.equal(H.isSensitiveAutocomplete('email'), false);
  assert.equal(H.isSensitiveAutocomplete('off'), false);
  assert.equal(H.isSensitiveAutocomplete(null), false);
});

test('luhn / card numbers', () => {
  assert.equal(H.luhnValid('4242424242424242'), true);
  assert.equal(H.luhnValid('4242424242424241'), false);
  assert.equal(H.containsCardNumber('pay with 4242 4242 4242 4242 please'), true);
  assert.equal(H.containsCardNumber('card: 5555-5555-5555-4444'), true);
  assert.equal(H.containsCardNumber('my phone is 0412345678'), false);
  assert.equal(H.containsCardNumber('order 1234567890123 shipped'), false); // fails luhn
  assert.equal(H.containsCardNumber('just a normal message'), false);
  assert.equal(H.containsCardNumber(''), false);
});

test('host blocklist matching', () => {
  assert.equal(H.hostMatchesPattern('example.com', 'example.com'), true);
  assert.equal(H.hostMatchesPattern('www.example.com', 'example.com'), true);
  assert.equal(H.hostMatchesPattern('notexample.com', 'example.com'), false);
  assert.equal(H.hostMatchesPattern('example.com', '*.example.com'), false);
  assert.equal(H.hostMatchesPattern('a.example.com', '*.example.com'), true);
  assert.equal(H.hostMatchesPattern('EXAMPLE.com', 'example.com'), true);
  assert.equal(H.hostIsBlocked('accounts.google.com', H.DEFAULT_SETTINGS.blockedHosts), true);
  assert.equal(H.hostIsBlocked('mail.google.com', H.DEFAULT_SETTINGS.blockedHosts), false);
});

test('parseBlocklist', () => {
  assert.deepEqual(H.parseBlocklist(' a.com\n# comment\n\nB.com, c.com '), ['a.com', 'b.com', 'c.com']);
});

test('preview and timeAgo', () => {
  assert.equal(H.preview('  hello\n\n  world  ', 40), 'hello world');
  assert.equal(H.preview('abcdefghij', 5), 'abcd…');
  const now = 1_000_000_000_000;
  assert.equal(H.timeAgo(now - 10_000, now), 'just now');
  assert.equal(H.timeAgo(now - 5 * 60_000, now), '5m ago');
  assert.equal(H.timeAgo(now - 3 * 3600_000, now), '3h ago');
  assert.equal(H.timeAgo(now - 5 * 86400_000, now), '5d ago');
});
