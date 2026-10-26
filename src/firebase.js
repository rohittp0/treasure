import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from 'firebase/auth';
import { getFirestore, collection, doc, getDoc, getDocs, query, setDoc, where, orderBy, limit, runTransaction, serverTimestamp } from 'firebase/firestore';

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

export function logout() { return signOut(auth); }

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
