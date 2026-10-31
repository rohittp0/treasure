// Local browser validation fixture, injected by scripts/validate-multiplayer.js.
// It is never imported by the production app.
const params = new URLSearchParams(location.search);
const role = params.get('role') || 'seeker';
const status = params.get('outcome') || 'won';
const long = params.has('long');
const player = { uid: role === 'hider' ? 'h' : role === 'spectator' ? 'spectator' : 's', displayName: role === 'hider' ? 'Rohit' : 'Maya' };
const match = { hiderUid: 'h', seekerUid: 's', hiderUsername: 'rohit', hiderName: long ? 'Rohit Chandrasekhar-Venkataraman the Cartographer' : 'Rohit', seekerName: long ? 'Maya Alexandra Montgomery-Worthington Explorer' : 'Maya', status, startedAt: Date.now() - 85000, endedAt: Date.now() - 30000, roundSeconds: params.has('legacy') ? undefined : 180, costSeconds: status === 'lost' ? 180 : 45, cluesVisible: 3, wrongGuesses: 1, clues: ['First clue', 'Second clue', 'Third clue'], triedIds: [], revealed: false };
export const watchUser = callback => { setTimeout(() => callback(player), 0); return () => {}; };
export const loadProfile = async () => ({ username: role === 'hider' ? 'rohit' : 'maya' });
export const loadPuzzles = async () => [];
export const loadHunts = async () => [];
export const watchChallenges = (_, callback) => { callback([]); return () => {}; };
export const getFriendHunt = async code => code === 'MNPRSTUVWX' ? { ...match, status: status === 'won' ? 'lost' : 'won' } : code === 'NPQRSTUVWX' ? { ...match, status: 'waiting', seekerName: null, seekerUid: null, targetUsername: 'maya' } : match;
export const joinFriendHunt = async () => role;
export const watchFriendHunt = (code, callback) => { queueMicrotask(async () => callback(await getFriendHunt(code))); return () => {}; };
export const loadFriendAnswer = async () => params.has('missing') ? null : ({ country: 'Japan', id: 'JPN' });
let historyAttempts = 0;
export const loadFriendHunts = async () => {
  await new Promise(resolve => setTimeout(resolve, 200));
  if (params.has('retry') && historyAttempts++ === 0) throw new Error('Fixture network failure');
  return params.has('empty') ? [] : [{ ...match, code: 'ABCDEFGHJK' }, { ...match, status: status === 'won' ? 'lost' : 'won', endedAt: Date.now() - 86400000, code: 'MNPRSTUVWX' }, ...(role === 'hider' ? [{ ...match, status: 'waiting', seekerUid: null, seekerName: null, targetUsername: 'maya', createdAt: Date.now() - 90000000, endedAt: null, code: 'NPQRSTUVWX' }, { ...match, status: 'playing', createdAt: Date.now() - 180000000, endedAt: null, code: 'PQRSTUVWX2' }] : [])];
};
export const login = async () => {};
export const logout = async () => {};
export const createFriendHunt = async () => {};
export const findUsername = async () => ({ uid: 'h', username: 'rohit' });
export const revealFriendCountry = async () => {};
export const submitFriendGuess = async () => {};
export const timeOutFriendHunt = async () => {};
export const unlockFriendClue = async () => {};
export const saveHunt = async () => {};
export const loadLeaderboard = async () => [];
export const enterLeaderboard = async () => {};
export const claimUsername = async () => {};
export const isUsernameAvailable = async () => true;
export const markChallengeRead = async () => {};
export const registerChallengePush = async () => {};
