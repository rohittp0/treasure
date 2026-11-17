// Moderation for user-generated content (App Store Guideline 1.2, spec decision 22): friend-hunt clues and
// public usernames. Explorers report and block in the app; each report alerts the developer on Telegram, who
// acts within 24 hours. An admin ban disables the account, removes its public entries and anonymises its
// friend hunts. Usernames are claimed through claimUsername, which checks the blocklist.
// The logic takes its Firestore, Auth and fetch from the caller so tests can run it against the emulator.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const REGION = 'us-central1';
// How a banned explorer appears in the friend hunts kept for the other participant (CONTEXT.md).
const FORMER_EXPLORER = 'Former explorer';
const REMOVED_CLUE = 'This clue was removed by a moderator.';
const USERNAME = /^[a-z][a-z0-9_]{2,19}$/;
const USERNAME_RULE = 'Use 3–20 characters, starting with a letter. Letters, numbers and underscores work.';
const ALERTS_PER_REPORTER_PER_HOUR = 5;
// The same report (reporter, explorer, kind and hunt) within this window is alerted once.
const DUPLICATE_WINDOW_MS = 24 * 3_600_000;
const DIGEST_WINDOW_MS = 48 * 3_600_000;
const TELEGRAM_TIMEOUT_MS = 10_000;
// The reason the app gives the report that every Block files (BLOCK_REASON in src/moderation.js).
// Those reports don't count against the reporter's alert limit while the block exists.
const BLOCK_REASON = 'Blocked by the reporting explorer.';
// Report states that need no further alert: sent alone, a repeat of one that was, or sent in a digest.
const ALERTED = ['sent', 'duplicate', 'digested'];
const BATCH_LIMIT = 500;

const telegramToken = defineSecret('MODERATION_TELEGRAM_TOKEN');
const telegramChatId = defineSecret('MODERATION_TELEGRAM_CHAT_ID');

// ---------------------------------------------------------------------------
// Username blocklist (functions/moderation/blocklist.txt; its header explains the format).

// Undo the digit swaps used to slip a word past a filter, and drop underscores.
const DIGITS = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g' };
const squash = value => value.replace(/_/g, '').replace(/[0-9]/g, digit => DIGITS[digit] || digit);

function loadBlocklist(text = readFileSync(join(__dirname, 'moderation', 'blocklist.txt'), 'utf8')) {
  const exact = new Set();
  const contains = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('~')) {
      const word = squash(line.slice(1).trim());
      if (word) contains.add(word);
    } else exact.add(line);
  }
  return { exact, contains: [...contains] };
}

// 'exact', 'contains' or null.
function blockedReason(username, list) {
  const plain = username.replace(/_/g, '');
  if (list.exact.has(username) || list.exact.has(plain)) return 'exact';
  const swapped = squash(username);
  return list.contains.some(word => plain.includes(word) || swapped.includes(word)) ? 'contains' : null;
}

// The Firestore rules can only match whole names, so the exact entries are kept as blockedUsernames/{name}
// documents, which the usernames rule checks. Missing ones are written on every claim; there are only a few.
async function syncBlockedUsernames(db, list) {
  const names = [...list.exact].filter(name => USERNAME.test(name));
  if (!names.length) return 0;
  const snapshots = await db.getAll(...names.map(name => db.doc(`blockedUsernames/${name}`)));
  const missing = snapshots.filter(snapshot => !snapshot.exists);
  if (!missing.length) return 0;
  const batch = db.batch();
  for (const snapshot of missing) batch.set(snapshot.ref, { source: 'blocklist', addedAt: FieldValue.serverTimestamp() });
  await batch.commit();
  return missing.length;
}

