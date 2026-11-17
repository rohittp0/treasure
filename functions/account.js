// Account deletion, shared by the web game and the native apps through the deleteAccount callable.
// Every step tolerates documents that are already gone, so a failed run can simply be retried.
// The Auth user is deleted last: while it exists, the explorer can sign in and ask again.
// functions/moderation.js reuses these helpers for banExplorer, which settles the same documents.
const { HttpsError } = require('firebase-functions/v2/https');
const { PURPOSES, challengeId, rateLimitRef, utcDay } = require('./whatsapp/otp');

// How a deleted explorer appears in the friend hunts kept for the other participant (CONTEXT.md).
const FORMER_EXPLORER = 'Former explorer';
const BATCH_LIMIT = 500;

async function deleteRefs(db, refs) {
  for (let index = 0; index < refs.length; index += BATCH_LIMIT) {
    const batch = db.batch();
    for (const ref of refs.slice(index, index + BATCH_LIMIT)) batch.delete(ref);
    await batch.commit();
  }
}

// Deletes a document keyed by a username or phone number only while it still belongs to this explorer,
// so a retry never removes a name or number someone else has claimed since.
async function deleteIfOwned(db, ref, uid) {
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists && snapshot.data().uid === uid) transaction.delete(ref);
  });
}

// A banned explorer can't delete the account: the ban, the reserved username and the linked WhatsApp number
// must stay, or deleting and signing up again would undo the ban (README, Moderation).
async function assertNotBanned(db, uid) {
  if ((await db.doc(`bans/${uid}`).get()).exists)
    throw new HttpsError('permission-denied', "This account was banned and can't be deleted here. Contact support.");
}

// Friend hunts the explorer hid, sought or was challenged to, each once.
async function huntsOf(db, uid) {
  const snapshots = await Promise.all(['hiderUid', 'seekerUid', 'targetUid']
    .map(field => db.collection('friendHunts').where(field, '==', uid).get()));
  const hunts = new Map();
  for (const snapshot of snapshots) for (const doc of snapshot.docs) hunts.set(doc.id, doc);
  return [...hunts.values()];
}

// A waiting hunt nobody joined, which the explorer hid or was challenged to, is deleted with its answer:
// nobody could join it any more. Any other hunt is kept for the other explorer, with the deleted side
// shown as a former explorer. Each hunt is re-read in its own transaction, so a hunt someone joins
// meanwhile is anonymised, not deleted. hiderChanges adds to what a kept hunt changes when this explorer hid
// it (a ban also removes the clues).
async function settleHunt(db, uid, ref, { hiderChanges = {} } = {}) {
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return;
    const hunt = snapshot.data();
    if (hunt.status === 'waiting' && !hunt.seekerUid && (hunt.hiderUid === uid || hunt.targetUid === uid)) {
      transaction.delete(ref.collection('private').doc('answer'));
      transaction.delete(ref);
      return;
    }
    const changes = {};
    if (hunt.hiderUid === uid) Object.assign(changes, { hiderName: FORMER_EXPLORER, hiderUsername: null, ...hiderChanges });
    if (hunt.seekerUid === uid) changes.seekerName = FORMER_EXPLORER;
    if (hunt.targetUid === uid) changes.targetUsername = null;
    if (Object.keys(changes).length) transaction.update(ref, changes);
  });
}

async function deleteAccountData(db, auth, uid, { clock = () => new Date() } = {}) {
  if (typeof uid !== 'string' || !uid) throw new Error('deleteAccountData needs a uid.');
  await assertNotBanned(db, uid);

  // 1. What the explorer's other documents are keyed by.
  const [profile, user] = await Promise.all([db.doc(`profiles/${uid}`).get(), db.doc(`users/${uid}`).get()]);
  const username = profile.data()?.username;
  const phone = user.data()?.whatsapp?.phone;

  // 2. Friend hunts. Challenges the explorer sent still show their username in the other explorer's inbox,
  // and their delivery limits are keyed by the explorer. They go first: once a waiting hunt is deleted,
  // a retry could no longer find them.
  const hunts = await huntsOf(db, uid);
  const sent = hunts.filter(doc => {
    const { hiderUid, targetUid } = doc.data();
    return hiderUid === uid && typeof targetUid === 'string' && targetUid && targetUid !== uid;
  });
  const targets = [...new Set(sent.map(doc => doc.data().targetUid))];
  await deleteRefs(db, [
    ...sent.map(doc => db.doc(`users/${doc.data().targetUid}/notifications/${doc.id}`)),
    ...targets.flatMap(targetUid => ['push', 'email']
      .map(channel => db.doc(`challengeDeliveryLimits/${channel}/recipients/${targetUid}/senders/${uid}`))),
  ]);
  for (const doc of hunts) await settleHunt(db, uid, doc.ref);

  // 3. Public data. Month entries are written without a month document, so the months are listed with
  // listDocuments, which includes missing parents; a collection-group query would need a new index.
  const months = await db.collection('monthlyLeaderboard').listDocuments();
  await deleteRefs(db, [...months.map(month => month.collection('entries').doc(uid)), db.doc(`leaderboard/${uid}`)]);
  if (username) {
    await deleteIfOwned(db, db.doc(`atlases/${username}`), uid);
    await deleteIfOwned(db, db.doc(`usernames/${username}`), uid);
  }
  await db.doc(`profiles/${uid}`).delete();
  if (phone) await deleteIfOwned(db, db.doc(`whatsappPhones/${phone}`), uid);

  // 4. Server-only data keyed by the explorer.
  const days = await db.collection('dailyNotifications').listDocuments();
  const messages = await db.collection('whatsappMessages').where('uid', '==', uid).get();
  const today = utcDay(clock());
  const serverRefs = [
    ...days.map(day => day.collection('whatsapp').doc(uid)),
    ...messages.docs.map(doc => doc.ref),
    rateLimitRef(db, 'uid', uid, today),
  ];
  // otpRateLimits/phone_* stays: it holds only a hash of the number, expires on its own (expiresAt), and
  // deleting it would let anyone reset a number's daily code limit by deleting their account.
  if (phone) serverRefs.push(...PURPOSES.map(purpose => db.doc(`otpChallenges/${challengeId(phone, purpose)}`)));
  await deleteRefs(db, serverRefs);
  for (const channel of ['push', 'email'])
    await db.recursiveDelete(db.doc(`challengeDeliveryLimits/${channel}/recipients/${uid}`));

  // 5. The explorer's own document with its hunts, daily quests, notifications and push tokens.
  await db.recursiveDelete(db.doc(`users/${uid}`));

  // 6. Last, the sign-in itself.
  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (error?.code !== 'auth/user-not-found') throw error;
  }
}

module.exports = { FORMER_EXPLORER, deleteAccountData, deleteRefs, deleteIfOwned, huntsOf, settleHunt };
