// One-time codes sent on WhatsApp, shared by phone verification and WhatsApp sign-in.
// Only an HMAC of each code is stored; the plain code exists only in memory and in the message.
const crypto = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { normalizePhone, maskPhone } = require('./phone');
const { otpMessage } = require('./messages');

const PURPOSES = ['verify_phone', 'login'];
const CODE_TTL_MS = 10 * 60_000; // Must match the hunch_otp template footer: "expires in 10 minutes".
const RESEND_COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_PHONE_PER_DAY = 5;
const MAX_SENDS_PER_REQUESTER_PER_DAY = 10;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const utcDay = date => date.toISOString().slice(0, 10);
const millis = value => value?.toMillis?.() ?? (value instanceof Date ? value.getTime() : Number(value) || 0);

const generateCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const challengeId = (phone, purpose) => sha256(phone + purpose);
// Binding the phone and purpose into the HMAC means a hash is useless for any other challenge.
const hashCode = (key, phone, purpose, code) =>
  crypto.createHmac('sha256', key).update(`${phone}|${purpose}|${code}`).digest('hex');

function codesMatch(expectedHash, actualHash) {
  const expected = Buffer.from(String(expectedHash), 'hex');
  const actual = Buffer.from(String(actualHash), 'hex');
  return expected.length === 32 && actual.length === 32 && crypto.timingSafeEqual(expected, actual);
}

const isExpired = (challenge, now) => !challenge?.expiresAt || millis(challenge.expiresAt) <= now.getTime();

function checkedInput(data) {
  const purpose = data?.purpose;
  if (!PURPOSES.includes(purpose)) throw new HttpsError('invalid-argument', 'Unknown code purpose.');
  const phone = normalizePhone(data?.phone);
  if (!phone) throw new HttpsError('invalid-argument', 'Enter a valid WhatsApp number with its country code.');
  return { phone, purpose };
}

// Daily send counters, server-only. Keys never contain a raw phone number or IP address.
const rateLimitRef = (db, kind, id, day) => db.doc(`otpRateLimits/${kind}_${id}_${day}`);

