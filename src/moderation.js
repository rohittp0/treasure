// Reporting and blocking explorers (spec decision 22). Pure helpers, so they can be tested without Firebase.
// Report kinds match the reports rule in firestore.rules: 'clue' | 'hunt' | 'profile' | 'username'.

export const REASON_LIMIT = 200;

// What can be reported where, each with the report kind it files and a fixed code for analytics.
// The explorer's own words go only into the report, never into analytics.
export const REPORT_OPTIONS = Object.freeze({
  challenge: [
    { id: 'offensive_clues', kind: 'clue', label: 'Offensive or hateful clues' },
    { id: 'harassment', kind: 'clue', label: 'Harassment or bullying' },
    { id: 'sexual', kind: 'clue', label: 'Sexual or violent content' },
    { id: 'offensive_username', kind: 'username', label: 'Offensive username' },
    { id: 'spam', kind: 'clue', label: 'Spam' },
  ],
  hunt: [
    { id: 'offensive_clues', kind: 'clue', label: 'Offensive or hateful clues' },
    { id: 'harassment', kind: 'hunt', label: 'Harassment or bullying' },
    { id: 'sexual', kind: 'clue', label: 'Sexual or violent content' },
    { id: 'offensive_username', kind: 'username', label: 'Offensive name or username' },
    { id: 'other', kind: 'hunt', label: 'Something else' },
  ],
  map: [
    { id: 'offensive_username', kind: 'username', label: 'Offensive username' },
    { id: 'harassment', kind: 'profile', label: 'Harassment or impersonation' },
    { id: 'other', kind: 'profile', label: 'Something else' },
  ],
});

export const BLOCK_REASON = 'Blocked by the reporting explorer.';

// The report's reason: the chosen option, then the explorer's own details, within the rules' 200 characters.
export function reportReason(option, details = '') {
  const extra = String(details ?? '').replace(/\s+/g, ' ').trim();
  return (extra ? `${option.label}: ${extra}` : option.label).slice(0, REASON_LIMIT);
}

// The fields of reports/{id}, minus reporterUid and createdAt, which firebase.js adds.
export function reportFields({ targetUid, kind, code = '', reason }) {
  if (typeof targetUid !== 'string' || !targetUid) throw new Error('There is no explorer to report.');
  return { targetUid, kind, ...(/^[A-HJ-NP-Z2-9]{10}$/.test(code || '') ? { code } : {}), reason: String(reason).slice(0, REASON_LIMIT) };
}

// The other explorer in a friend hunt: the seeker (or the challenged explorer) for its hider, the hider for anyone else.
export function otherExplorer(hunt, uid) {
  if (!hunt || !uid) return null;
  if (hunt.hiderUid === uid) return hunt.seekerUid || hunt.targetUid || null;
  return hunt.hiderUid || null;
}

// Challenges in the inbox, without those from blocked explorers.
export const visibleChallenges = (challenges, blocked) =>
  blocked?.size ? challenges.filter(challenge => !blocked.has(challenge.fromUid)) : challenges;

// Friend hunts in the log, without those played with blocked explorers.
export const visibleHunts = (hunts, uid, blocked) =>
  blocked?.size ? hunts.filter(hunt => !blocked.has(otherExplorer(hunt, uid))) : hunts;
