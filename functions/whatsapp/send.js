// The daily quest alert on WhatsApp, sent at about 08:00–12:00 in each opted-in explorer's own time zone.
const pLimit = require('p-limit');
const { maskPhone } = require('./phone');
const { dailyMessage } = require('./messages');

const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 12; // Exclusive. Runs every 4 hours, so each zone lands in exactly one run a day.
const OPT_OUT_ERRORS = new Set([21610]); // The recipient told WhatsApp to stop: honoured at once.
// "Invalid recipient". Twilio lists causes that fix themselves (an outdated WhatsApp, terms not yet accepted),
// so the alert is only switched off after it has failed this way on several days running.
const UNREACHABLE_ERRORS = new Set([63024]);
const UNREACHABLE_LIMIT = 3;
const CONCURRENCY = 10;

const utcDay = date => date.toISOString().slice(0, 10);

function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}

function resolveTimeZone(whatsapp = {}) {
  if (validTimeZone(whatsapp.timeZone)) return whatsapp.timeZone;
  return String(whatsapp.phone || '').startsWith('+91') ? 'Asia/Kolkata' : 'UTC';
}

function localHour(timeZone, date) {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(date).find(part => part.type === 'hour').value;
  return Number(hour) % 24;
}

function inSendWindow(timeZone, date) {
  const hour = localHour(timeZone, date);
  return hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}

const errorCode = error => Number(error?.code) || null;

async function optOut(db, uid, now) {
  await db.doc(`users/${uid}`).update({ 'whatsapp.optIn': false, 'whatsapp.optOutAt': now });
}

// Acts on a Twilio error for one explorer's alert. A stop request opts out at once. An unreachable number
// is counted once per day; on the third day in a row the alert is switched off, but optOutAt stays unset:
// the explorer never asked to stop, so the game may offer the alert again.
async function recordFailure(db, uid, code, now) {
  if (OPT_OUT_ERRORS.has(code)) { await optOut(db, uid, now); return; }
  if (!UNREACHABLE_ERRORS.has(code)) return;
  const reference = db.doc(`users/${uid}`);
  await db.runTransaction(async transaction => {
    const whatsapp = (await transaction.get(reference)).data()?.whatsapp;
    const day = utcDay(now);
    // The send call and its status callback can both report the same failed message.
    if (!whatsapp || whatsapp.unreachableDay === day) return;
    const count = (whatsapp.unreachableCount || 0) + 1;
    transaction.update(reference, count >= UNREACHABLE_LIMIT
      ? { 'whatsapp.optIn': false, 'whatsapp.unreachableAt': now, 'whatsapp.unreachableCount': 0, 'whatsapp.unreachableDay': day }
      : { 'whatsapp.unreachableCount': count, 'whatsapp.unreachableDay': day });
  });
}

// A delivered alert ends a run of unreachable days.
async function recordDelivered(db, uid) {
  const reference = db.doc(`users/${uid}`);
  if ((await reference.get()).data()?.whatsapp?.unreachableCount) await reference.update({ 'whatsapp.unreachableCount': 0 });
}

// Sends today's alert to every opted-in explorer whose local time is in the window and who has no marker yet.
// A marker is created before each send, so a retried or overlapping run never messages anyone twice.
async function sendDailyWhatsApp({ db, twilio, params, statusCallback, clock = () => new Date(), log = console }) {
  const now = clock();
  const day = utcDay(now);
  const counts = { sent: 0, skipped: 0, outOfWindow: 0, failed: 0 };
  const recipients = await db.collection('users').where('whatsapp.optIn', '==', true).get();
  const limit = pLimit(CONCURRENCY);

  await Promise.all(recipients.docs.map(userDoc => limit(async () => {
    const uid = userDoc.id;
    const whatsapp = userDoc.data().whatsapp || {};
    if (!whatsapp.phone || !whatsapp.verifiedAt) { counts.skipped += 1; return; }
    if (!inSendWindow(resolveTimeZone(whatsapp), now)) { counts.outOfWindow += 1; return; }
    const marker = db.doc(`dailyNotifications/${day}/whatsapp/${uid}`);
    try {
      await marker.create({ uid, status: 'sending', createdAt: now });
    } catch (error) {
      if (error.code === 6) { counts.skipped += 1; return; } // ALREADY_EXISTS: sent by an earlier run.
      counts.failed += 1;
      log.error(`WhatsApp marker for ${maskPhone(whatsapp.phone)} failed: ${error.message}`.slice(0, 300));
      return;
    }
    try {
      const username = (await db.doc(`profiles/${uid}`).get()).data()?.username;
      const message = await twilio.messages.create(dailyMessage({
        from: params.from, contentSid: params.dailyContentSid, phone: whatsapp.phone, username, statusCallback,
      }));
      await marker.update({ sid: message.sid, status: message.status || 'queued' });
      await db.doc(`whatsappMessages/${message.sid}`).set({ marker: marker.path, uid, createdAt: now });
      counts.sent += 1;
    } catch (error) {
      counts.failed += 1;
      const code = errorCode(error);
      await marker.update({ status: 'failed', errorCode: code }).catch(() => {});
      await recordFailure(db, uid, code, now).catch(() => {});
      // Twilio error messages can contain the full number, so only the code is logged.
      log.error(`WhatsApp alert to ${maskPhone(whatsapp.phone)} failed: Twilio error ${code || 'unknown'}.`);
    }
  })));

  log.log(`WhatsApp daily quest ${day}: ${counts.sent} sent, ${counts.skipped} skipped, ${counts.failed} failed, ${counts.outOfWindow} outside their window.`);
  return counts;
}

module.exports = {
  WINDOW_START_HOUR, WINDOW_END_HOUR, OPT_OUT_ERRORS, UNREACHABLE_ERRORS, UNREACHABLE_LIMIT,
  validTimeZone, resolveTimeZone, localHour, inSendWindow, sendDailyWhatsApp, optOut, recordFailure, recordDelivered,
};
