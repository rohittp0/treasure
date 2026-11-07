import { initializeTracking, trackEvent, EVENTS } from './events.js';
import { friendHuntHistory } from './friend-result.js';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from 'firebase/auth';
import { getFirestore, collection, doc, getDoc, getDocs, query, setDoc, where, orderBy, limit, runTransaction, serverTimestamp, onSnapshot, writeBatch, updateDoc, deleteDoc } from 'firebase/firestore';
import messagingWorkerUrl from './firebase-messaging-sw.js?worker&url';
import { scoreSoloHunts } from './leaderboard.js';
import { scoreMonth, validDailyRecord } from './daily.js';
import { ROUND_SECONDS } from './game.js';

const app = initializeApp({
  apiKey: 'AIzaSyCDEJwlHrSfeSzfLwehsTFhCjOJOFayEc4',
  authDomain: 'treasurehunch.firebaseapp.com',
  projectId: 'treasurehunch',
  storageBucket: 'treasurehunch.firebasestorage.app',
  messagingSenderId: '555455406222',
  appId: '1:555455406222:web:f8b265135bd4bfa327a9df',
  measurementId: 'G-3L7L0GB63N',
});

initializeTracking(app);

const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
const publicWebPushKey = 'BOzlGqFf6AfP-pq_3HdJmFMBecQdMdDi74U44jBl3YNgXRdaVLBbst7geU1vD1GF2dnUaSU_WFh4eX_pET8KT0U';
let pushRegistration = null;

export function watchUser(callback) {
  getRedirectResult(auth).then(result => { if (result?.user) trackEvent(EVENTS.LOGIN, { method: 'google' }); }).catch(error => console.warn('Sign-in redirect failed:', error));
  return onAuthStateChanged(auth, callback);
}

export async function login() {
  try {
    await signInWithPopup(auth, provider);
    trackEvent(EVENTS.LOGIN, { method: 'google' });
  } catch (error) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(error.code)) {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw error;
  }
}

export async function logout() {
  if (pushRegistration?.uid === auth.currentUser?.uid) {
    try {
      await deleteDoc(doc(db, 'users', pushRegistration.uid, 'pushTokens', pushRegistration.hash));
      const { deleteToken, getMessaging } = await import('firebase/messaging');
      await deleteToken(getMessaging(app));
    } catch (error) { console.warn('Could not remove browser alerts:', error); }
    pushRegistration = null;
  }
  await signOut(auth);
  trackEvent(EVENTS.LOGOUT);
}

const usernameRef = username => doc(db, 'usernames', username);
const profileRef = uid => doc(db, 'profiles', uid);

export async function loadProfile(user) {
  if (!user) return null;
  const snapshot = await getDoc(profileRef(user.uid));
  return snapshot.exists() ? snapshot.data() : null;
}

export async function claimUsername(user, username) {
  const handle = username.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(handle)) throw new Error('Use 3–20 characters, starting with a letter. Letters, numbers and underscores work.');
  const batch = writeBatch(db);
  batch.set(profileRef(user.uid), { username: handle, createdAt: serverTimestamp() });
  batch.set(usernameRef(handle), { uid: user.uid, displayName: (user.displayName || 'Explorer').slice(0, 48), createdAt: serverTimestamp() });
  try { await batch.commit(); }
  catch (error) {
    if (error.code === 'permission-denied' || error.code === 'already-exists') throw new Error('That username is taken. Try another.');
    throw error;
  }
  trackEvent(EVENTS.SIGN_UP, { method: 'google' });
  return handle;
}

export async function isUsernameAvailable(username) {
  const handle = username.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(handle)) return false;
  return !(await getDoc(usernameRef(handle))).exists();
}

export async function findUsername(username) {
  const handle = username.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(handle)) throw new Error('Enter a valid username, like @mapfinder.');
  const snapshot = await getDoc(usernameRef(handle));
  if (!snapshot.exists()) throw new Error(`No explorer uses @${handle} yet.`);
  return { username: handle, ...snapshot.data() };
}

export function watchChallenges(user, onChange, onError) {
  return onSnapshot(query(collection(db, 'users', user.uid, 'notifications'), orderBy('createdAt', 'desc'), limit(20)),
    snapshot => onChange(snapshot.docs.map(item => ({ id: item.id, ...item.data() }))), onError);
}

