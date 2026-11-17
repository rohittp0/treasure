import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK_REASON, REPORT_OPTIONS, otherExplorer, reportFields, reportReason, visibleChallenges, visibleHunts } from '../src/moderation.js';
import { EVENTS, createEventTracker } from '../src/events.js';
import { readFileSync } from 'node:fs';

test('report options file only kinds the rules accept', () => {
  for (const options of Object.values(REPORT_OPTIONS)) {
    assert.ok(options.length > 0);
    for (const option of options) {
      assert.ok(['clue', 'hunt', 'profile', 'username'].includes(option.kind), option.id);
      assert.match(option.id, /^[a-z_]{1,40}$/);
    }
  }
});

test('a report reason joins the choice and the details within 200 characters', () => {
  const option = REPORT_OPTIONS.hunt[0];
  assert.equal(reportReason(option), option.label);
  assert.equal(reportReason(option, '  rude \n words  '), `${option.label}: rude words`);
  assert.equal(reportReason(option, 'x'.repeat(500)).length, 200);
  assert.ok(BLOCK_REASON.length <= 200);
});

test('report fields keep a valid hunt code only', () => {
  assert.deepEqual(reportFields({ targetUid: 'u1', kind: 'clue', code: 'ABCDEFGHJK', reason: 'r' }), { targetUid: 'u1', kind: 'clue', code: 'ABCDEFGHJK', reason: 'r' });
  assert.deepEqual(reportFields({ targetUid: 'u1', kind: 'profile', code: 'bad', reason: 'r' }), { targetUid: 'u1', kind: 'profile', reason: 'r' });
  assert.throws(() => reportFields({ targetUid: '', kind: 'profile', reason: 'r' }));
});

test('the other explorer in a hunt depends on who is looking', () => {
  const hunt = { hiderUid: 'h', seekerUid: 's', targetUid: 's' };
  assert.equal(otherExplorer(hunt, 'h'), 's');
  assert.equal(otherExplorer(hunt, 's'), 'h');
  assert.equal(otherExplorer({ hiderUid: 'h', seekerUid: null, targetUid: 't' }, 'h'), 't');
  assert.equal(otherExplorer({ hiderUid: 'h', seekerUid: null, targetUid: null }, 'h'), null);
  assert.equal(otherExplorer(null, 'h'), null);
});

test("blocked explorers' challenges and friend hunts are hidden", () => {
  const blocked = new Set(['bad']);
  const challenges = [{ code: 'A', fromUid: 'bad' }, { code: 'B', fromUid: 'good' }];
  assert.deepEqual(visibleChallenges(challenges, blocked).map(item => item.code), ['B']);
  assert.equal(visibleChallenges(challenges, new Set()), challenges);
  const hunts = [
    { code: 'A', hiderUid: 'me', seekerUid: 'bad' },
    { code: 'B', hiderUid: 'bad', seekerUid: 'me' },
    { code: 'C', hiderUid: 'me', seekerUid: null, targetUid: 'bad' },
    { code: 'D', hiderUid: 'me', seekerUid: 'good' },
    { code: 'E', hiderUid: 'me', seekerUid: null, targetUid: null },
  ];
  assert.deepEqual(visibleHunts(hunts, 'me', blocked).map(hunt => hunt.code), ['D', 'E']);
});

test('report and block events carry only fixed codes', () => {
  assert.equal(EVENTS.REPORT_SENT, 'report_sent');
  assert.equal(EVENTS.EXPLORER_BLOCKED, 'explorer_blocked');
  assert.equal(EVENTS.USERNAME_CLAIM_FALLBACK, 'username_claim_fallback');
  const calls = [];
  const tracker = createEventTracker({ google: (...args) => calls.push(args) });
  tracker.track(EVENTS.REPORT_SENT, { source: 'inbox', reason: 'offensive_clues', uid: 'secret', code: 'ABCDEFGHJK' });
  tracker.track(EVENTS.EXPLORER_BLOCKED, { source: 'map', uid: 'secret' });
  assert.deepEqual(calls.map(call => call[1]), [
    { source: 'inbox', reason: 'offensive_clues', account_status: 'guest' },
    { source: 'map', account_status: 'guest' },
  ]);
});

test("the server recognises the app's block reports by the same reason", () => {
  const server = readFileSync(new URL('../functions/moderation.js', import.meta.url), 'utf8');
  assert.ok(server.includes(`const BLOCK_REASON = '${BLOCK_REASON}';`), 'BLOCK_REASON differs between src/moderation.js and functions/moderation.js');
});
