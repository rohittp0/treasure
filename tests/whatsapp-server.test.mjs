import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { normalizePhone, maskPhone } = require('./whatsapp/phone.js');
const { safeName, dailyMessage, otpMessage } = require('./whatsapp/messages.js');
const { isStopMessage, validSignature } = require('./whatsapp/webhooks.js');
const otp = require('./whatsapp/otp.js');
const send = require('./whatsapp/send.js');

test('phone numbers normalise to E.164 and invalid ones are rejected', () => {
  assert.equal(normalizePhone('+91 90202 77399'), '+919020277399');
  assert.equal(normalizePhone('090202-77399'), '+919020277399'); // Defaults to India.
  assert.equal(normalizePhone('whatsapp:+919020277399'), '+919020277399');
  assert.equal(normalizePhone('+1 (415) 555-2671'), '+14155552671');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  for (const bad of ['', '12345', '+91 12', 'not a number', null, undefined, 919020277399, '+'.padEnd(40, '9')])
    assert.equal(normalizePhone(bad), null, String(bad));
});

test('phone numbers are masked for logs', () => {
  assert.equal(maskPhone('+919020277399'), '+91******7399');
  assert.equal(maskPhone('whatsapp:+14155552671'), '+1******2671');
  assert.equal(maskPhone(''), '****');
});

test('safeName strips control whitespace, caps length and falls back to explorer', () => {
  assert.equal(safeName('mapfinder'), 'mapfinder');
  assert.equal(safeName('a\nb\tc\r\nd'), 'a b c d');
  assert.equal(safeName('x'.repeat(80)).length, 60);
  assert.equal(safeName('  lots     of   space  '), 'lots of space');
  assert.equal(safeName(''), 'explorer');
  assert.equal(safeName(undefined), 'explorer');
  assert.equal(safeName('\n\t'), 'explorer');
});

test('template messages carry only the approved variables', () => {
  const daily = dailyMessage({ from: 'whatsapp:+1', contentSid: 'HXd', phone: '+919020277399', username: 'maya\n', statusCallback: 'https://cb' });
  assert.deepEqual(daily, { from: 'whatsapp:+1', to: 'whatsapp:+919020277399', contentSid: 'HXd', contentVariables: '{"1":"maya"}', statusCallback: 'https://cb' });
  const code = otpMessage({ from: 'whatsapp:+1', contentSid: 'HXo', phone: '+919020277399', code: '012345' });
  assert.equal(code.contentVariables, '{"1":"012345"}');
  assert.equal('body' in code, false);
  assert.throws(() => otpMessage({ from: 'f', contentSid: 'c', phone: '+1', code: '12ab' }));
});

test('STOP keywords match trimmed and case-insensitive', () => {
  for (const text of ['STOP', ' stop ', 'Unsubscribe', 'CANCEL', 'Stop promotions', 'stop   PROMOTIONS'])
    assert.equal(isStopMessage(text), true, text);
  for (const text of ['stop it', 'please stop', 'start', '', undefined, 'STOPP'])
    assert.equal(isStopMessage(text), false, String(text));
});

test('codes are six digits and only their HMAC is comparable', () => {
  for (let index = 0; index < 50; index += 1) assert.match(otp.generateCode(), /^\d{6}$/);
  const hash = otp.hashCode('key', '+919020277399', 'login', '123456');
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash.includes('123456'), false);
  assert.equal(otp.codesMatch(hash, otp.hashCode('key', '+919020277399', 'login', '123456')), true);
  assert.equal(otp.codesMatch(hash, otp.hashCode('key', '+919020277399', 'login', '123457')), false);
  assert.equal(otp.codesMatch(hash, otp.hashCode('other', '+919020277399', 'login', '123456')), false);
  assert.equal(otp.codesMatch(hash, otp.hashCode('key', '+919020277399', 'verify_phone', '123456')), false);
  assert.equal(otp.codesMatch(hash, 'zz'), false);
  assert.notEqual(otp.challengeId('+919020277399', 'login'), otp.challengeId('+919020277399', 'verify_phone'));
});

