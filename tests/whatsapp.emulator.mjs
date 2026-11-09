// WhatsApp OTP, daily send loop and webhooks against the Firestore emulator, with Twilio and Firebase Auth mocked.
// Run with: npm run test:functions
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { createOtpHandlers } = require('./whatsapp/otp.js');
const { sendDailyWhatsApp } = require('./whatsapp/send.js');
const { createWebhookHandlers } = require('./whatsapp/webhooks.js');

const projectId = 'demo-treasure-friend-tests';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with the Firestore emulator: npm run test:functions');
initializeApp({ projectId });
const db = getFirestore();

// The parts of the Admin Auth API the OTP flow uses. Custom tokens carry the uid like real ones.
const auth = {
  users: new Map(),
  async createUser({ uid }) {
    await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
    if (this.users.has(uid)) throw Object.assign(new Error('exists'), { code: 'auth/uid-already-exists' });
    this.users.set(uid, { uid });
    return { uid };
  },
  async deleteUser(uid) { this.users.delete(uid); },
  async getUser(uid) {
    if (!this.users.has(uid)) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' });
    return this.users.get(uid);
  },
  async listUsers() { return { users: [...this.users.values()] }; },
  async createCustomToken(uid) {
    const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'none' })}.${part({ uid })}.`;
  },
};
const silent = { log() {}, error() {} };
const params = { from: 'whatsapp:+12296143014', dailyContentSid: 'HXdaily', otpContentSid: 'HXotp' };
const PHONE = '+919020277399';
const OTHER_PHONE = '+14155552671';

async function reset() {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  auth.users.clear();
}

function mockTwilio({ failures = {} } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(message) {
        calls.push(message);
        const failure = failures[message.to];
        if (failure) throw Object.assign(new Error('Twilio error'), { code: failure });
        return { sid: `SM${String(calls.length).padStart(32, '0')}`, status: 'queued' };
      },
    },
    lastCode() { return JSON.parse(calls.at(-1).contentVariables)[1]; },
  };
}

function setup(start = '2026-11-09T10:00:00Z') {
  const clock = { now: new Date(start) };
  const twilio = mockTwilio();
  const handlers = createOtpHandlers({ db, auth, twilio, hmacKey: 'test-hmac-key', params, clock: () => clock.now, log: silent });
  const advance = seconds => { clock.now = new Date(clock.now.getTime() + seconds * 1000); };
  return { clock, twilio, handlers, advance };
}

async function rejectsWith(promise, code) {
  try { await promise; } catch (error) { assert.equal(error.code, code, error.message); return error; }
  assert.fail(`Expected ${code}`);
}

const tokenUid = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).uid;

test('verify_phone: happy path links the number and the code works once', async () => {
  await reset();
  const { twilio, handlers } = setup();
  const sent = await handlers.requestOtp({ phone: '+91 90202 77399', purpose: 'verify_phone' }, { uid: 'alice' });
  assert.deepEqual(sent, { ok: true, resendAfter: 60 });
  assert.equal(twilio.calls.length, 1);
  assert.equal(twilio.calls[0].contentSid, 'HXotp');
  assert.equal(twilio.calls[0].to, `whatsapp:${PHONE}`);
  const code = twilio.lastCode();
  const challenges = await db.collection('otpChallenges').get();
  assert.equal(challenges.size, 1);
  assert.equal(JSON.stringify(challenges.docs[0].data()).includes(code), false, 'the plain code is never stored');
  assert.equal(challenges.docs[0].data().uid, 'alice');

  assert.deepEqual(await handlers.verifyOtp({ phone: PHONE, purpose: 'verify_phone', code }, { uid: 'alice' }), { ok: true, phone: PHONE });
  const user = (await db.doc('users/alice').get()).data();
  assert.equal(user.whatsapp.phone, PHONE);
  assert.ok(user.whatsapp.verifiedAt);
  assert.equal((await db.doc(`whatsappPhones/${PHONE}`).get()).data().uid, 'alice');
  assert.equal((await db.collection('otpChallenges').get()).size, 0);
  await rejectsWith(handlers.verifyOtp({ phone: PHONE, purpose: 'verify_phone', code }, { uid: 'alice' }), 'not-found');
});

test('verify_phone: needs the signed-in explorer who asked for the code', async () => {
  await reset();
  const { twilio, handlers } = setup();
  await rejectsWith(handlers.requestOtp({ phone: PHONE, purpose: 'verify_phone' }, {}), 'unauthenticated');
  await handlers.requestOtp({ phone: PHONE, purpose: 'verify_phone' }, { uid: 'alice' });
  const code = twilio.lastCode();
  await rejectsWith(handlers.verifyOtp({ phone: PHONE, purpose: 'verify_phone', code }, {}), 'unauthenticated');
  await rejectsWith(handlers.verifyOtp({ phone: PHONE, purpose: 'verify_phone', code }, { uid: 'mallory' }), 'failed-precondition');
  await handlers.verifyOtp({ phone: PHONE, purpose: 'verify_phone', code }, { uid: 'alice' });
});

test('verify_phone: a number owned by another explorer is refused', async () => {
  await reset();
  const { twilio, handlers, advance } = setup();
  await handlers.requestOtp({ phone: PHONE, purpose: 'verify_phone' }, { uid: 'alice' });
  await handlers.verifyOtp({ phone: PHONE, purpose: 'verify_phone', code: twilio.lastCode() }, { uid: 'alice' });
  advance(61);
  await handlers.requestOtp({ phone: PHONE, purpose: 'verify_phone' }, { uid: 'bob' });
  await rejectsWith(handlers.verifyOtp({ phone: PHONE, purpose: 'verify_phone', code: twilio.lastCode() }, { uid: 'bob' }), 'already-exists');
  assert.equal((await db.doc(`whatsappPhones/${PHONE}`).get()).data().uid, 'alice');
  assert.equal((await db.doc('users/bob').get()).exists, false);
});

test('verify_phone: changing the number releases the old one and resets consent', async () => {
  await reset();
  const { twilio, handlers } = setup();
  await handlers.requestOtp({ phone: PHONE, purpose: 'verify_phone' }, { uid: 'alice' });
  await handlers.verifyOtp({ phone: PHONE, purpose: 'verify_phone', code: twilio.lastCode() }, { uid: 'alice' });
  await db.doc('users/alice').update({ 'whatsapp.optIn': true });
  await handlers.requestOtp({ phone: OTHER_PHONE, purpose: 'verify_phone' }, { uid: 'alice' });
  await handlers.verifyOtp({ phone: OTHER_PHONE, purpose: 'verify_phone', code: twilio.lastCode() }, { uid: 'alice' });
  const user = (await db.doc('users/alice').get()).data();
  assert.equal(user.whatsapp.phone, OTHER_PHONE);
  assert.equal(user.whatsapp.optIn, false);
  assert.equal((await db.doc(`whatsappPhones/${PHONE}`).get()).exists, false);
  assert.equal((await db.doc(`whatsappPhones/${OTHER_PHONE}`).get()).data().uid, 'alice');
});

test('login: an unknown number creates one explorer, a known number signs them back in', async () => {
  await reset();
  const { twilio, handlers, advance } = setup();
  await handlers.requestOtp({ phone: PHONE, purpose: 'login' }, { ip: '203.0.113.9' });
  const first = await handlers.verifyOtp({ phone: PHONE, purpose: 'login', code: twilio.lastCode() }, { ip: '203.0.113.9' });
  assert.equal(first.isNew, true);
  const uid = tokenUid(first.customToken);
  assert.ok((await auth.getUser(uid)).uid);
  const user = (await db.doc(`users/${uid}`).get()).data();
  assert.equal(user.whatsapp.phone, PHONE);
  assert.equal(user.whatsapp.optIn, false, 'signing in is never opt-in');
  assert.equal((await db.doc(`whatsappPhones/${PHONE}`).get()).data().uid, uid);

  advance(61);
  await handlers.requestOtp({ phone: PHONE, purpose: 'login' }, { ip: '203.0.113.9' });
  const second = await handlers.verifyOtp({ phone: PHONE, purpose: 'login', code: twilio.lastCode() }, {});
  assert.deepEqual([second.isNew, tokenUid(second.customToken)], [false, uid]);
  assert.equal((await auth.listUsers()).users.length, 1);
});

test('login: a number verified by a Google explorer signs in to that explorer', async () => {
  await reset();
  const { twilio, handlers, advance } = setup();
  await handlers.requestOtp({ phone: PHONE, purpose: 'verify_phone' }, { uid: 'alice' });
  await handlers.verifyOtp({ phone: PHONE, purpose: 'verify_phone', code: twilio.lastCode() }, { uid: 'alice' });
  advance(61);
  await handlers.requestOtp({ phone: PHONE, purpose: 'login' }, {});
  const result = await handlers.verifyOtp({ phone: PHONE, purpose: 'login', code: twilio.lastCode() }, {});
  assert.deepEqual([result.isNew, tokenUid(result.customToken)], [false, 'alice']);
});

test('login: racing sign-ins for a new number end with one explorer', async () => {
  await reset();
  const { handlers } = setup();
  const results = await Promise.all(Array.from({ length: 5 }, () => handlers.signInWithPhone(PHONE)));
  assert.equal(new Set(results.map(result => result.uid)).size, 1);
  assert.equal(results.filter(result => result.isNew).length, 1);
  assert.equal((await auth.listUsers()).users.length, 1);
});

test('a wrong code counts an attempt; five wrong codes lock the challenge', async () => {
  await reset();
  const { twilio, handlers } = setup();
  await handlers.requestOtp({ phone: PHONE, purpose: 'login' }, {});
  const code = twilio.lastCode();
  const wrong = code === '000000' ? '111111' : '000000';
  const first = await rejectsWith(handlers.verifyOtp({ phone: PHONE, purpose: 'login', code: wrong }, {}), 'permission-denied');
  assert.deepEqual(first.details, { attemptsLeft: 4 });
  for (let attempt = 0; attempt < 4; attempt += 1)
    await rejectsWith(handlers.verifyOtp({ phone: PHONE, purpose: 'login', code: wrong }, {}), 'permission-denied');
  await rejectsWith(handlers.verifyOtp({ phone: PHONE, purpose: 'login', code }, {}), 'resource-exhausted');
  await rejectsWith(handlers.verifyOtp({ phone: PHONE, purpose: 'login', code: 'abc' }, {}), 'invalid-argument');
});

test('an expired code is refused', async () => {
  await reset();
  const { twilio, handlers, advance } = setup();
  await handlers.requestOtp({ phone: PHONE, purpose: 'login' }, {});
  advance(10 * 60);
  await rejectsWith(handlers.verifyOtp({ phone: PHONE, purpose: 'login', code: twilio.lastCode() }, {}), 'deadline-exceeded');
});

test('resend cooldown and daily send limits', async () => {
  await reset();
  const { twilio, handlers, advance } = setup();
  await handlers.requestOtp({ phone: PHONE, purpose: 'login' }, {});
  advance(20);
  const cooldown = await rejectsWith(handlers.requestOtp({ phone: PHONE, purpose: 'login' }, {}), 'resource-exhausted');
  assert.deepEqual(cooldown.details, { resendAfter: 40 });
  // The cooldown is per number, whatever the purpose.
  await rejectsWith(handlers.requestOtp({ phone: PHONE, purpose: 'verify_phone' }, { uid: 'alice' }), 'resource-exhausted');
  for (let send = 2; send <= 5; send += 1) {
    advance(61);
    await handlers.requestOtp({ phone: PHONE, purpose: 'login' }, {});
  }
  advance(61);
  const daily = await rejectsWith(handlers.requestOtp({ phone: PHONE, purpose: 'login' }, {}), 'resource-exhausted');
  assert.equal(daily.details, undefined);
  assert.equal(twilio.calls.length, 5);
  await rejectsWith(handlers.requestOtp({ phone: 'nope', purpose: 'login' }, {}), 'invalid-argument');
  await rejectsWith(handlers.requestOtp({ phone: PHONE, purpose: 'other' }, {}), 'invalid-argument');
});

test('at most ten codes per signed-in explorer a day', async () => {
  await reset();
  const { handlers, advance } = setup();
  const numbers = Array.from({ length: 11 }, (_, index) => `+1415555${String(2600 + index).padStart(4, '0')}`);
  for (const number of numbers.slice(0, 10)) await handlers.requestOtp({ phone: number, purpose: 'verify_phone' }, { uid: 'alice' });
  advance(61);
  await rejectsWith(handlers.requestOtp({ phone: numbers[10], purpose: 'verify_phone' }, { uid: 'alice' }), 'resource-exhausted');
});

test('a failed WhatsApp send leaves no usable challenge', async () => {
  await reset();
  const clock = new Date('2026-11-09T10:00:00Z');
  const twilio = { messages: { create: async () => { throw Object.assign(new Error('bad'), { code: 63024 }); } } };
  const handlers = createOtpHandlers({ db, auth, twilio, hmacKey: 'k', params, clock: () => clock, log: silent });
  await rejectsWith(handlers.requestOtp({ phone: PHONE, purpose: 'login' }, {}), 'unavailable');
  assert.equal((await db.collection('otpChallenges').get()).size, 0);
});

async function seedExplorer(uid, whatsapp, username = uid) {
  await db.doc(`users/${uid}`).set({ displayName: 'Explorer', ...(whatsapp ? { whatsapp } : {}) });
  await db.doc(`profiles/${uid}`).set({ username });
}

test('daily send: one message per opted-in explorer in their window, retries send nothing new', async () => {
  await reset();
  const verifiedAt = new Date('2026-11-01T00:00:00Z');
  await seedExplorer('india', { phone: PHONE, verifiedAt, optIn: true, timeZone: 'Asia/Kolkata' }, 'maya');
  await seedExplorer('indiaNoZone', { phone: '+919876543210', verifiedAt, optIn: true }, 'ravi');
  await seedExplorer('newyork', { phone: OTHER_PHONE, verifiedAt, optIn: true, timeZone: 'America/New_York' }, 'sam');
  await seedExplorer('stopped', { phone: '+919811111111', verifiedAt, optIn: true, timeZone: 'Asia/Kolkata' }, 'gone');
  await seedExplorer('notOptedIn', { phone: '+919822222222', verifiedAt, optIn: false, timeZone: 'Asia/Kolkata' });
  await seedExplorer('pushOnly', null);
  const untouched = (await db.doc('users/notOptedIn').get()).data();

  const twilio = mockTwilio({ failures: { 'whatsapp:+919811111111': 21610 } });
  const at0405 = new Date('2026-11-09T04:05:00Z'); // 09:35 in India, 23:05 in New York.
  const run = when => sendDailyWhatsApp({ db, twilio, params, statusCallback: 'https://example.test/whatsappStatus', clock: () => when, log: silent });

  const first = await run(at0405);
  assert.deepEqual(first, { sent: 2, skipped: 0, outOfWindow: 1, failed: 1 });
  const recipients = twilio.calls.map(call => call.to).sort();
  assert.deepEqual(recipients, ['whatsapp:+919811111111', 'whatsapp:+919876543210', `whatsapp:${PHONE}`].sort());
  const maya = twilio.calls.find(call => call.to === `whatsapp:${PHONE}`);
  assert.deepEqual(maya, { from: params.from, to: `whatsapp:${PHONE}`, contentSid: 'HXdaily', contentVariables: '{"1":"maya"}', statusCallback: 'https://example.test/whatsappStatus' });
  const marker = (await db.doc('dailyNotifications/2026-11-09/whatsapp/india').get()).data();
  assert.equal(marker.status, 'queued');
  assert.match(marker.sid, /^SM/);
  assert.equal((await db.doc(`whatsappMessages/${marker.sid}`).get()).data().uid, 'india');

  // 21610: the explorer opted out on WhatsApp, so their opt-in is turned off.
  const stopped = (await db.doc('users/stopped').get()).data().whatsapp;
  assert.equal(stopped.optIn, false);
  assert.ok(stopped.optOutAt);
  assert.equal((await db.doc('dailyNotifications/2026-11-09/whatsapp/stopped').get()).data().errorCode, 21610);

  // A retried run at the same time sends nothing new.
  const callsBefore = twilio.calls.length;
  assert.deepEqual(await run(new Date('2026-11-09T04:06:00Z')), { sent: 0, skipped: 2, outOfWindow: 1, failed: 0 });
  assert.equal(twilio.calls.length, callsBefore);

  // New York's run is 16:05 UTC (11:05 EST); the India explorers are outside their window then.
  assert.deepEqual(await run(new Date('2026-11-09T16:05:00Z')), { sent: 1, skipped: 0, outOfWindow: 2, failed: 0 });
  assert.equal(twilio.calls.at(-1).to, `whatsapp:${OTHER_PHONE}`);

  assert.equal(twilio.calls.some(call => ['whatsapp:+919822222222'].includes(call.to)), false);
  assert.deepEqual((await db.doc('users/notOptedIn').get()).data(), untouched);
  assert.equal((await db.doc('dailyNotifications/2026-11-09/whatsapp/notOptedIn').get()).exists, false);
  assert.equal((await db.doc('dailyNotifications/2026-11-09/whatsapp/pushOnly').get()).exists, false);
});

function fakeResponse() {
  return {
    statusCode: 200, body: undefined, contentType: undefined,
    status(code) { this.statusCode = code; return this; },
    type(value) { this.contentType = value; return this; },
    send(body) { this.body = body; return this; },
  };
}

function fakeRequest(body, signature = 'valid') {
  const headers = { 'x-twilio-signature': signature, host: 'example.test' };
  return { method: 'POST', body, headers, originalUrl: '/', get: name => headers[name.toLowerCase()] };
}

test('webhooks: STOP replies and failed deliveries opt the explorer out; bad signatures are refused', async () => {
  await reset();
  const verifiedAt = new Date('2026-11-01T00:00:00Z');
  await seedExplorer('alice', { phone: PHONE, verifiedAt, optIn: true, timeZone: 'Asia/Kolkata' });
  await db.doc(`whatsappPhones/${PHONE}`).set({ uid: 'alice' });
  await seedExplorer('bob', { phone: OTHER_PHONE, verifiedAt, optIn: true, timeZone: 'UTC' });
  await db.doc('dailyNotifications/2026-11-09/whatsapp/bob').set({ uid: 'bob', sid: 'SMbob00000000', status: 'queued' });
  await db.doc('whatsappMessages/SMbob00000000').set({ marker: 'dailyNotifications/2026-11-09/whatsapp/bob', uid: 'bob' });

  const validateRequest = (token, signature) => token === 'token' && signature === 'valid';
  const webhooks = createWebhookHandlers({ db, validateRequest, authToken: 'token', urls: { inbound: 'https://x/whatsappInbound', status: 'https://x/whatsappStatus' }, log: silent });

  const forged = fakeResponse();
  await webhooks.inbound(fakeRequest({ From: `whatsapp:${PHONE}`, Body: 'STOP' }, 'forged'), forged);
  assert.equal(forged.statusCode, 403);
  assert.equal((await db.doc('users/alice').get()).data().whatsapp.optIn, true);

  const chat = fakeResponse();
  await webhooks.inbound(fakeRequest({ From: `whatsapp:${PHONE}`, Body: 'when is the next quest?' }), chat);
  assert.equal((await db.doc('users/alice').get()).data().whatsapp.optIn, true);

  const stop = fakeResponse();
  await webhooks.inbound(fakeRequest({ From: `whatsapp:${PHONE}`, Body: '  Stop promotions ' }), stop);
  assert.equal(stop.contentType, 'text/xml');
  assert.equal(stop.body, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const alice = (await db.doc('users/alice').get()).data().whatsapp;
  assert.equal(alice.optIn, false);
  assert.ok(alice.optOutAt);
  assert.equal(alice.phone, PHONE, 'the verified number is kept for sign-in');

  const delivered = fakeResponse();
  await webhooks.status(fakeRequest({ MessageSid: 'SMbob00000000', MessageStatus: 'undelivered', ErrorCode: '63024' }), delivered);
  assert.equal(delivered.statusCode, 200);
  const marker = (await db.doc('dailyNotifications/2026-11-09/whatsapp/bob').get()).data();
  assert.deepEqual([marker.status, marker.errorCode], ['undelivered', 63024]);
  assert.equal((await db.doc('users/bob').get()).data().whatsapp.optIn, false);

  const unknown = fakeResponse();
  await webhooks.status(fakeRequest({ MessageSid: 'SMunknown0000', MessageStatus: 'sent' }), unknown);
  assert.equal(unknown.statusCode, 200);
});