function createOtpHandlers({ db, auth, twilio, hmacKey, params, clock = () => new Date(), log = console }) {
  async function requestOtp(data, context = {}) {
    const { phone, purpose } = checkedInput(data);
    const uid = context.uid || null;
    if (purpose === 'verify_phone' && !uid) throw new HttpsError('unauthenticated', 'Sign in to verify your number.');
    const now = clock();
    const day = utcDay(now);
    const requester = uid ? ['uid', uid] : ['ip', sha256(String(context.ip || 'unknown'))];
    const phoneLimit = rateLimitRef(db, 'phone', sha256(phone), day);
    const requesterLimit = rateLimitRef(db, requester[0], requester[1], day);
    const challengeRef = db.doc(`otpChallenges/${challengeId(phone, purpose)}`);
    const code = generateCode();

    await db.runTransaction(async transaction => {
      const [phoneSnap, requesterSnap, challengeSnap] = await Promise.all([
        transaction.get(phoneLimit), transaction.get(requesterLimit), transaction.get(challengeRef)]);
      const lastSentAt = Math.max(millis(phoneSnap.data()?.lastSentAt), millis(challengeSnap.data()?.lastSentAt));
      const wait = lastSentAt + RESEND_COOLDOWN_MS - now.getTime();
      if (wait > 0) {
        const resendAfter = Math.ceil(wait / 1000);
        throw new HttpsError('resource-exhausted', `Wait ${resendAfter} seconds before asking for another code.`, { resendAfter });
      }
      const phoneSends = phoneSnap.data()?.count || 0;
      const requesterSends = requesterSnap.data()?.count || 0;
      if (phoneSends >= MAX_SENDS_PER_PHONE_PER_DAY || requesterSends >= MAX_SENDS_PER_REQUESTER_PER_DAY)
        throw new HttpsError('resource-exhausted', 'Too many codes today. Try again tomorrow.');
      const expiresAt = new Date(now.getTime() + 2 * 86_400_000); // For a Firestore TTL policy.
      transaction.set(phoneLimit, { count: phoneSends + 1, lastSentAt: now, expiresAt });
      transaction.set(requesterLimit, { count: requesterSends + 1, lastSentAt: now, expiresAt });
      const previous = challengeSnap.data();
      transaction.set(challengeRef, {
        codeHash: hashCode(hmacKey, phone, purpose, code),
        purpose,
        uid: purpose === 'login' ? null : uid,
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
        attempts: 0,
        lastSentAt: now,
        sendsToday: previous?.sendsDay === day ? (previous.sendsToday || 0) + 1 : 1,
        sendsDay: day,
      });
    });

    try {
      await twilio.messages.create(otpMessage({ from: params.from, contentSid: params.otpContentSid, phone, code }));
    } catch (error) {
      await challengeRef.delete().catch(() => {});
      // Twilio error messages can contain the full number, so only the code is logged.
      log.error(`WhatsApp code to ${maskPhone(phone)} failed: Twilio error ${error.code || 'unknown'}.`);
      throw new HttpsError('unavailable', 'The code could not be sent on WhatsApp. Check the number and try again.');
    }
    return { ok: true, resendAfter: RESEND_COOLDOWN_MS / 1000 };
  }

  // Counts the attempt, then compares. A matching code is deleted in the same transaction, so it works once.
  async function consumeChallenge(phone, purpose, code, uid) {
    const challengeRef = db.doc(`otpChallenges/${challengeId(phone, purpose)}`);
    const now = clock();
    const outcome = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(challengeRef);
      const challenge = snapshot.data();
      if (!snapshot.exists || challenge.purpose !== purpose) return { error: 'not-found' };
      if (isExpired(challenge, now)) return { error: 'deadline-exceeded' };
      if ((challenge.attempts || 0) >= MAX_ATTEMPTS) return { error: 'resource-exhausted' };
      if (purpose === 'verify_phone' && challenge.uid !== uid) return { error: 'failed-precondition' };
      const attempts = (challenge.attempts || 0) + 1;
      const match = codesMatch(challenge.codeHash, hashCode(hmacKey, phone, purpose, code));
      if (match) transaction.delete(challengeRef);
      else transaction.update(challengeRef, { attempts });
      return { match, attemptsLeft: MAX_ATTEMPTS - attempts };
    });
    const messages = {
      'not-found': 'Ask for a new code.',
      'deadline-exceeded': 'This code has expired. Ask for a new one.',
      'resource-exhausted': 'Too many wrong codes. Ask for a new one.',
      'failed-precondition': 'This code was requested by another explorer.',
    };
    if (outcome.error) throw new HttpsError(outcome.error, messages[outcome.error]);
    if (!outcome.match) throw new HttpsError('permission-denied', 'That code is not right.', { attemptsLeft: outcome.attemptsLeft });
  }

  async function linkPhone(uid, phone) {
    const now = clock();
    const phoneRef = db.doc(`whatsappPhones/${phone}`);
    const userRef = db.doc(`users/${uid}`);
    await db.runTransaction(async transaction => {
      const [owner, user] = await Promise.all([transaction.get(phoneRef), transaction.get(userRef)]);
      if (owner.exists && owner.data().uid !== uid)
        throw new HttpsError('already-exists', 'This number belongs to another explorer. Sign in with WhatsApp to use that account.');
      const previous = user.data()?.whatsapp || {};
      if (previous.phone && previous.phone !== phone) {
        const oldRef = db.doc(`whatsappPhones/${previous.phone}`);
        const old = await transaction.get(oldRef);
        if (old.exists && old.data().uid === uid) transaction.delete(oldRef);
      }
      transaction.set(phoneRef, { uid, claimedAt: now });
      const whatsapp = { phone, verifiedAt: now };
      // Consent belongs to a number: a new number starts opted out until the explorer confirms again.
      if (previous.phone && previous.phone !== phone) whatsapp.optIn = false;
      transaction.set(userRef, { whatsapp }, { merge: true });
    });
  }

  // Signs in the explorer who owns the number, or creates a new explorer for an unknown number.
  async function signInWithPhone(phone) {
    const phoneRef = db.doc(`whatsappPhones/${phone}`);
    const existing = await phoneRef.get();
    if (existing.exists) return { uid: existing.data().uid, isNew: false };
    const newUid = db.collection('users').doc().id;
    await auth.createUser({ uid: newUid });
    const now = clock();
    let winner;
    try {
      winner = await db.runTransaction(async transaction => {
        const owner = await transaction.get(phoneRef);
        if (owner.exists) return owner.data().uid;
        transaction.set(phoneRef, { uid: newUid, claimedAt: now });
        transaction.set(db.doc(`users/${newUid}`), {
          whatsapp: { phone, verifiedAt: now, optIn: false },
          createdAt: now,
        }, { merge: true });
        return newUid;
      });
    } catch (error) {
      await auth.deleteUser(newUid).catch(() => {});
      throw error;
    }
    // Another request claimed the number first: keep one account and drop the one made here.
    if (winner !== newUid) {
      await auth.deleteUser(newUid).catch(() => {});
      return { uid: winner, isNew: false };
    }
    return { uid: newUid, isNew: true };
  }

  async function verifyOtp(data, context = {}) {
    const { phone, purpose } = checkedInput(data);
    const code = typeof data?.code === 'string' ? data.code.trim() : '';
    if (!/^\d{6}$/.test(code)) throw new HttpsError('invalid-argument', 'Enter the 6-digit code.');
    const uid = context.uid || null;
    if (purpose === 'verify_phone' && !uid) throw new HttpsError('unauthenticated', 'Sign in to verify your number.');
    await consumeChallenge(phone, purpose, code, uid);
    if (purpose === 'verify_phone') {
      await linkPhone(uid, phone);
      return { ok: true, phone };
    }
    const account = await signInWithPhone(phone);
    return { customToken: await auth.createCustomToken(account.uid), isNew: account.isNew };
  }

  return { requestOtp, verifyOtp, signInWithPhone };
}

module.exports = {
  PURPOSES, CODE_TTL_MS, RESEND_COOLDOWN_MS, MAX_ATTEMPTS, MAX_SENDS_PER_PHONE_PER_DAY, MAX_SENDS_PER_REQUESTER_PER_DAY,
  generateCode, challengeId, hashCode, codesMatch, isExpired, createOtpHandlers,
};
