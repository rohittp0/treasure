#!/usr/bin/env node
// Sends one real WhatsApp template message through Twilio, for a manual end-to-end check.
//
//   node scripts/send-test-whatsapp.mjs +919020277399 maya          # daily_quest_alert
//   node scripts/send-test-whatsapp.mjs +919020277399 --otp         # hunch_otp with a random code
//
// Credentials come from functions/.secret.local (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) and the sender and
// Content SIDs from functions/.env.treasurehunch. Secret values are never printed.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const functionsDir = new URL('../functions/', import.meta.url);
const require = createRequire(new URL('package.json', functionsDir));
const twilio = require('twilio');
const { normalizePhone, maskPhone } = require('./whatsapp/phone.js');
const { dailyMessage, otpMessage } = require('./whatsapp/messages.js');
const { generateCode } = require('./whatsapp/otp.js');

function readEnv(file) {
  const values = {};
  for (const line of readFileSync(new URL(file, functionsDir), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const otp = args.includes('--otp');
const [rawPhone, name] = args.filter(arg => arg !== '--otp');
if (!rawPhone || (!otp && !name)) fail('Usage: node scripts/send-test-whatsapp.mjs <E.164 phone> <name>\n       node scripts/send-test-whatsapp.mjs <E.164 phone> --otp');
const phone = normalizePhone(rawPhone);
if (!phone) fail('That is not a valid phone number. Use E.164, for example +919020277399.');

const secrets = readEnv('.secret.local');
const params = readEnv('.env.treasurehunch');
if (!secrets.TWILIO_ACCOUNT_SID || !secrets.TWILIO_AUTH_TOKEN || secrets.TWILIO_AUTH_TOKEN === 'PASTE_AUTH_TOKEN_HERE')
  fail('Fill in TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in functions/.secret.local first.');
for (const key of ['WHATSAPP_FROM', otp ? 'WHATSAPP_OTP_CONTENT_SID' : 'WHATSAPP_DAILY_CONTENT_SID'])
  if (!params[key]) fail(`Set ${key} in functions/.env.treasurehunch.`);

const message = otp
  ? otpMessage({ from: params.WHATSAPP_FROM, contentSid: params.WHATSAPP_OTP_CONTENT_SID, phone, code: generateCode() })
  : dailyMessage({ from: params.WHATSAPP_FROM, contentSid: params.WHATSAPP_DAILY_CONTENT_SID, phone, username: name });

try {
  const client = twilio(secrets.TWILIO_ACCOUNT_SID, secrets.TWILIO_AUTH_TOKEN);
  const result = await client.messages.create(message);
  console.log(`Sent ${otp ? 'hunch_otp (code ' + JSON.parse(message.contentVariables)[1] + ')' : 'daily_quest_alert'} to ${maskPhone(phone)}: ${result.sid} (${result.status}).`);
} catch (error) {
  fail(`Twilio refused the message: ${error.code || ''} ${error.message || error}`.trim());
}