export async function markChallengeRead(user, code) {
  await updateDoc(doc(db, 'users', user.uid, 'notifications', code), { read: true });
}

export async function registerChallengePush(user) {
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY || publicWebPushKey;
  if (!vapidKey || !('serviceWorker' in navigator) || Notification.permission !== 'granted') return false;
  const { getMessaging, getToken, isSupported } = await import('firebase/messaging');
  if (!await isSupported()) return false;
  const worker = await navigator.serviceWorker.register(messagingWorkerUrl, { type: 'module' });
  const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: worker });
  if (!token) return false;
  const bytes = new TextEncoder().encode(token);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  await setDoc(doc(db, 'users', user.uid, 'pushTokens', hash), { token, createdAt: serverTimestamp() });
  pushRegistration = { uid: user.uid, hash };
  return true;
}

export async function loadPuzzles() {
  const result = await getDocs(query(collection(db, 'puzzles'), where('active', '==', true)));
  return result.docs.map(snapshot => snapshot.data()).filter(puzzle =>
    /^[A-Z]{3}$/.test(puzzle.id) && Array.isArray(puzzle.clues) && puzzle.clues.length === 3
  );
}

export async function saveHunt(user, hunt) {
  if (!user) return;
  await setDoc(doc(db, 'users', user.uid), {
    displayName: user.displayName || 'Explorer',
    photoURL: user.photoURL || '',
    updatedAt: serverTimestamp(),
  }, { merge: true });
  const reference = doc(db, 'users', user.uid, 'hunts', hunt.huntId || crypto.randomUUID());
  if ((await getDoc(reference)).exists()) return;
  await setDoc(reference, {
    ...hunt,
    completedAt: serverTimestamp(),
  });
}

export async function loadHunts(user) {
  if (!user) return [];
  const result = await getDocs(collection(db, 'users', user.uid, 'hunts'));
  return result.docs.map(snapshot => snapshot.data());
}

export async function loadLeaderboard() {
  const result = await getDocs(query(collection(db, 'leaderboard'), orderBy('averageTenths', 'asc'), limit(50)));
  return result.docs.map(snapshot => snapshot.data());
}

export async function enterLeaderboard(user) {
  if (!user) return false;
  const [hunts, daily] = await Promise.all([loadHunts(user), loadDailyRecords(user)]);
  const score = scoreSoloHunts(hunts, daily);
  if (!score) return false;
  const reference = doc(db, 'leaderboard', user.uid);
  return runTransaction(db, async transaction => {
    const profile = await transaction.get(profileRef(user.uid));
    if (!profile.exists()) throw new Error('Choose a username before entering the leaderboard.');
    const username = profile.data().username;
    const previous = await transaction.get(reference);
    if (previous.exists() && previous.data().name === username &&
        previous.data().averageTenths === score.averageTenths &&
        previous.data().levelsCompleted === score.levelsCompleted &&
        previous.data().highestLevel === score.highestLevel &&
        (previous.data().dailyFinds ?? 0) === score.dailyFinds) {
      return false;
    }
    transaction.set(reference, {
      uid: user.uid,
      name: username,
      ...score,
      updatedAt: serverTimestamp(),
    });
    return true;
  });
}

// Daily quest: one attempt per explorer per UTC day, kept in users/{uid}/daily/{YYYY-MM-DD}.
const dailyRef = (uid, day) => doc(db, 'users', uid, 'daily', day);
const dailyFields = record => ({
  timeUsed: record.timeUsed,
  cluesUsed: record.cluesUsed,
  wrongGuesses: record.wrongGuesses,
  revealedCountry: record.revealedCountry,
});

function dailyFromSnapshot(data) {
  return {
    ...data,
    startedAt: data.startedAt?.toMillis?.() ?? null,
    endedAt: data.endedAt?.toMillis?.() ?? null,
  };
}

export async function loadDailyRecords(user) {
  if (!user) return [];
  const result = await getDocs(collection(db, 'users', user.uid, 'daily'));
  return result.docs.map(snapshot => dailyFromSnapshot(snapshot.data()));
}

