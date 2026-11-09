// WhatsApp daily quest alert rules. Run from friend-rules.rules.mjs inside the Firestore emulator.
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteField, serverTimestamp, Timestamp, collection, query, where } from 'firebase/firestore';

const PHONE = '+919020277399';

export async function testWhatsAppRules(environment) {
  const verifiedAt = Timestamp.fromDate(new Date('2026-11-09T10:00:00Z'));
  await environment.withSecurityRulesDisabled(async context => {
    const admin = context.firestore();
    await setDoc(doc(admin, 'users/wa-verified'), { displayName: 'Verified', whatsapp: { phone: PHONE, verifiedAt, optIn: false } });
    await setDoc(doc(admin, 'users/wa-plain'), { displayName: 'Plain' });
    await setDoc(doc(admin, 'users/wa-unverified'), { displayName: 'Half', whatsapp: { phone: '+919000000001', optIn: false } });
    await setDoc(doc(admin, `whatsappPhones/${PHONE}`), { uid: 'wa-verified' });
    await setDoc(doc(admin, 'otpChallenges/abc'), { codeHash: 'x', purpose: 'login', uid: null });
    await setDoc(doc(admin, 'otpRateLimits/phone/days/2026-11-09'), { count: 1 });
    await setDoc(doc(admin, 'dailyNotifications/2026-11-09/whatsapp/wa-verified'), { sid: 'SM1', status: 'sent' });
  });

  const owner = environment.authenticatedContext('wa-verified').firestore();
  const plain = environment.authenticatedContext('wa-plain').firestore();
  const half = environment.authenticatedContext('wa-unverified').firestore();
  const other = environment.authenticatedContext('wa-other').firestore();
  const guest = environment.unauthenticatedContext().firestore();
  const ownerDoc = doc(owner, 'users/wa-verified');

  // Existing profile merges (saveHunt) keep working, with or without the WhatsApp map.
  const profileMerge = { displayName: 'Explorer', photoURL: '', updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(ownerDoc, profileMerge, { merge: true }));
  await assertSucceeds(setDoc(doc(plain, 'users/wa-plain'), profileMerge, { merge: true }));
  await assertSucceeds(setDoc(doc(environment.authenticatedContext('wa-new').firestore(), 'users/wa-new'), profileMerge, { merge: true }));

  // Clients never create the map or write phone / verifiedAt.
  await assertFails(setDoc(doc(environment.authenticatedContext('wa-new2').firestore(), 'users/wa-new2'),
    { displayName: 'X', whatsapp: { phone: PHONE, verifiedAt: serverTimestamp(), optIn: true, optInAt: serverTimestamp() } }));
  await assertFails(setDoc(doc(plain, 'users/wa-plain'), { whatsapp: { optIn: true, optInAt: serverTimestamp() } }, { merge: true }));
  await assertFails(setDoc(doc(plain, 'users/wa-plain'), { whatsapp: { timeZone: 'Asia/Kolkata' } }, { merge: true }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.phone': '+919999999999' }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.verifiedAt': serverTimestamp() }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.verifiedAt': deleteField() }));
  await assertFails(updateDoc(ownerDoc, { whatsapp: deleteField() }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.extra': 'nope' }));

  // Opt-in needs a verified number and optInAt == request.time.
  await assertFails(updateDoc(doc(half, 'users/wa-unverified'), { 'whatsapp.optIn': true, 'whatsapp.optInAt': serverTimestamp() }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.optIn': true }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.optIn': true, 'whatsapp.optInAt': verifiedAt }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.optIn': 'yes', 'whatsapp.optInAt': serverTimestamp() }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.optIn': true, 'whatsapp.optInAt': serverTimestamp(), 'whatsapp.phone': '+919999999999' }));
  await assertSucceeds(updateDoc(ownerDoc, {
    'whatsapp.optIn': true, 'whatsapp.optInAt': serverTimestamp(), 'whatsapp.optOutAt': null, 'whatsapp.timeZone': 'Asia/Kolkata',
  }));
  // While on, optInAt/optOutAt can't be rewritten; the time zone can be refreshed.
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.optInAt': serverTimestamp() }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.optOutAt': serverTimestamp() }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.timeZone': 'x'.repeat(65) }));
  await assertSucceeds(updateDoc(ownerDoc, { 'whatsapp.timeZone': 'Europe/London' }));

  // Opt-out stamps optOutAt with request.time and leaves optInAt alone.
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.optIn': false }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.optIn': false, 'whatsapp.optOutAt': verifiedAt }));
  await assertFails(updateDoc(ownerDoc, { 'whatsapp.optIn': false, 'whatsapp.optOutAt': serverTimestamp(), 'whatsapp.optInAt': null }));
  await assertSucceeds(updateDoc(ownerDoc, { 'whatsapp.optIn': false, 'whatsapp.optOutAt': serverTimestamp() }));
  // Opting back in after an opt-out works the same way.
  await assertSucceeds(setDoc(ownerDoc, { whatsapp: { optIn: true, optInAt: serverTimestamp(), timeZone: 'Asia/Kolkata' } }, { merge: true }));
  const stored = (await assertSucceeds(getDoc(ownerDoc))).data().whatsapp;
  assert(stored.phone === PHONE && stored.optIn === true && stored.verifiedAt && stored.optOutAt, 'opt-in kept phone, verifiedAt and the old optOutAt');

  // The post-quest prompt snooze is owner-writable with the server time only.
  await assertSucceeds(updateDoc(ownerDoc, { whatsappPromptSnoozedAt: serverTimestamp() }));
  await assertFails(updateDoc(ownerDoc, { whatsappPromptSnoozedAt: verifiedAt }));
  await assertFails(setDoc(doc(environment.authenticatedContext('wa-new3').firestore(), 'users/wa-new3'), { whatsappPromptSnoozedAt: verifiedAt }));

  // Another explorer can't read or write the field.
  await assertFails(getDoc(doc(other, 'users/wa-verified')));
  await assertFails(getDocs(query(collection(other, 'users'), where('whatsapp.optIn', '==', true))));
  await assertFails(updateDoc(doc(other, 'users/wa-verified'), { 'whatsapp.optIn': false, 'whatsapp.optOutAt': serverTimestamp() }));
  await assertFails(getDoc(doc(guest, 'users/wa-verified')));

  // OTP challenges, send limits, the phone index and delivery markers are server-only.
  for (const db of [owner, other, guest]) {
    await assertFails(getDoc(doc(db, `whatsappPhones/${PHONE}`)));
    await assertFails(getDocs(collection(db, 'whatsappPhones')));
    await assertFails(getDoc(doc(db, 'otpChallenges/abc')));
    await assertFails(getDocs(collection(db, 'otpChallenges')));
    await assertFails(getDoc(doc(db, 'otpRateLimits/phone/days/2026-11-09')));
    await assertFails(getDoc(doc(db, 'dailyNotifications/2026-11-09/whatsapp/wa-verified')));
  }
  await assertFails(setDoc(doc(owner, `whatsappPhones/${PHONE}`), { uid: 'wa-verified' }));
  await assertFails(setDoc(doc(other, 'whatsappPhones/+919111111111'), { uid: 'wa-other' }));
  await assertFails(setDoc(doc(owner, 'otpChallenges/abc'), { codeHash: 'y' }));
  await assertFails(setDoc(doc(owner, 'otpRateLimits/phone/days/2026-11-10'), { count: 0 }));
  await assertFails(setDoc(doc(owner, 'dailyNotifications/2026-11-09/whatsapp/wa-verified'), { status: 'read' }));

  console.log('WhatsApp rules: verified-only opt-in, opt-out, server-only phone and OTP collections passed.');
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
