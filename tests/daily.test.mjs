import test from 'node:test';
import assert from 'node:assert/strict';
import puzzles from '../data/countries.json' with { type: 'json' };
import schedules from '../data/daily-quests.json' with { type: 'json' };
import { dayKey, monthKey, daysInMonth, dailyQuest, validDailySchedule, monthSchedule, currentStreak, scoreMonth, atlasFromRecords, mergeDailyRecords, msUntilNextDay } from '../src/daily.js';
import { createGame } from '../src/game.js';

test('day and month keys use UTC', () => {
  assert.equal(dayKey(Date.UTC(2026, 10, 7, 23, 59)), '2026-11-07');
  assert.equal(dayKey(Date.UTC(2026, 10, 8, 0, 0)), '2026-11-08');
  assert.equal(monthKey(Date.UTC(2026, 1, 3)), '2026-02');
  assert.equal(daysInMonth('2028-02'), 29);
  assert.equal(msUntilNextDay(Date.UTC(2026, 10, 7, 23, 0)), 3_600_000);
});

test('each day takes its country from that month\'s list', () => {
  assert.equal(dailyQuest(schedules, '2026-11-01').id, schedules['2026-11'][0].id);
  assert.equal(dailyQuest(schedules, '2026-12-31').id, schedules['2026-12'][30].id);
  for (const [month, days] of Object.entries(schedules)) assert.ok(validDailySchedule(days, month), month);
});

test('the daily list never repeats a country and is separate from solo levels', () => {
  const daily = Object.values(schedules).flat().map(puzzle => puzzle.id);
  assert.equal(new Set(daily).size, daily.length);
  const solo = new Set(puzzles.map(puzzle => puzzle.id));
  assert.deepEqual(daily.filter(id => solo.has(id)), []);
});

test('a month without a list still gets a stable, non-repeating schedule', () => {
  const january = Array.from({ length: 31 }, (_, index) => dailyQuest(schedules, `2027-01-${String(index + 1).padStart(2, '0')}`).id);
  assert.equal(new Set(january).size, 31);
  assert.equal(dailyQuest(schedules, '2027-01-05').id, dailyQuest({ ...schedules }, '2027-01-05').id);
  assert.notDeepEqual(monthSchedule(puzzles, '2026-11').map(p => p.id), monthSchedule(puzzles, '2026-12').map(p => p.id));
});

const won = (day, timeUsed, puzzleId = 'JPN') => ({ day, status: 'won', timeUsed, puzzleId });
const lost = day => ({ day, status: 'lost', timeUsed: 180, puzzleId: 'PER' });

test('streaks count consecutive finds and survive an unplayed today', () => {
  const records = [won('2026-11-04', 30), won('2026-11-05', 40), won('2026-11-06', 50)];
  assert.equal(currentStreak(records, '2026-11-06'), 3);
  assert.equal(currentStreak(records, '2026-11-07'), 3);
  assert.equal(currentStreak(records, '2026-11-08'), 0);
  assert.equal(currentStreak([...records, lost('2026-11-07')], '2026-11-07'), 0);
});

test('monthly score ranks finds first and then less time used', () => {
  const score = scoreMonth([won('2026-11-01', 30), won('2026-11-02', 70), lost('2026-11-03'), won('2026-10-31', 10)], '2026-11');
  assert.deepEqual(score, { month: '2026-11', found: 2, played: 3, timeUsed: 100, rankScore: 19_900 });
  const faster = scoreMonth([won('2026-11-01', 20), won('2026-11-02', 20)], '2026-11');
  const moreFinds = scoreMonth([won('2026-11-01', 170), won('2026-11-02', 170), won('2026-11-03', 170)], '2026-11');
  assert.ok(faster.rankScore > score.rankScore);
  assert.ok(moreFinds.rankScore > faster.rankScore);
});

test('the explorer map keeps the first day each country was claimed', () => {
  const atlas = atlasFromRecords([won('2026-12-02', 50, 'JPN'), won('2026-11-02', 50, 'JPN'), won('2026-11-03', 20, 'FRA'), lost('2026-11-04')]);
  assert.deepEqual(atlas, { JPN: '2026-11-02', FRA: '2026-11-03' });
});

test('finished records win over in-progress ones when merging devices', () => {
  const merged = mergeDailyRecords([{ day: '2026-11-07', status: 'playing' }], [won('2026-11-07', 20), won('2026-11-06', 30)]);
  assert.deepEqual(merged.map(record => [record.day, record.status]), [['2026-11-06', 'won'], ['2026-11-07', 'won']]);
});

test('a daily attempt resumes with its clock, clues and wrong guesses', () => {
  let now = 1_000_000;
  const puzzle = puzzles[0];
  const first = createGame(puzzle, () => now);
  first.unlock();
  first.select({ id: 'XXX', country: 'Nowhere' });
  first.guess();
  const saved = first.snapshot();
  now += 10_000;
  const resumed = createGame(puzzle, () => now, saved).snapshot();
  assert.equal(resumed.cluesVisible, 2);
  assert.equal(resumed.wrongGuesses, 1);
  assert.deepEqual(resumed.tried, ['XXX']);
  assert.equal(resumed.remaining, 180 - 10 - 25);
});

test('daily quest links are attributed to the alert that sent them', async () => {
  const { dailyLinkSource } = await import('../src/daily.js');
  assert.equal(dailyLinkSource('?daily=1'), 'whatsapp');
  assert.equal(dailyLinkSource('?daily=1&utm_source=push&utm_medium=notification'), 'push');
  assert.equal(dailyLinkSource('?daily=1&utm_source=WhatsApp'), 'whatsapp');
  assert.equal(dailyLinkSource('?daily=1&utm_source=<script>'), 'whatsapp');
  assert.equal(dailyLinkSource('?hunt=ABC&utm_source=push'), '');
  assert.equal(dailyLinkSource(''), '');
});
