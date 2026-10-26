export const ROUND_SECONDS = 120;
export const WRONG_GUESS_COST = 5;
export const CLUE_COST = 20;
export const REVEAL_COST = 50;

export function choosePuzzle(puzzles, previousId = '', random = Math.random) {
  if (!puzzles.length) throw new Error('No hunts are available.');
  const choices = puzzles.length > 1 ? puzzles.filter(puzzle => puzzle.id !== previousId) : puzzles;
  return choices[Math.floor(random() * choices.length)];
}

export function createGame(puzzle, clock = () => Date.now()) {
  const startedAt = clock();
  let cost = 0;
  let cluesVisible = 1;
  let selected = null;
  let revealedCountry = false;
  let status = 'playing';
  let wrongGuesses = 0;
  const tried = new Set();

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
      remaining: remaining(),
      cluesVisible,
      selected,
      revealedCountry,
      wrongGuesses,
      tried: [...tried],
      startedAt,
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
