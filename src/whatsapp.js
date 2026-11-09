// Pure helpers for the WhatsApp daily quest alert: phone numbers, masking, prompt rules and error copy.
import { parsePhoneNumberFromString, getCountries, getCountryCallingCode } from 'libphonenumber-js';

export const DEFAULT_COUNTRY = 'IN';
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

// Country choices for the calling-code picker, sorted by name with the default first.
export function countryOptions(locale = 'en') {
  let names = null;
  try { names = new Intl.DisplayNames([locale], { type: 'region' }); } catch { /* Fall back to ISO codes. */ }
  const options = getCountries().map(code => ({ code, name: names?.of(code) || code, callingCode: getCountryCallingCode(code) }));
  options.sort((a, b) => (b.code === DEFAULT_COUNTRY) - (a.code === DEFAULT_COUNTRY) || a.name.localeCompare(b.name));
  return options;
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