// ---------------------------------------------------------------------------
// claimUsername: the profiles/{uid} and usernames/{name} pair, with the same invariants as the rules
// (a valid name, not taken, and a profile that points back), plus the blocklist and bans.
async function claimUsernameData(db, { uid, displayName, username }, list = loadBlocklist()) {
  if (typeof username !== 'string') throw new HttpsError('invalid-argument', USERNAME_RULE);
  const handle = username.trim().toLowerCase();
  if (!USERNAME.test(handle)) throw new HttpsError('invalid-argument', USERNAME_RULE);
  await syncBlockedUsernames(db, list);
  const reason = blockedReason(handle, list);
  if (reason) {
    // Listed as tried, so the older client path can't take this exact name either.
    if (reason === 'contains')
      await db.doc(`blockedUsernames/${handle}`).set({ source: 'claim', addedAt: FieldValue.serverTimestamp() }, { merge: true });
    throw new HttpsError('invalid-argument', "That username isn't allowed. Try another.", { reason: 'blocked' });
  }
  const name = (typeof displayName === 'string' && displayName.trim() ? displayName.trim() : 'Explorer').slice(0, 48);
  return db.runTransaction(async transaction => {
    const [ban, profile, taken, blocked] = await transaction.getAll(
      db.doc(`bans/${uid}`), db.doc(`profiles/${uid}`), db.doc(`usernames/${handle}`), db.doc(`blockedUsernames/${handle}`));
    if (ban.exists) throw new HttpsError('permission-denied', "This account can't choose a username.");
    if (profile.exists) {
      if (profile.data().username === handle) return { username: handle };
      throw new HttpsError('failed-precondition', 'You already have a username.');
    }
    if (taken.exists) throw new HttpsError('already-exists', 'That username is taken. Try another.');
    if (blocked.exists) throw new HttpsError('invalid-argument', "That username isn't allowed. Try another.", { reason: 'blocked' });
    transaction.create(db.doc(`profiles/${uid}`), { username: handle, createdAt: FieldValue.serverTimestamp() });
    transaction.create(db.doc(`usernames/${handle}`), { uid, displayName: name, createdAt: FieldValue.serverTimestamp() });
    return { username: handle };
  });
}

// ---------------------------------------------------------------------------
// Blocks: users/{uid}/blocks/{otherUid}, written by the explorer who blocks.
async function isBlocked(db, ownerUid, otherUid) {
  if (typeof ownerUid !== 'string' || !ownerUid || typeof otherUid !== 'string' || !otherUid) return false;
  return (await db.doc(`users/${ownerUid}/blocks/${otherUid}`).get()).exists;
}

// ---------------------------------------------------------------------------
// banExplorer. The same steps as account deletion (functions/account.js on the deleteAccount branch), except
// that the Auth user is disabled rather than deleted, the WhatsApp number stays linked to the banned account
// so it can't sign up again, the username stays reserved, and the explorer's clues are removed.
// Every step tolerates documents that are already gone, so a failed ban can simply be run again.

async function deleteRefs(db, refs) {
  for (let index = 0; index < refs.length; index += BATCH_LIMIT) {
    const batch = db.batch();
    for (const ref of refs.slice(index, index + BATCH_LIMIT)) batch.delete(ref);
    await batch.commit();
  }
}

// Deletes a document keyed by a username only while it still belongs to this explorer.
async function deleteIfOwned(db, ref, uid) {
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists && snapshot.data().uid === uid) transaction.delete(ref);
  });
}

async function huntsOf(db, uid) {
  const snapshots = await Promise.all(['hiderUid', 'seekerUid', 'targetUid']
    .map(field => db.collection('friendHunts').where(field, '==', uid).get()));
  const hunts = new Map();
  for (const snapshot of snapshots) for (const doc of snapshot.docs) hunts.set(doc.id, doc);
  return [...hunts.values()];
}

// A waiting hunt nobody joined, which the explorer hid or was challenged to, is deleted with its answer.
// Any other hunt stays for the other explorer, with the banned side shown as a former explorer and the
// banned hider's clues removed.
async function settleHunt(db, uid, ref) {
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
    if (hunt.hiderUid === uid) Object.assign(changes, { hiderName: FORMER_EXPLORER, hiderUsername: null, clues: Array(3).fill(REMOVED_CLUE) });
    if (hunt.seekerUid === uid) changes.seekerName = FORMER_EXPLORER;
    if (hunt.targetUid === uid) changes.targetUsername = null;
    if (Object.keys(changes).length) transaction.update(ref, changes);
  });
}

async function ignoreMissingUser(promise) {
  try { await promise; } catch (error) { if (error?.code !== 'auth/user-not-found') throw error; }
}

