import { friendRoundSeconds, friendSecondsLeft } from './friend.js';

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const timestampMillis = value => typeof value?.toMillis === 'function' ? value.toMillis() : Number(value) || 0;
export const friendHuntHistory = hunts => [...new Map(hunts.map(h => [h.code, h])).values()].sort((a, b) => timestampMillis(b.endedAt || b.createdAt || b.startedAt) - timestampMillis(a.endedAt || a.createdAt || a.startedAt));

// Stored outcomes always describe the seeker. Personal outcomes depend on the viewer.
export function friendResult(match, viewerUid, answer = null, code = '') {
  if (!['won', 'lost'].includes(match.status)) throw new Error('This hunt has not finished.');
  const role = viewerUid && viewerUid === match.hiderUid ? 'hider' : viewerUid && viewerUid === match.seekerUid ? 'seeker' : 'spectator';
  const seekerWon = match.status === 'won';
  const winnerRole = seekerWon ? 'seeker' : 'hider';
  const personalWin = role === winnerRole;
  const hider = match.hiderName || 'The hider';
  const seeker = match.seekerName || 'The seeker';
  const country = role !== 'spectator' ? answer?.country || null : null;
  const winner = seekerWon ? seeker : hider;
  const story = seekerWon
    ? `${seeker} cracked ${hider}’s ${country ? `${country} ` : ''}hunt.`
    : `${hider} outwitted ${seeker}. The treasure${country ? ` in ${country}` : ''} stayed hidden.`;
  return {
    code, role, winnerRole, personalWin, hider, seeker, winner, country, seekerWon,
    challenge: `${hider} challenged ${seeker}`,
    title: role === 'spectator' ? `${winner} wins!` : personalWin ? (seekerWon ? 'Nice hiding. Better seeking.' : 'Your secret. Your victory.') : seekerWon ? 'A worthy rival, indeed.' : 'The treasure kept its secret.',
    eyebrow: role === 'spectator' ? 'A FRIENDLY RIVALRY' : personalWin ? 'VICTORY IS YOURS' : `${winner} wins this round`,
    story,
    detail: seekerWon ? 'The clues were cracked. The treasure was found.' : 'The clock ran out before the seeker found the treasure.',
    timeUsed: Math.max(0, friendRoundSeconds(match) - friendSecondsLeft(match)),
    roundSeconds: friendRoundSeconds(match), clues: match.cluesVisible ?? 1, wrongGuesses: match.wrongGuesses ?? 0,
    completedAt: timestampMillis(match.endedAt),
    action: role === 'seeker' ? personalWin ? 'Challenge back' : 'Plot your revenge' : 'Hide a new treasure',
    canShare: role !== 'spectator',
    art: seekerWon ? '/illustrations/victory.png' : '/illustrations/defeat.png',
  };
}

export function resultContent(model) {
  const e = escapeHTML;
  return `<div class="result-brand"><span>✦</span> THE RIVALRY LOG</div>
    <p class="result-challenge-line">${e(model.challenge)}</p>
    <div class="result-roles"><span><strong>${e(model.hider)}</strong> · Hider</span><b aria-hidden="true">→</b><span><strong>${e(model.seeker)}</strong> · Seeker</span></div>
    <img class="friend-illustration" src="${model.art}" alt="${model.seekerWon ? 'A triumphant seeker claims the treasure while the rival hider looks on in frustration' : 'A defeated but determined seeker beside a closed chest and empty hourglass, with a triumphant rival hider'}" />
    <p id="friend-result-eyebrow" class="result-eyebrow">${e(model.eyebrow)}</p>
    <h2 id="friend-result-title">${e(model.title)}</h2>
    <p class="result-story">${e(model.story)}</p>
    <p class="result-explanation">${model.seekerWon ? '' : e(model.detail)}${model.role !== 'spectator' && !model.country ? ' Location unavailable.' : ''}</p>
    <div class="result-stats"><div><span class="stat-icon" aria-hidden="true">◷</span><strong>${model.timeUsed}s</strong><span>TIME USED</span></div><div><span class="stat-icon" aria-hidden="true">▤</span><strong>${model.clues}/3</strong><span>CLUES OPENED</span></div><div><span class="stat-icon" aria-hidden="true">⊗</span><strong>${model.wrongGuesses}</strong><span>WRONG GUESSES</span></div></div>
    <p class="result-cost-note">Includes time costs · ${model.roundSeconds}s hunt</p>`;
}

export function historyContent(hunts, uid) {
  return hunts.length ? hunts.map(h => {
    const complete = ['won', 'lost'].includes(h.status);
    const role = h.hiderUid === uid ? 'hider' : 'seeker';
    const model = complete ? friendResult(h, uid, null, h.code) : null;
    const time = timestampMillis(complete ? h.endedAt : h.createdAt);
    const date = time ? new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date unavailable';
    const opponent = role === 'hider' ? h.seekerName || (h.targetUsername ? `@${h.targetUsername}` : 'Awaiting an explorer') : h.hiderName || 'The hider';
    const state = complete ? model.personalWin ? 'You won' : 'You lost' : h.status === 'waiting' ? 'Not yet accepted' : 'In progress';
    return `<button type="button" class="multiplayer-log-entry" data-hunt="${escapeHTML(h.code)}"><span class="log-outcome ${model?.personalWin ? 'log-win' : ''}">${complete ? model.personalWin ? 'W' : 'L' : h.status === 'waiting' ? '…' : '↗'}</span><span><strong>${complete || h.seekerName ? 'vs ' : 'Sent to '}${escapeHTML(opponent)}</strong><small>${role === 'hider' ? 'Hider' : 'Seeker'} · ${state} · ${escapeHTML(date)}</small></span><span aria-hidden="true">↗</span></button>`;
  }).join('') : '<p class="log-empty">No friend hunts yet. Sent challenges and played games will appear here.</p>';
}
