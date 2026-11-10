import { CLUE_COST, REVEAL_COST } from './game.js';

export const clockText = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

// Everything the hunt sheet, selection card and tried-country layer show, apart from the clock.
// The timer ticks five times a second, so the sheet is rebuilt only when this key changes.
export function huntSheetKey(state) {
  return JSON.stringify([
    state.puzzle?.id, state.cluesVisible, state.revealedCountry, state.selected?.id || '', state.tried,
    state.remaining <= CLUE_COST, state.remaining <= REVEAL_COST,
  ]);
}
