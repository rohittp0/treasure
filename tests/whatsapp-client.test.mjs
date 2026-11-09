import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, maskPhone, whatsappPromptEligible, otpErrorMessage, otpErrorReason, formatCountdown, countryOptions, PROMPT_SNOOZE_MS } from '../src/whatsapp.js';

test('phone numbers normalise to E.164 with +91 as the default country', () => {
  assert.equal(normalizePhone('9020277399'), '+919020277399');
  assert.equal(normalizePhone('090202 77399'), '+919020277399');
  assert.equal(normalizePhone('+91 90202-77399'), '+919020277399');
  assert.equal(normalizePhone('+44 7911 123456'), '+447911123456');
  assert.equal(normalizePhone('7911 123456', 'GB'), '+447911123456');
  assert.equal(normalizePhone('+1 415 555 2671', 'IN'), '+14155552671');
  for (const bad of ['', '12345', 'not a number', '+91 12', null, undefined, '9'.repeat(50)]) assert.equal(normalizePhone(bad), '');
});

test('masked numbers keep only the calling code and last four digits', () => {
  assert.equal(maskPhone('+919020277399'), '+91******7399');
  assert.equal(maskPhone('+14155552671'), '+1******2671');
  assert.equal(maskPhone('+447911123456'), '+44******3456');
  assert.equal(maskPhone('9020277399'), '');
  assert.equal(maskPhone(undefined), '');
});

test('the post-quest prompt respects sign-in, opt-in, opt-out and the 7-day snooze', () => {
  const now = Date.UTC(2026, 10, 9, 12);
  const base = { signedIn: true, username: 'scout', whatsapp: null, snoozedAt: null, now };
  assert.equal(whatsappPromptEligible(base), true);
  assert.equal(whatsappPromptEligible({ ...base, signedIn: false }), false);
  assert.equal(whatsappPromptEligible({ ...base, username: '' }), false);
  assert.equal(whatsappPromptEligible({ ...base, whatsapp: { phone: '+919020277399', verifiedAt: 1, optIn: true } }), false);
  assert.equal(whatsappPromptEligible({ ...base, whatsapp: { phone: '+919020277399', verifiedAt: 1, optIn: false } }), true);
  assert.equal(whatsappPromptEligible({ ...base, whatsapp: { optIn: false, optOutAt: { toMillis: () => now - 1 } } }), false);
  assert.equal(whatsappPromptEligible({ ...base, snoozedAt: now - PROMPT_SNOOZE_MS + 60_000 }), false);
  assert.equal(whatsappPromptEligible({ ...base, snoozedAt: now - PROMPT_SNOOZE_MS }), true);
  assert.equal(whatsappPromptEligible({ ...base, snoozedAt: new Date(now - 1000) }), false);
});

test('callable errors map to clear copy and privacy-safe reasons', () => {
  const error = (code, details) => Object.assign(new Error('x'), { code: `functions/${code}`, details });
  assert.match(otpErrorMessage(error('deadline-exceeded')), /expired/);
  assert.match(otpErrorMessage(error('permission-denied', { attemptsLeft: 2 })), /2 tries left/);
  assert.match(otpErrorMessage(error('permission-denied', { attemptsLeft: 1 })), /1 try left/);
  assert.match(otpErrorMessage(error('resource-exhausted'), 'verify'), /Too many wrong tries/);
  assert.match(otpErrorMessage(error('resource-exhausted', { resendAfter: 42 }), 'request'), /wait 42 seconds/);
  assert.match(otpErrorMessage(error('resource-exhausted'), 'request'), /too many codes today/);
  assert.equal(otpErrorMessage(error('already-exists')), 'This number is linked to another explorer. Sign in with WhatsApp to use that account.');
  assert.match(otpErrorMessage(error('invalid-argument'), 'request'), /valid WhatsApp number/);
  assert.match(otpErrorMessage(new Error('network')), /Something went wrong/);
  assert.equal(otpErrorReason(error('resource-exhausted', { resendAfter: 5 }), 'request'), 'cooldown');
  assert.equal(otpErrorReason(error('resource-exhausted'), 'verify'), 'too_many_attempts');
  assert.equal(otpErrorReason(error('not-found')), 'no_code');
  assert.equal(otpErrorReason({ code: 'internal' }), 'other');
  assert.equal(otpErrorReason(error('unavailable'), 'request'), 'send_failed');
  assert.match(otpErrorMessage(error('unavailable'), 'request'), /Couldn't send the code right now/);
});

test('countdowns and the country picker are ready for the verify form', () => {
  assert.equal(formatCountdown(60), '1:00');
  assert.equal(formatCountdown(9.2), '0:10');
  assert.equal(formatCountdown(-3), '0:00');
  const options = countryOptions();
  assert.equal(options[0].code, 'IN');
  assert.equal(options[0].callingCode, '91');
  assert.ok(options.some(option => option.code === 'GB' && option.callingCode === '44'));
});
