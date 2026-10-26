import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from 'firebase/auth';
import { getFirestore, collection, doc, getDoc, getDocs, query, setDoc, where, orderBy, limit, runTransaction, serverTimestamp, onSnapshot, writeBatch, updateDoc, deleteDoc } from 'firebase/firestore';
import messagingWorkerUrl from './firebase-messaging-sw.js?worker&url';

const app = initializeApp({
  apiKey: 'AIzaSyCDEJwlHrSfeSzfLwehsTFhCjOJOFayEc4',
  authDomain: 'treasurehunch.firebaseapp.com',
  projectId: 'treasurehunch',
  storageBucket: 'treasurehunch.firebasestorage.app',
  messagingSenderId: '555455406222',
  appId: '1:555455406222:web:f8b265135bd4bfa327a9df',
});

const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
const publicWebPushKey = 'BOzlGqFf6AfP-pq_3HdJmFMBecQdMdDi74U44jBl3YNgXRdaVLBbst7geU1vD1GF2dnUaSU_WFh4eX_pET8KT0U';
let pushRegistration = null;

export function watchUser(callback) {
  getRedirectResult(auth).catch(error => console.warn('Sign-in redirect failed:', error));
  return onAuthStateChanged(auth, callback);
}

export async function login() {
  try {
    await signInWithPopup(auth, provider);
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
  return signOut(auth);
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
  return handle;
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
  const result = await getDocs(query(collection(db, 'leaderboard'), orderBy('score', 'desc'), limit(5)));
  return result.docs.map(snapshot => snapshot.data());
}

export async function enterLeaderboard(user, hunt) {
  if (!user || hunt.result !== 'won' || hunt.timeLeft <= 0) return false;
  const reference = doc(db, 'leaderboard', user.uid);
  return runTransaction(db, async transaction => {
    const previous = await transaction.get(reference);
    if (previous.exists() && previous.data().score >= hunt.timeLeft) return false;
    transaction.set(reference, {
      uid: user.uid,
      name: `Explorer ${user.uid.slice(0, 4).toUpperCase()}`,
      country: hunt.country,
      puzzleId: hunt.puzzleId,
      score: hunt.timeLeft,
      completedAt: serverTimestamp(),
    });
    return true;
  });
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
  return onSnapshot(friendRef(code), snapshot => onChange(snapshot.exists() ? snapshot.data() : null), onError);
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
