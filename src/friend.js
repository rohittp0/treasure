import { ROUND_SECONDS, CLUE_COST, REVEAL_COST } from './game.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeHuntCode(bytes = crypto.getRandomValues(new Uint8Array(10))) {
  return [...bytes].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function normaliseHuntCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z2-9]/g, '');
}

export function validHuntCode(value) {
  return /^[A-HJ-NP-Z2-9]{10}$/.test(value);
}

export function friendRoundSeconds(match) {
  return match?.roundSeconds ?? (match ? 120 : ROUND_SECONDS);
}

export function friendSecondsLeft(match, now = Date.now()) {
  const roundSeconds = friendRoundSeconds(match);
  if (!match?.startedAt) return roundSeconds;
  const started = typeof match.startedAt.toMillis === 'function' ? match.startedAt.toMillis() : match.startedAt;
  const end = match.endedAt
    ? (typeof match.endedAt.toMillis === 'function' ? match.endedAt.toMillis() : match.endedAt)
    : now;
  return Math.max(0, Math.ceil((started + roundSeconds * 1000 - end - match.costSeconds * 1000) / 1000));
}

export function canUnlockFriendClue(match, now = Date.now()) {
  return match?.status === 'playing' && match.cluesVisible < 3 && friendSecondsLeft(match, now) > CLUE_COST;
}

export function canRevealFriendCountry(match, now = Date.now()) {
  return match?.status === 'playing' && match.cluesVisible === 3 && !match.revealed && friendSecondsLeft(match, now) > REVEAL_COST;
}

