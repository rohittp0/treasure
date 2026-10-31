// Adapter for controller event-order tests; never imported by the production app.
export * from '/tests/fixtures/multiplayer-firebase.js';
const params = new URLSearchParams(location.search);
const match = { hiderUid: 'h', seekerUid: 's', hiderName: 'Rohit', seekerName: 'Maya', hiderUsername: 'rohit',
  status: 'playing', roundSeconds: 180, startedAt: Date.now(), endedAt: null, costSeconds: 0,
  cluesVisible: 1, wrongGuesses: 0, revealed: false, triedIds: [], clues: ['First clue', 'Second clue', 'Third clue'] };
let onChange;
export const getFriendHunt = async () => ({ ...match });
export const joinFriendHunt = async () => 'seeker';
export const watchFriendHunt = (_, callback) => {
  onChange = callback; queueMicrotask(() => callback({ ...match }, { hasPendingWrites: false }));
  return () => { onChange = null; };
};
function notify(pending) { onChange?.({ ...match }, { hasPendingWrites: pending }); }
export const unlockFriendClue = async () => {
  if (params.has('fail')) throw new Error('Fixture rejected write');
  match.cluesVisible++; match.costSeconds += 20; notify(true); notify(false);
};
export const revealFriendCountry = async () => { match.revealed = true; match.costSeconds += 30; notify(true); notify(false); };
export const submitFriendGuess = async (_, country) => {
  if (country === 'JPN') { match.status = 'won'; match.endedAt = Date.now(); notify(true); notify(false); return 'correct'; }
  match.wrongGuesses++; match.costSeconds += 5; match.triedIds.push(country); notify(true); notify(false); return 'wrong';
};
export const loadFriendAnswer = async () => ({ id: 'JPN', country: 'Japan' });
