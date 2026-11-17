// Account deletion, shared by the web game and the native apps through the deleteAccount callable.
// Every step tolerates documents that are already gone, so a failed run can simply be retried.
// The Auth user is deleted last: while it exists, the explorer can sign in and ask again.
const { PURPOSES, challengeId, rateLimitRef, sha256, utcDay } = require('./whatsapp/otp');

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

// Friend hunts the explorer hid, sought or was challenged to, each once.
async function huntsOf(db, uid) {
  const snapshots = await Promise.all(['hiderUid', 'seekerUid', 'targetUid']
    .map(field => db.collection('friendHunts').where(field, '==', uid).get()));
  const hunts = new Map();
  for (const snapshot of snapshots) for (const doc of snapshot.docs) hunts.set(doc.id, doc);
  return [...hunts.values()];
}

// A waiting hunt nobody joined is deleted with its answer. Any other hunt is kept for the other explorer,
// with the deleted side shown as a former explorer.
async function settleHunts(db, uid, hunts) {
  for (const doc of hunts) {
    const hunt = doc.data();
    if (hunt.hiderUid === uid && hunt.status === 'waiting' && !hunt.seekerUid) {
      await db.recursiveDelete(doc.ref);
      continue;
    }
    const changes = {};
    if (hunt.hiderUid === uid) Object.assign(changes, { hiderName: FORMER_EXPLORER, hiderUsername: null });
    if (hunt.seekerUid === uid) changes.seekerName = FORMER_EXPLORER;
    if (hunt.targetUid === uid) changes.targetUsername = null;
    await doc.ref.update(changes);
  }
}

async function deleteAccountData(db, auth, uid, { clock = () => new Date() } = {}) {
  if (typeof uid !== 'string' || !uid) throw new Error('deleteAccountData needs a uid.');

  // 1. What the explorer's other documents are keyed by.
  const [profile, user] = await Promise.all([db.doc(`profiles/${uid}`).get(), db.doc(`users/${uid}`).get()]);
  const username = profile.data()?.username;
  const phone = user.data()?.whatsapp?.phone;

  // 2. Friend hunts. Challenges the explorer sent still show their username in the other explorer's inbox.
  // They go first: once a waiting hunt is deleted, a retry could no longer find its challenge.
  const hunts = await huntsOf(db, uid);
  await deleteRefs(db, hunts.filter(doc => {
    const { hiderUid, targetUid } = doc.data();
    return hiderUid === uid && typeof targetUid === 'string' && targetUid && targetUid !== uid;
  }).map(doc => db.doc(`users/${doc.data().targetUid}/notifications/${doc.id}`)));
  await settleHunts(db, uid, hunts);

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
  if (phone) {
    serverRefs.push(...PURPOSES.map(purpose => db.doc(`otpChallenges/${challengeId(phone, purpose)}`)));
    serverRefs.push(rateLimitRef(db, 'phone', sha256(phone), today));
  }
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

module.exports = { FORMER_EXPLORER, deleteAccountData };