async function banExplorerData(db, auth, uid, { reason = '', bannedBy = null } = {}) {
  if (typeof uid !== 'string' || !uid || uid.includes('/')) throw new Error('banExplorerData needs a uid.');
  const [profile, user, previous] = await Promise.all(
    [db.doc(`profiles/${uid}`).get(), db.doc(`users/${uid}`).get(), db.doc(`bans/${uid}`).get()]);
  // On a retry the profile may already be gone; the ban remembers the name.
  const username = profile.data()?.username || previous.data()?.username || null;

  // 1. The ban first: from here the rules refuse every public write, so nothing removed below comes back.
  await db.doc(`bans/${uid}`).set({
    bannedAt: previous.data()?.bannedAt || FieldValue.serverTimestamp(),
    // Running the ban again without a reason or admin keeps the ones stored the first time.
    bannedBy: typeof bannedBy === 'string' ? bannedBy : previous.data()?.bannedBy || null,
    reason: reason ? String(reason).slice(0, 500) : previous.data()?.reason || '',
    username,
  }, { merge: true });

  // 2. Sign-in: disabled, and existing sessions end when their ID token next refreshes.
  await ignoreMissingUser(auth.updateUser(uid, { disabled: true }));
  await ignoreMissingUser(auth.revokeRefreshTokens(uid));

  // 3. Friend hunts. Challenges the explorer sent go from the other explorers' inboxes first: once a waiting
  // hunt is deleted, a retry could no longer find them.
  const hunts = await huntsOf(db, uid);
  await deleteRefs(db, hunts
    .filter(doc => doc.data().hiderUid === uid && typeof doc.data().targetUid === 'string' && doc.data().targetUid && doc.data().targetUid !== uid)
    .map(doc => db.doc(`users/${doc.data().targetUid}/notifications/${doc.id}`)));
  for (const doc of hunts) await settleHunt(db, uid, doc.ref);

  // 4. Public entries. The name is reserved before it is released, so nobody can take it in between.
  const months = await db.collection('monthlyLeaderboard').listDocuments();
  await deleteRefs(db, [...months.map(month => month.collection('entries').doc(uid)), db.doc(`leaderboard/${uid}`)]);
  if (username) {
    await db.doc(`blockedUsernames/${username}`).set({ source: 'ban', uid, addedAt: FieldValue.serverTimestamp() }, { merge: true });
    await deleteIfOwned(db, db.doc(`atlases/${username}`), uid);
    await deleteIfOwned(db, db.doc(`usernames/${username}`), uid);
  }
  await db.doc(`profiles/${uid}`).delete();

  // 5. No more daily quest alerts: push tokens go, and the WhatsApp alert is switched off.
  await db.recursiveDelete(db.collection(`users/${uid}/pushTokens`));
  if (user.data()?.whatsapp?.optIn === true)
    await db.doc(`users/${uid}`).update({ 'whatsapp.optIn': false, 'whatsapp.optOutAt': FieldValue.serverTimestamp() });
  return { username, hunts: hunts.length };
}

function requireAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (request.auth.token?.admin !== true) throw new HttpsError('permission-denied', 'Only an admin can ban explorers.');
}

// ---------------------------------------------------------------------------
// Report alerts on Telegram.

const consoleLink = (projectId, path) =>
  `https://console.firebase.google.com/project/${projectId}/firestore/databases/-default-/data/~2F${path.split('/').map(encodeURIComponent).join('~2F')}`;

const KIND_LABELS = { clue: 'friend-hunt clues', hunt: 'a friend hunt', profile: 'an explorer map or profile', username: 'a username' };

function reportAlertText({ projectId, reportId, report, targetName, reporterName }) {
  const who = (name, uid) => `${name ? `@${name}` : 'an explorer with no username'} (uid ${uid})`;
  const lines = [
    `TreasureHunch report: ${KIND_LABELS[report.kind] || report.kind} (${report.kind})`,
    `Reason: ${report.reason || '(none given)'}`,
    `Reported: ${who(targetName, report.targetUid)}`,
    `Reporter: ${who(reporterName, report.reporterUid)}`,
  ];
  if (report.code) lines.push(`Hunt code: ${report.code}`);
  lines.push('', `Report: ${consoleLink(projectId, `reports/${reportId}`)}`);
  if (report.code) lines.push(`Friend hunt: ${consoleLink(projectId, `friendHunts/${report.code}`)}`);
  if (targetName) {
    lines.push(`Explorer map: ${consoleLink(projectId, `atlases/${targetName}`)}`);
    lines.push(`Username: ${consoleLink(projectId, `usernames/${targetName}`)}`);
  }
  lines.push(`Explorer: ${consoleLink(projectId, `users/${report.targetUid}`)}`);
  lines.push('', `Act within 24 hours: remove the content, and ban the explorer if needed with banExplorer {"uid": "${report.targetUid}"} (see README, Moderation).`);
  return lines.join('\n');
}