test('codes expire after exactly ten minutes', () => {
  assert.equal(otp.CODE_TTL_MS, 10 * 60_000);
  const sent = new Date('2026-11-09T10:00:00Z');
  const challenge = { expiresAt: new Date(sent.getTime() + otp.CODE_TTL_MS) };
  assert.equal(otp.isExpired(challenge, new Date('2026-11-09T10:09:59Z')), false);
  assert.equal(otp.isExpired(challenge, new Date('2026-11-09T10:10:00Z')), true);
  assert.equal(otp.isExpired({ expiresAt: { toMillis: () => sent.getTime() } }, sent), true);
  assert.equal(otp.isExpired({}, sent), true);
});

const runs = day => [0, 4, 8, 12, 16, 20].map(hour => new Date(`${day}T${String(hour).padStart(2, '0')}:05:00Z`));

test('each time zone lands in exactly one of the six daily runs, DST included', () => {
  const zones = ['Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Adelaide', 'Pacific/Kiritimati', 'Pacific/Honolulu',
    'America/New_York', 'America/St_Johns', 'Europe/London', 'Australia/Sydney', 'UTC', 'Pacific/Chatham'];
  for (const day of ['2026-01-15', '2026-07-15', '2026-11-09'])
    for (const zone of zones)
      assert.equal(runs(day).filter(run => send.inSendWindow(zone, run)).length, 1, `${zone} on ${day}`);
});

test('the send window is local 08:00–12:00', () => {
  assert.equal(send.inSendWindow('Asia/Kolkata', new Date('2026-11-09T00:05:00Z')), false); // 05:35
  assert.equal(send.inSendWindow('Asia/Kolkata', new Date('2026-11-09T04:05:00Z')), true); // 09:35
  assert.equal(send.inSendWindow('America/New_York', new Date('2026-07-01T12:05:00Z')), true); // 08:05 EDT
  assert.equal(send.inSendWindow('America/New_York', new Date('2026-12-01T12:05:00Z')), false); // 07:05 EST
  assert.equal(send.inSendWindow('America/New_York', new Date('2026-12-01T16:05:00Z')), true); // 11:05 EST
  assert.equal(send.localHour('Asia/Kolkata', new Date('2026-11-09T18:35:00Z')), 0);
});

test('missing or invalid time zones fall back by country code', () => {
  assert.equal(send.resolveTimeZone({ timeZone: 'Europe/Paris', phone: '+919020277399' }), 'Europe/Paris');
  assert.equal(send.resolveTimeZone({ timeZone: 'Not/AZone', phone: '+919020277399' }), 'Asia/Kolkata');
  assert.equal(send.resolveTimeZone({ phone: '+14155552671' }), 'UTC');
  assert.equal(send.resolveTimeZone({ timeZone: 42 }), 'UTC');
});

test('webhook signatures are checked against the canonical URL first', () => {
  const calls = [];
  const validateRequest = (token, signature, url, params) => { calls.push(url); return url === 'https://canonical/whatsappStatus'; };
  const request = { headers: { 'x-twilio-signature': 'sig' }, body: { A: '1' }, get(name) { return { 'x-twilio-signature': 'sig', host: 'other.run.app' }[name]; }, originalUrl: '/' };
  assert.equal(validSignature({ validateRequest, authToken: 't', request, canonicalUrl: 'https://canonical/whatsappStatus' }), true);
  assert.equal(validSignature({ validateRequest, authToken: 't', request: { ...request, get: () => undefined, headers: {} }, canonicalUrl: 'https://canonical/whatsappStatus' }), false);
  assert.equal(validSignature({ validateRequest: () => false, authToken: 't', request, canonicalUrl: 'https://canonical/x' }), false);
  assert.equal(calls[0], 'https://canonical/whatsappStatus');
});
