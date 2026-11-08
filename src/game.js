export const ROUND_SECONDS = 180;
export const WRONG_GUESS_COST = 5;
export const CLUE_COST = 20;
export const REVEAL_COST = 30;

// Levels 1–2 easy, 3–5 medium, 6–10 hard, and 11 onward expert (20 expert countries cover levels 11–30).
export const EXPERT_FROM_LEVEL = 11;

export function difficultyForLevel(level) {
  if (level <= 2) return 'easy';
  if (level <= 5) return 'medium';
  if (level < EXPERT_FROM_LEVEL) return 'hard';
  return 'expert';
}

// Prefers countries the explorer has not found yet, so every level up to the end of a pool is new.
export function choosePuzzle(puzzles, previousId = '', random = Math.random, level = 1, foundIds = []) {
  if (!puzzles.length) throw new Error('No hunts are available.');
  const matching = puzzles.filter(puzzle => puzzle.difficulty === difficultyForLevel(level));
  const pool = matching.length ? matching : puzzles;
  const found = new Set(foundIds);
  const fresh = pool.filter(puzzle => !found.has(puzzle.id));
  const candidates = fresh.length ? fresh : pool;
  const choices = candidates.length > 1 ? candidates.filter(puzzle => puzzle.id !== previousId) : candidates;
  return choices[Math.floor(random() * choices.length)];
}

// `saved` resumes an earlier attempt (used by the daily quest after a page reload).
export function createGame(puzzle, clock = () => Date.now(), saved = null) {
  const startedAt = Number.isFinite(saved?.startedAt) ? saved.startedAt : clock();
  let cost = Number.isInteger(saved?.costSeconds) && saved.costSeconds >= 0 ? saved.costSeconds : 0;
  let cluesVisible = [1, 2, 3].includes(saved?.cluesVisible) ? saved.cluesVisible : 1;
  let selected = null;
  let revealedCountry = cluesVisible === 3 && saved?.revealedCountry === true;
  let status = 'playing';
  let wrongGuesses = Number.isInteger(saved?.wrongGuesses) && saved.wrongGuesses >= 0 ? saved.wrongGuesses : 0;
  const tried = new Set(Array.isArray(saved?.tried) ? saved.tried.filter(id => typeof id === 'string') : []);

  function remaining() {
    return Math.max(0, Math.ceil((startedAt + ROUND_SECONDS * 1000 - clock() - cost * 1000) / 1000));
  }

  function tick() {
    if (status === 'playing' && remaining() <= 0) status = 'lost';
    return snapshot();
  }

  function snapshot() {
    return {
      puzzle,
      status,
      roundSeconds: ROUND_SECONDS,
      remaining: remaining(),
      cluesVisible,
      selected,
      revealedCountry,
      wrongGuesses,
      tried: [...tried],
      startedAt,
      costSeconds: cost,
    };
  }

  function select(country) {
    tick();
    if (status !== 'playing' || !country || tried.has(country.id)) return snapshot();
    selected = country;
    return snapshot();
  }

  function cancel() {
    selected = null;
    return snapshot();
  }

  function guess() {
    tick();
    if (status !== 'playing' || !selected) return snapshot();
    if (selected.id === puzzle.id) {
      status = 'won';
    } else {
      tried.add(selected.id);
      wrongGuesses += 1;
      cost += WRONG_GUESS_COST;
      selected = null;
      tick();
    }
    return snapshot();
  }

  function unlock() {
    tick();
    if (status !== 'playing' || cluesVisible >= 3 || remaining() <= CLUE_COST) return snapshot();
    cost += CLUE_COST;
    cluesVisible += 1;
    return snapshot();
  }

  function reveal() {
    tick();
    if (status !== 'playing' || cluesVisible !== 3 || revealedCountry || remaining() <= REVEAL_COST) return snapshot();
    cost += REVEAL_COST;
    revealedCountry = true;
    return snapshot();
  }

  return { snapshot, tick, select, cancel, guess, unlock, reveal };
}
