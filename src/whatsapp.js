// Pure helpers for the WhatsApp daily quest alert: phone numbers, masking, prompt rules and error copy.
import { parsePhoneNumberFromString, getCountries, getCountryCallingCode, AsYouType, Metadata } from 'libphonenumber-js';
import { countryForTimeZone } from './timezone-countries.js';

export const DEFAULT_COUNTRY = 'IN';
export const COUNTRY_STORAGE_KEY = 'treasurehunch.whatsappCountry';
export const PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
export const CONSENT_COPY = 'Send me the TreasureHunch daily quest on WhatsApp. Reply STOP anytime to unsubscribe.';

// Returns the E.164 form of a number typed with or without its country code, or '' if it is not valid.
export function normalizePhone(raw, country = DEFAULT_COUNTRY) {
  const text = String(raw ?? '').trim();
  if (!text || text.length > 40) return '';
  const parsed = parsePhoneNumberFromString(text, text.startsWith('+') ? undefined : country);
  return parsed?.isValid() ? parsed.number : '';
}

// +919020277399 → +91******7399. Keeps the calling code and the last four digits only.
export function maskPhone(phone) {
  const text = String(phone ?? '');
  if (!/^\+\d{6,15}$/.test(text)) return '';
  const parsed = parsePhoneNumberFromString(text);
  const code = parsed ? `+${parsed.countryCallingCode}` : text.slice(0, 3);
  const rest = text.slice(code.length);
  return `${code}${'*'.repeat(Math.max(0, rest.length - 4))}${rest.slice(-4)}`;
}

// Country choices for the calling-code picker, sorted by name with the given country first.
export function countryOptions(locale = 'en', first = DEFAULT_COUNTRY) {
  let names = null;
  try { names = new Intl.DisplayNames([locale], { type: 'region' }); } catch { /* Fall back to ISO codes. */ }
  const top = isSupportedCountry(first) ? first : DEFAULT_COUNTRY;
  const options = getCountries().map(code => ({ code, name: names?.of(code) || code, callingCode: getCountryCallingCode(code) }));
  options.sort((a, b) => (b.code === top) - (a.code === top) || a.name.localeCompare(b.name));
  return options;
}

let supported = null;
export function isSupportedCountry(code) {
  supported ??= new Set(getCountries());
  return typeof code === 'string' && supported.has(code);
}

function browserLanguages() {
  try {
    if (typeof navigator === 'undefined' || !navigator) return [];
    if (Array.isArray(navigator.languages) && navigator.languages.length) return navigator.languages;
    return navigator.language ? [navigator.language] : [];
  } catch {
    return [];
  }
}

// The region subtag of a BCP 47 tag ('en-GB' → 'GB', 'zh-Hant-TW' → 'TW'), or '' for none or a numeric region ('es-419').
function languageRegion(tag) {
  if (typeof tag !== 'string') return '';
  const region = tag.split(/[-_]/).slice(1).find(part => /^[A-Za-z]{2}$/.test(part));
  return region ? region.toUpperCase() : '';
}

// Best guess at the explorer's country for the calling-code picker: last pick, then time zone, then browser language, then India.
export function detectCountry({ stored, timeZone, languages } = {}) {
  if (isSupportedCountry(stored)) return stored;
  const zoneCountry = countryForTimeZone(timeZone === undefined ? browserTimeZone() : timeZone);
  if (isSupportedCountry(zoneCountry)) return zoneCountry;
  const tags = languages === undefined ? browserLanguages() : languages;
  for (const tag of Array.isArray(tags) ? tags : [tags]) {
    const region = languageRegion(tag);
    if (isSupportedCountry(region)) return region;
  }
  return DEFAULT_COUNTRY;
}

export function loadStoredCountry() {
  try {
    const code = globalThis.localStorage?.getItem(COUNTRY_STORAGE_KEY);
    return isSupportedCountry(code) ? code : '';
  } catch {
    return '';
  }
}

export function storeCountry(code) {
  if (!isSupportedCountry(code)) return false;
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(COUNTRY_STORAGE_KEY, code);
    return true;
  } catch {
    return false;
  }
}