// Decides, once per report, whether it is alerted on its own:
// - 'send': alert it. Retries of the same report keep this answer without counting again.
// - 'duplicate': the same reporter reported the same thing in the last 24 hours, and that was alerted.
// - 'limited': the reporter had ALERTS_PER_REPORTER_PER_HOUR alerts this hour. The daily digest picks it up.
// The report every Block files doesn't count against the limit while the block is in place.
async function claimAlert(db, reportId, report, now) {
  const reportRef = db.doc(`reports/${reportId}`);
  const limitRef = db.doc(`moderationLimits/${report.reporterUid}`);
  const keyRef = limitRef.collection('reports').doc(`${report.targetUid}_${report.kind}_${report.code || 'none'}`);
  const blockRef = db.doc(`users/${report.reporterUid}/blocks/${report.targetUid}`);
  return db.runTransaction(async transaction => {
    const [stored, limit, key, block] = await transaction.getAll(reportRef, limitRef, keyRef, blockRef);
    if (stored.data()?.alertClaimed) return 'send';
    const lastAt = key.data()?.lastAt?.toMillis?.() ?? 0;
    if (key.exists && key.data().reportId !== reportId && now.getTime() - lastAt < DUPLICATE_WINDOW_MS) return 'duplicate';
    const exempt = report.reason === BLOCK_REASON && block.exists;
    if (!exempt) {
      const windowStart = limit.data()?.windowStart?.toMillis?.() ?? 0;
      const fresh = !limit.exists || now.getTime() - windowStart >= 3_600_000;
      if (!fresh && limit.data().count >= ALERTS_PER_REPORTER_PER_HOUR) return 'limited';
      transaction.set(limitRef, fresh ? { windowStart: now, count: 1 } : { windowStart: limit.data().windowStart, count: limit.data().count + 1 });
    }
    transaction.set(keyRef, { reportId, lastAt: now });
    transaction.set(reportRef, { alertClaimed: true }, { merge: true });
    return 'send';
  });
}

async function sendTelegram({ fetch, token, chatId, text }) {
  // Plain text: report reasons are explorers' own words and must not be read as Markdown or HTML.
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // The token is in the URL, so the URL is never part of the error.
    throw new Error(`Telegram sendMessage failed (${response.status}): ${detail.slice(0, 200)}`);
  }
}

// One report's alert. The trigger retries on failure; a report already alerted is left alone.
function createReportAlert({ db, fetch, token, chatId, projectId, clock = () => new Date(), log = console }) {
  return async function alert(reportId, report) {
    if (!report || typeof report.reporterUid !== 'string' || typeof report.targetUid !== 'string') return;
    const reference = db.doc(`reports/${reportId}`);
    if (ALERTED.includes((await reference.get()).data()?.alert)) return;
    if (!token || !chatId) {
      log.error('Report alert skipped: set the MODERATION_TELEGRAM_TOKEN and MODERATION_TELEGRAM_CHAT_ID secrets.');
      await reference.set({ alert: 'unconfigured' }, { merge: true });
      return;
    }
    const decision = await claimAlert(db, reportId, report, clock());
    if (decision !== 'send') {
      await reference.set({ alert: decision }, { merge: true });
      return;
    }
    const [target, reporter] = await db.getAll(db.doc(`profiles/${report.targetUid}`), db.doc(`profiles/${report.reporterUid}`));
    const text = reportAlertText({ projectId, reportId, report, targetName: target.data()?.username, reporterName: reporter.data()?.username });
    try {
      await sendTelegram({ fetch, token, chatId, text });
    } catch (error) {
      await reference.set({ alert: 'failed' }, { merge: true });
      throw new Error(`Telegram alert for report ${reportId} failed: ${error.message}`);
    }
    await reference.set({ alert: 'sent', alertedAt: FieldValue.serverTimestamp() }, { merge: true });
  };
}

