// Phone numbers are always kept in E.164 (+919020277399). Only masked numbers are ever logged.
const { parsePhoneNumberFromString } = require('libphonenumber-js');

function normalizePhone(input, defaultCountry = 'IN') {
  if (typeof input !== 'string' || input.length > 32) return null;
  const raw = input.trim().replace(/^whatsapp:/i, '');
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, raw.startsWith('+') ? undefined : defaultCountry);
  return parsed && parsed.isValid() ? parsed.number : null;
}

// +919020277399 → +91******7399
function maskPhone(phone) {
  const value = String(phone || '').replace(/^whatsapp:/i, '');
  if (value.length < 7) return '****';
  const parsed = parsePhoneNumberFromString(value);
  const prefix = parsed ? `+${parsed.countryCallingCode}` : value.slice(0, 3);
  const last = value.slice(-4);
  return `${prefix}${'*'.repeat(Math.max(2, value.length - prefix.length - 4))}${last}`;
}

module.exports = { normalizePhone, maskPhone };