let callingCodeCountries = null;
const countriesForCallingCode = code => {
  try { callingCodeCountries ??= new Metadata().countryCallingCodes(); } catch { callingCodeCountries = {}; }
  return (callingCodeCountries[code] || []).filter(isSupportedCountry);
};

// The country of a number typed with its international prefix ('+44 …' or '0044 …'), or '' if it cannot tell yet.
// Calling codes shared by several countries (+1, +44, +7) keep `current` when it already has that code, otherwise
// give the code's main country (US, GB, RU): libphonenumber would call +44 7911 123456 Guernsey, which is not what a
// British explorer expects to see in the picker.
export function countryFromNumber(raw, current = '') {
  let text = String(raw ?? '').trim();
  if (!text || text.length > 40) return '';
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  else if (!text.startsWith('+')) return '';
  try {
    const parsed = parsePhoneNumberFromString(text);
    let callingCode = parsed?.countryCallingCode;
    if (!callingCode) {
      const typing = new AsYouType();
      typing.input(text);
      callingCode = typing.getCallingCode();
    }
    const countries = callingCode ? countriesForCallingCode(callingCode) : [];
    if (!countries.length) return '';
    if (countries.includes(current)) return current;
    return countries[0];
  } catch {
    return '';
  }
}

export function browserTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.length <= 64 ? zone : '';
  } catch {
    return '';
  }
}

const millis = value => typeof value === 'number' ? value : value?.toMillis?.() ?? (value instanceof Date ? value.getTime() : null);

// Whether to offer the post-quest WhatsApp prompt. Explorers who opted out are never asked again.
export function whatsappPromptEligible({ signedIn, username, whatsapp, snoozedAt, now = Date.now() }) {
  if (!signedIn || !username) return false;
  if (whatsapp?.optIn === true || whatsapp?.optOutAt) return false;
  const snoozed = millis(snoozedAt);
  return !(Number.isFinite(snoozed) && now - snoozed < PROMPT_SNOOZE_MS);
}

export const isVerified = whatsapp => !!whatsapp?.phone && !!whatsapp?.verifiedAt;

const codeOf = error => String(error?.code || '').replace(/^functions\//, '');

// A short analytics reason for a failed request or verification. Never includes the number or code.
export function otpErrorReason(error, step = 'verify') {
  const code = codeOf(error);
  if (code === 'invalid-argument') return 'invalid_number';
  if (code === 'resource-exhausted') return step === 'request' ? (Number.isFinite(error?.details?.resendAfter) ? 'cooldown' : 'daily_limit') : 'too_many_attempts';
  if (code === 'deadline-exceeded') return 'expired';
  if (code === 'not-found') return 'no_code';
  if (code === 'permission-denied') return 'wrong_code';
  if (code === 'already-exists') return 'number_taken';
  if (code === 'unauthenticated' || code === 'failed-precondition') return 'account_mismatch';
  if (code === 'unavailable') return 'send_failed';
  return 'other';
}

export function otpErrorMessage(error, step = 'verify') {
  const reason = otpErrorReason(error, step);
  if (reason === 'invalid_number') return 'Enter a valid WhatsApp number, including the country code.';
  if (reason === 'cooldown') {
    const seconds = Math.max(1, Math.ceil(error.details.resendAfter));
    return `Please wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} before asking for another code.`;
  }
  if (reason === 'daily_limit') return "You've asked for too many codes today. Try again tomorrow.";
  if (reason === 'too_many_attempts') return 'Too many wrong tries. Ask for a new code.';
  if (reason === 'expired') return 'That code has expired. Ask for a new one.';
  if (reason === 'no_code') return 'That code has expired or was already used. Ask for a new one.';
  if (reason === 'wrong_code') {
    const left = error?.details?.attemptsLeft;
    return Number.isFinite(left)
      ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
      : "That code isn't right. Check it and try again.";
  }
  if (reason === 'number_taken') return 'This number is linked to another explorer. Sign in with WhatsApp to use that account.';
  if (reason === 'send_failed') return "Couldn't send the code right now. Try again shortly.";
  if (reason === 'account_mismatch') return 'This code was asked for from a different account. Ask for a new one.';
  return 'Something went wrong. Please try again.';
}

export function formatCountdown(seconds) {
  const value = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
