import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, maskPhone, whatsappPromptEligible, otpErrorMessage, otpErrorReason, formatCountdown, countryOptions,
  detectCountry, countryFromNumber, loadStoredCountry, storeCountry, COUNTRY_STORAGE_KEY } from '../src/whatsapp.js';
import { countryForTimeZone } from '../src/timezone-countries.js';

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

test('the result card respects sign-in, opt-in, opt-out and a snooze until the next UTC day', () => {
  const now = Date.UTC(2026, 10, 9, 12);
  const base = { signedIn: true, username: 'scout', whatsapp: null, snoozedAt: null, now };
  assert.equal(whatsappPromptEligible(base), true);
  assert.equal(whatsappPromptEligible({ ...base, signedIn: false }), false);
  assert.equal(whatsappPromptEligible({ ...base, username: '' }), false);
  assert.equal(whatsappPromptEligible({ ...base, whatsapp: { phone: '+919020277399', verifiedAt: 1, optIn: true } }), false);
  assert.equal(whatsappPromptEligible({ ...base, whatsapp: { phone: '+919020277399', verifiedAt: 1, optIn: false } }), true);
  assert.equal(whatsappPromptEligible({ ...base, whatsapp: { optIn: false, optOutAt: { toMillis: () => now - 1 } } }), false);
  // Snoozed earlier the same UTC day, in any of the accepted timestamp shapes: still hidden.
  assert.equal(whatsappPromptEligible({ ...base, snoozedAt: Date.UTC(2026, 10, 9, 0, 0, 1) }), false);
  assert.equal(whatsappPromptEligible({ ...base, snoozedAt: new Date(now - 1000) }), false);
  assert.equal(whatsappPromptEligible({ ...base, snoozedAt: { toMillis: () => now - 1000 } }), false);
  // Snoozed late yesterday (UTC): the next daily quest has started, so it shows again.
  assert.equal(whatsappPromptEligible({ ...base, snoozedAt: Date.UTC(2026, 10, 8, 23, 59, 59) }), true);
  assert.equal(whatsappPromptEligible({ ...base, now: Date.UTC(2026, 10, 10, 0, 0, 1), snoozedAt: now }), true);
  // A server time slightly ahead of this device's clock still counts as snoozed.
  assert.equal(whatsappPromptEligible({ ...base, now: Date.UTC(2026, 10, 9, 23, 59, 59), snoozedAt: Date.UTC(2026, 10, 10, 0, 0, 5) }), false);
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

test('the picker defaults to the last pick, then the time zone, then the browser language, then India', () => {
  assert.equal(detectCountry({ stored: 'GB', timeZone: 'Asia/Kolkata', languages: ['en-US'] }), 'GB');
  assert.equal(detectCountry({ timeZone: 'Asia/Kolkata', languages: [] }), 'IN');
  assert.equal(detectCountry({ timeZone: 'Asia/Calcutta', languages: [] }), 'IN');
  assert.equal(detectCountry({ timeZone: 'America/Chicago', languages: ['en-GB'] }), 'US');
  assert.equal(detectCountry({ timeZone: 'Europe/London', languages: [] }), 'GB');
  assert.equal(detectCountry({ timeZone: 'UTC', languages: ['en-GB'] }), 'GB');
  assert.equal(detectCountry({ timeZone: 'UTC', languages: ['en'] }), 'IN');
  assert.equal(detectCountry({ timeZone: 'UTC', languages: ['es-419', 'pt-BR'] }), 'BR');
  assert.equal(detectCountry({ stored: 'XX', timeZone: 'Europe/London' }), 'GB');
  assert.equal(detectCountry({ stored: 'gb', timeZone: '', languages: [] }), 'IN');
  assert.equal(detectCountry({ timeZone: 42, languages: 'nope' }), 'IN');
  assert.ok(detectCountry({ timeZone: undefined }).length === 2);
  assert.ok(detectCountry().length === 2);
});

test('legacy time zone names browsers still report map to their country', () => {
  const expected = { 'Asia/Katmandu': 'NP', 'Asia/Saigon': 'VN', 'Europe/Kiev': 'UA', 'US/Eastern': 'US', 'Canada/Pacific': 'CA',
    'Australia/NSW': 'AU', 'America/Buenos_Aires': 'AR', 'Pacific/Truk': 'FM', Iceland: 'IS', Japan: 'JP', GB: 'GB', 'Asia/Istanbul': 'TR' };
  for (const [zone, country] of Object.entries(expected)) assert.equal(countryForTimeZone(zone), country, zone);
  for (const zone of ['UTC', 'Etc/GMT+5', 'EST', 'CET', '', undefined]) assert.equal(countryForTimeZone(zone), '', String(zone));
});

test('a typed international prefix picks the country for the calling code', () => {
  assert.equal(countryFromNumber('+44 7911 123456'), 'GB');
  assert.equal(countryFromNumber('0091 98765 43210'), 'IN');
  assert.equal(countryFromNumber('+91'), 'IN');
  assert.equal(countryFromNumber('+1 416 555 0123'), 'US');
  assert.equal(countryFromNumber('+1 416 555 0123', 'CA'), 'CA');
  for (const text of ['98765', '', '+', '00', '+999 1', null, undefined]) assert.equal(countryFromNumber(text), '');
});

test('the picked country is remembered only when localStorage works and the code is supported', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map();
  const setStorage = value => Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
  try {
    setStorage({ getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) });
    assert.equal(loadStoredCountry(), '');
    assert.equal(storeCountry('GB'), true);
    assert.equal(store.get(COUNTRY_STORAGE_KEY), 'GB');
    assert.equal(loadStoredCountry(), 'GB');
    assert.equal(storeCountry('XX'), false);
    store.set(COUNTRY_STORAGE_KEY, 'nope');
    assert.equal(loadStoredCountry(), '');
    setStorage({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    assert.equal(loadStoredCountry(), '');
    assert.equal(storeCountry('GB'), false);
    setStorage(undefined);
    assert.equal(loadStoredCountry(), '');
    assert.equal(storeCountry('GB'), false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});

test('the country picker can put any supported country first', () => {
  assert.equal(countryOptions('en', 'GB')[0].code, 'GB');
  assert.equal(countryOptions('en', 'XX')[0].code, 'IN');
});