// The daily digest: every report from the last 48 hours that wasn't alerted (limited, failed, unconfigured, or
// never processed), so none waits past the 24 hours the Terms promise. Without Telegram it only logs a count.
async function sendReportDigest({ db, fetch, token, chatId, projectId, clock = () => new Date(), log = console }) {
  const since = new Date(clock().getTime() - DIGEST_WINDOW_MS);
  const snapshot = await db.collection('reports').where('createdAt', '>=', since).get();
  const pending = snapshot.docs.filter(doc => !ALERTED.includes(doc.data().alert));
  if (!pending.length) return { pending: 0, sent: false };
  if (!token || !chatId) {
    log.error(`Report digest: ${pending.length} reports from the last 48 hours were not alerted. Set the MODERATION_TELEGRAM_TOKEN and MODERATION_TELEGRAM_CHAT_ID secrets, and review them in the reports collection.`);
    return { pending: pending.length, sent: false };
  }
  const shown = pending.slice(0, 30);
  const lines = [
    `TreasureHunch report digest: ${pending.length} reports from the last 48 hours were not alerted one by one. Review each within 24 hours.`,
    ...shown.map(doc => {
      const report = doc.data();
      return `\n- ${report.kind}${report.code ? ` (hunt ${report.code})` : ''}: uid ${report.targetUid}, reported by ${report.reporterUid}, ${report.alert || 'not processed'}\n  Reason: ${report.reason || '(none given)'}\n  ${consoleLink(projectId, `reports/${doc.id}`)}`;
    }),
  ];
  if (pending.length > shown.length) lines.push(`\n…and ${pending.length - shown.length} more: ${consoleLink(projectId, 'reports')}`);
  await sendTelegram({ fetch, token, chatId, text: lines.join('\n') });
  for (let index = 0; index < shown.length; index += BATCH_LIMIT) {
    const batch = db.batch();
    for (const doc of shown.slice(index, index + BATCH_LIMIT)) batch.set(doc.ref, { alert: 'digested', digestedAt: FieldValue.serverTimestamp() }, { merge: true });
    await batch.commit();
  }
  return { pending: pending.length, sent: true };
}

const currentProjectId = () =>
  process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId || 'treasurehunch';

// ---------------------------------------------------------------------------
// Cloud Functions, exported from index.js.

// Retried until Telegram accepts the alert; createReportAlert does nothing for a report already alerted.
const onReportCreated = onDocumentCreated({
  document: 'reports/{reportId}',
  region: REGION,
  retry: true,
  secrets: [telegramToken, telegramChatId],
}, event => createReportAlert({
  db: getFirestore(),
  fetch,
  token: telegramToken.value(),
  chatId: telegramChatId.value(),
  projectId: currentProjectId(),
})(event.params.reportId, event.data?.data()));

const moderationDigest = onSchedule({
  schedule: '0 6 * * *',
  timeZone: 'Etc/UTC',
  region: REGION,
  retryCount: 1,
  secrets: [telegramToken, telegramChatId],
}, async () => {
  const result = await sendReportDigest({
    db: getFirestore(), fetch, token: telegramToken.value(), chatId: telegramChatId.value(), projectId: currentProjectId(),
  });
  console.log(`Report digest: ${result.pending} pending, ${result.sent ? 'sent' : 'not sent'}.`);
});

const claimUsername = onCall({ region: REGION, enforceAppCheck: true }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to choose a username.');
  return claimUsernameData(getFirestore(), {
    uid: request.auth.uid,
    displayName: request.auth.token?.name,
    username: request.data?.username,
  });
});

// Admin only. Not behind App Check, so an admin can call it outside the apps (README, Moderation).
const banExplorer = onCall({ region: REGION, timeoutSeconds: 300 }, async request => {
  requireAdmin(request);
  const uid = request.data?.uid;
  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/') || uid === request.auth.uid)
    throw new HttpsError('invalid-argument', 'Pass the uid of the explorer to ban.');
  try {
    const result = await banExplorerData(getFirestore(), getAuth(), uid, { reason: request.data?.reason, bannedBy: request.auth.uid });
    return { ok: true, ...result };
  } catch (error) {
    console.error(`Ban of ${uid} failed:`, error);
    throw new HttpsError('internal', 'The ban did not finish. Run it again.');
  }
});

module.exports = {
  FORMER_EXPLORER, REMOVED_CLUE, ALERTS_PER_REPORTER_PER_HOUR, BLOCK_REASON,
  loadBlocklist, blockedReason, syncBlockedUsernames, claimUsernameData, isBlocked, banExplorerData,
  requireAdmin, consoleLink, reportAlertText, createReportAlert, sendReportDigest,
  onReportCreated, moderationDigest, claimUsername, banExplorer,
};
