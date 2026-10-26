const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret, defineString } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();

const resendKey = defineSecret('RESEND_API_KEY');
const emailFrom = defineString('CHALLENGE_EMAIL_FROM');
const huntUrl = code => `https://hunch.rohittp.com/?hunt=${encodeURIComponent(code)}`;

async function checkedChallenge(event) {
  const { recipientUid, code } = event.params;
  const notification = event.data?.data();
  if (!notification || notification.code !== code || !/^[A-HJ-NP-Z2-9]{10}$/.test(code)) return null;
  const hunt = (await getFirestore().doc(`friendHunts/${code}`).get()).data();
  if (!hunt || hunt.targetUid !== recipientUid || hunt.hiderUid !== notification.fromUid ||
      hunt.targetUsername == null || !/^[a-z][a-z0-9_]{2,19}$/.test(notification.fromUsername)) return null;
  return { recipientUid, code, notification };
}

async function claimDeliverySlot(channel, challenge) {
  const { recipientUid, code, notification } = challenge;
  const reference = getFirestore().doc(`challengeDeliveryLimits/${channel}/recipients/${recipientUid}/senders/${notification.fromUid}`);
  return getFirestore().runTransaction(async transaction => {
    const previous = await transaction.get(reference);
    const lastAt = previous.data()?.lastAt?.toMillis() || 0;
    if (previous.data()?.code === code || Date.now() - lastAt < 60_000) return false;
    transaction.set(reference, { code, lastAt: new Date() });
    return true;
  });
}

exports.notifyFriendChallenge = onDocumentCreated({
  document: 'users/{recipientUid}/notifications/{code}',
  region: 'us-central1',
}, async event => {
  const challenge = await checkedChallenge(event);
  if (!challenge) return;
  if (!await claimDeliverySlot('push', challenge)) return;
  const { recipientUid, code, notification } = challenge;
  const tokens = await getFirestore().collection(`users/${recipientUid}/pushTokens`).limit(20).get();
  await Promise.allSettled(tokens.docs.map(async tokenDoc => {
    try {
      await getMessaging().send({
        token: tokenDoc.data().token,
        notification: {
          title: 'A TreasureHunch challenge awaits',
          body: 'A friend hid a treasure for you. Open TreasureHunch to play.',
        },
        webpush: { fcmOptions: { link: huntUrl(code) } },
      });
    } catch (error) {
      if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error.code))
        await tokenDoc.ref.delete();
      else console.error('Challenge push failed:', error);
    }
  }));
});

exports.emailFriendChallenge = onDocumentCreated({
  document: 'users/{recipientUid}/notifications/{code}',
  region: 'us-central1',
  secrets: [resendKey],
}, async event => {
  const challenge = await checkedChallenge(event);
  if (!challenge) return;
  if (!await claimDeliverySlot('email', challenge)) return;
  const { recipientUid, code, notification } = challenge;

  const recipient = await getAuth().getUser(recipientUid);
  if (!recipient.email) return;
  const sender = `@${notification.fromUsername}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey.value()}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `treasurehunch-challenge-${code}`,
    },
    body: JSON.stringify({
      from: emailFrom.value(),
      to: [recipient.email],
      subject: `${sender} hid a treasure for you on TreasureHunch`,
      text: `${sender} has challenged you to find a hidden country.\n\nOpen your hunt: ${huntUrl(code)}\n\nSign in with the Google account you use for TreasureHunch to play.`,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Challenge email failed (${response.status}): ${detail.slice(0, 200)}`);
  }
});