// Records the start of today's attempt. Returns the stored record if one already exists.
export async function startDailyRecord(user, record) {
  const reference = dailyRef(user.uid, record.day);
  return runTransaction(db, async transaction => {
    const existing = await transaction.get(reference);
    if (existing.exists()) return dailyFromSnapshot(existing.data());
    transaction.set(reference, {
      day: record.day, puzzleId: record.puzzleId, country: record.country, status: 'playing',
      timeUsed: 0, cluesUsed: 1, wrongGuesses: 0, revealedCountry: false,
      startedAt: serverTimestamp(), endedAt: null,
    });
    return null;
  });
}

// Finishes today's attempt. A finished record is never overwritten.
export async function finishDailyRecord(user, record) {
  if (!validDailyRecord(record)) throw new Error('This daily result is incomplete.');
  const reference = dailyRef(user.uid, record.day);
  return runTransaction(db, async transaction => {
    const existing = await transaction.get(reference);
    if (existing.exists() && existing.data().status !== 'playing') return dailyFromSnapshot(existing.data());
    if (existing.exists()) {
      transaction.update(reference, { status: record.status, ...dailyFields(record), endedAt: serverTimestamp() });
    } else {
      transaction.set(reference, {
        day: record.day, puzzleId: record.puzzleId, country: record.country, status: record.status,
        ...dailyFields(record), startedAt: serverTimestamp(), endedAt: serverTimestamp(),
      });
    }
    return null;
  });
}

const monthlyRef = (month, uid) => doc(db, 'monthlyLeaderboard', month, 'entries', uid);

export async function loadMonthlyLeaderboard(month) {
  const result = await getDocs(query(collection(db, 'monthlyLeaderboard', month, 'entries'), orderBy('rankScore', 'desc'), limit(50)));
  return result.docs.map(snapshot => snapshot.data()).filter(entry => entry.found > 0);
}

export async function enterMonthlyLeaderboard(user, records, month) {
  if (!user) return false;
  const score = scoreMonth(records, month);
  if (!score.played) return false;
  const reference = monthlyRef(month, user.uid);
  return runTransaction(db, async transaction => {
    const profile = await transaction.get(profileRef(user.uid));
    if (!profile.exists()) throw new Error('Choose a username before entering the leaderboard.');
    const username = profile.data().username;
    const previous = await transaction.get(reference);
    if (previous.exists()) {
      const old = previous.data();
      if (old.name === username && old.found === score.found && old.played === score.played && old.timeUsed === score.timeUsed) return false;
      // Never replace a better entry with a stale view of the month.
      if (old.found > score.found || old.played > score.played) return false;
    }
    transaction.set(reference, { uid: user.uid, name: username, ...score, updatedAt: serverTimestamp() });
    return true;
  });
}

// Public explorer maps, addressed by username so share links work for signed-out visitors.
const atlasRef = username => doc(db, 'atlases', username);

export async function saveAtlas(user, username, countries) {
  if (!user || !username) return false;
  const reference = atlasRef(username);
  const snapshot = await getDoc(reference);
  const ids = Object.keys(countries);
  if (snapshot.exists() && snapshot.data().count === ids.length &&
      ids.every(id => snapshot.data().countries?.[id] === countries[id])) return false;
  await setDoc(reference, { uid: user.uid, name: username, countries, count: ids.length, updatedAt: serverTimestamp() });
  return true;
}

export async function loadAtlas(username) {
  const handle = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(handle)) return null;
  const snapshot = await getDoc(atlasRef(handle));
  return snapshot.exists() ? snapshot.data() : null;
}

const friendRef = code => doc(db, 'friendHunts', code);
const answerRef = code => doc(db, 'friendHunts', code, 'private', 'answer');

export async function createFriendHunt(user, code, place, clues, target = null, senderUsername = '') {
  const batch = writeBatch(db);
  batch.set(friendRef(code), {
    hiderUid: user.uid,
    hiderName: (user.displayName || 'Explorer').slice(0, 48),
    hiderUsername: senderUsername,
    targetUid: target?.uid || null,
    targetUsername: target?.username || null,
    seekerUid: null,
    seekerName: null,
    clues,
    status: 'waiting',
    roundSeconds: ROUND_SECONDS,
    createdAt: serverTimestamp(),
    startedAt: null,
    endedAt: null,
    cluesVisible: 1,
    costSeconds: 0,
    wrongGuesses: 0,
    triedIds: [],
    lastGuessId: '',
    lastGuessOutcome: '',
    revealed: false,
  });
  batch.set(answerRef(code), {
    id: place.id,
    country: place.country,
    lng: place.lng,
    lat: place.lat,
  });
  if (target) {
    batch.set(doc(db, 'users', target.uid, 'notifications', code), {
      code,
      fromUid: user.uid,
      fromUsername: senderUsername,
      createdAt: serverTimestamp(),
      read: false,
    });
  }
  await batch.commit();
}

