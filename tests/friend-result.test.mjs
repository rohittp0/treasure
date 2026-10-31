import test from 'node:test';
import assert from 'node:assert/strict';
import { friendResult, resultContent, friendHuntHistory, historyContent } from '../src/friend-result.js';
import { sharePosterFile } from '../src/friend-poster.js';
const match = { hiderUid: 'h', seekerUid: 's', hiderName: 'Rohit', seekerName: 'Maya', status: 'won', startedAt: 100000, endedAt: 130000, roundSeconds: 180, costSeconds: 45, cluesVisible: 3, wrongGuesses: 1 };
for (const status of ['won', 'lost']) for (const role of ['hider', 'seeker', 'spectator']) {
  test(`${role} viewing ${status} celebrates the correct winner`, () => {
    const uid = { hider: 'h', seeker: 's', spectator: 'other' }[role];
    const model = friendResult({ ...match, status }, uid, { country: 'Japan' });
    assert.equal(model.role, role);
    assert.equal(model.winner, status === 'won' ? 'Maya' : 'Rohit');
    assert.equal(model.personalWin, role === (status === 'won' ? 'seeker' : 'hider'));
    assert.equal(model.canShare, role !== 'spectator');
    assert.equal(model.country, role === 'spectator' ? null : 'Japan');
    if (role === 'spectator') assert.doesNotMatch(resultContent(model), /Japan|TREASURE LOCATION/);
    if (role === 'seeker') assert.equal(model.action, status === 'won' ? 'Challenge back' : 'Plot your revenge');
  });
}
test('timing includes all paid costs and preserves legacy duration', () => {
  assert.equal(friendResult(match, 's').timeUsed, 75);
  const legacy = { ...match, roundSeconds: undefined, startedAt: { toMillis: () => 100000 }, endedAt: { toMillis: () => 130000 } };
  assert.equal(friendResult(legacy, 's').roundSeconds, 120);
  assert.equal(friendResult(legacy, 's').timeUsed, 75);
  assert.equal(friendResult({ ...legacy, status: 'lost', endedAt: 900000 }, 'h').timeUsed, 120);
  assert.equal(friendResult({ ...match, costSeconds: 75 }, 's').timeUsed, 105);
});
test('missing country stays usable and dynamic text is escaped', () => {
  const model = friendResult({ ...match, hiderName: '<script>' + 'x'.repeat(200) }, 's');
  assert.match(resultContent(model), /Location unavailable/);
  assert.doesNotMatch(resultContent(model), /<script>/);
  assert.match(resultContent(model), /&lt;script&gt;/);
});
test('existing games are deduplicated, including sent and active, sorted by date', () => {
  const hunts = friendHuntHistory([{ ...match, code: 'a' }, { ...match, code: 'b', endedAt: 150000 }, { ...match, code: 'a' }, { ...match, code: 'c', status: 'playing', endedAt: null, createdAt: 160000 }]);
  assert.deepEqual(hunts.map(h => h.code), ['c', 'b', 'a']);
  assert.match(historyContent(hunts, 'h'), /Hider · You lost/);
  assert.match(historyContent([], 'h'), /No friend hunts/);
});
test('native share, cancellation, unsupported sharing and failed sharing', async () => {
  const blob = new Blob(['png'], { type: 'image/png' });
  let downloads = 0;
  const download = file => { downloads++; assert.equal(file.type, 'image/png'); assert.equal(file.name, 'treasurehunch-ABC.png'); };
  assert.equal(await sharePosterFile(blob, 'ABC', { canShare: () => true, share: async () => {} }, download), 'shared');
  assert.equal(await sharePosterFile(blob, 'ABC', { canShare: () => true, share: async () => { throw Object.assign(new Error(), { name: 'AbortError' }); } }, download), 'cancelled');
  assert.equal(downloads, 0);
  assert.equal(await sharePosterFile(blob, 'ABC', {}, download), 'downloaded');
  assert.equal(await sharePosterFile(blob, 'ABC', { canShare: () => false }, download), 'downloaded');
  assert.equal(await sharePosterFile(blob, 'ABC', { canShare: () => true, share: async () => { throw new Error(); } }, download), 'downloaded');
  assert.equal(downloads, 3);
});

test('sent challenges show acceptance state instead of a loss', () => {
  const html = historyContent([{ ...match, status: 'waiting', seekerName: null, targetUsername: 'maya', code: 'ABC' }], 'h');
  assert.match(html, /Sent to @maya/);
  assert.match(html, /Not yet accepted/);
  assert.doesNotMatch(html, /You lost/);
});