export async function getFriendHunt(code) {
  const snapshot = await getDoc(friendRef(code));
  return snapshot.exists() ? snapshot.data() : null;
}

export function watchFriendHunt(code, onChange, onError) {
  return onSnapshot(friendRef(code), { includeMetadataChanges: true }, snapshot => onChange(snapshot.exists() ? snapshot.data() : null, { hasPendingWrites: snapshot.metadata.hasPendingWrites }), onError);
}

export async function joinFriendHunt(user, code) {
  return runTransaction(db, async transaction => {
    const reference = friendRef(code);
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) throw new Error('That hunt code was not found.');
    const hunt = snapshot.data();
    if (hunt.hiderUid === user.uid) return 'hider';
    if (hunt.seekerUid === user.uid) return 'seeker';
    if (hunt.targetUid && hunt.targetUid !== user.uid) throw new Error(`This challenge is for @${hunt.targetUsername}.`);
    if (hunt.status !== 'waiting') throw new Error('That hunt already has a seeker.');
    transaction.update(reference, {
      seekerUid: user.uid,
      seekerName: (user.displayName || 'Explorer').slice(0, 48),
      status: 'playing',
      startedAt: serverTimestamp(),
    });
    return 'seeker';
  });
}

export async function loadFriendAnswer(code) {
  const snapshot = await getDoc(answerRef(code));
  if (!snapshot.exists()) throw new Error('The treasure location could not be found.');
  return snapshot.data();
}

export async function unlockFriendClue(code) {
  await runTransaction(db, async transaction => {
    const reference = friendRef(code);
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) throw new Error('This hunt is no longer available.');
    const hunt = snapshot.data();
    transaction.update(reference, { cluesVisible: hunt.cluesVisible + 1, costSeconds: hunt.costSeconds + 20 });
  });
}

export async function revealFriendCountry(code) {
  await runTransaction(db, async transaction => {
    const reference = friendRef(code);
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists()) throw new Error('This hunt is no longer available.');
    const hunt = snapshot.data();
    transaction.update(reference, { revealed: true, costSeconds: hunt.costSeconds + 30 });
  });
}

export async function submitFriendGuess(code, countryId) {
  async function submit(outcome) {
    return runTransaction(db, async transaction => {
      const reference = friendRef(code);
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error('This hunt is no longer available.');
      const hunt = snapshot.data();
      if (hunt.status !== 'playing' || hunt.triedIds.includes(countryId)) throw new Error('This country cannot be guessed now.');
      if (outcome === 'correct') {
        transaction.update(reference, {
          status: 'won', endedAt: serverTimestamp(),
          lastGuessId: countryId, lastGuessOutcome: 'correct',
        });
      } else {
        transaction.update(reference, {
          costSeconds: hunt.costSeconds + 5,
          wrongGuesses: hunt.wrongGuesses + 1,
          triedIds: [...hunt.triedIds, countryId],
          lastGuessId: countryId, lastGuessOutcome: 'wrong',
        });
      }
    });
  }
  try {
    await submit('correct');
    return 'correct';
  } catch (error) {
    if (error.code !== 'permission-denied') throw error;
    await submit('wrong');
    return 'wrong';
  }
}

export async function timeOutFriendHunt(code) {
  await updateDoc(friendRef(code), { status: 'lost', endedAt: serverTimestamp() });
}

// Two single-field equality queries include legacy documents and need no composite index.
export async function loadFriendHunts(user) {
  if (!user || auth.currentUser?.uid !== user.uid) throw new Error('Sign in to load your friend hunts.');
  const snapshots = await Promise.all(['hiderUid', 'seekerUid'].map(role =>
    getDocs(query(collection(db, 'friendHunts'), where(role, '==', user.uid)))));
  return friendHuntHistory(snapshots.flatMap(snapshot => snapshot.docs.map(item => ({ ...item.data(), code: item.id }))));
}
