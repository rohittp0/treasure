import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import fallbackPuzzles from '../data/countries.json';
import { choosePuzzle, createGame, difficultyForLevel, CLUE_COST, REVEAL_COST } from './game.js';
import { watchUser, login, logout, loadPuzzles, saveHunt, loadHunts, loadLeaderboard, enterLeaderboard } from './firebase.js';

maplibregl.setWorkerUrl(mapWorkerUrl);

const $ = selector => document.querySelector(selector);
const elements = {
  home: $('#home-screen'), game: $('#game-panel'), result: $('#result-screen'),
  homeStatus: $('#home-status'), mapLoading: $('#map-loading'),
  hud: $('#game-hud'), timer: $('#timer-value'), progress: $('#timer-progress'), clueList: $('#clue-list'),
  clueCount: $('#clue-count'), unlock: $('#unlock-button'), reveal: $('#reveal-button'),
  sheetToggle: $('#sheet-toggle'), sheetAction: $('#sheet-toggle-action'),
  sheetCount: $('#sheet-peek-count'), sheetClue: $('#sheet-peek-clue'),
  revealNote: $('#reveal-note'), selection: $('#selection-card'), selectionName: $('#selection-name'),
  toast: $('#toast'), accountButton: $('#account-button'), accountDialog: $('#account-dialog'),
  accountContent: $('#account-content'), saveStatus: $('#save-status'),
  leaderboardRows: $('#leaderboard-rows'), leaderboardSignIn: $('#leaderboard-sign-in'),
  leaderboardNote: $('#leaderboard-note'),
};

let map;
let puzzles = fallbackPuzzles;
let user = null;
let game = null;
let selectedMapId = '';
let saved = false;
let ticker;
let toastTimeout;
let countryData;
let lastResult = null;
let pendingEntryPromise = null;
const PROGRESS_KEY = 'treasurehunch:solo-wins';
const PENDING_ENTRY_KEY = 'treasurehunch:pending-leaderboard';
const RESUME_RESULT_KEY = 'treasurehunch:resume-result';
let completedWins = readCompletedWins();
let activeLevel = completedWins + 1;

function readCompletedWins() {
  try {
    const value = Number(localStorage.getItem(PROGRESS_KEY));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function rememberCompletedWins() {
  try { localStorage.setItem(PROGRESS_KEY, String(completedWins)); } catch { /* Continue this hunt if storage is unavailable. */ }
}

function updateHomeStatus() {
  const nextLevel = completedWins + 1;
  const difficulty = difficultyForLevel(nextLevel);
  elements.homeStatus.textContent = `${puzzles.length} places to discover · Level ${String(nextLevel).padStart(2, '0')} · ${difficulty[0].toUpperCase()}${difficulty.slice(1)}`;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => elements.toast.classList.add('hidden'), 3300);
}

function clearMapSelection() {
  selectedMapId = '';
  if (map?.getLayer('selected-country')) map.setFilter('selected-country', ['==', ['get', 'id'], '']);
}

function setSheetCollapsed(collapsed) {
  document.body.classList.toggle('sheet-collapsed', collapsed);
  elements.sheetToggle.setAttribute('aria-expanded', String(!collapsed));
  elements.sheetToggle.setAttribute('aria-label', collapsed ? 'Show clues' : 'Minimise clues');
  elements.sheetAction.textContent = collapsed ? 'Show clues ↑' : 'Minimise ↓';
}

function collapseSheetForMap() {
  if (game?.snapshot().status === 'playing') setSheetCollapsed(true);
}

function selectMapCountry(country) {
  if (!game) return;
  const state = game.select(country);
  if (state.selected?.id !== country.id) {
    if (state.tried.includes(country.id)) showToast('You already ruled that country out.');
    return;
  }
  selectedMapId = country.id;
  map.setFilter('selected-country', ['==', ['get', 'id'], country.id]);
  renderSelection(state);
}

async function loadMap() {
  try {
    countryData = await fetch('/countries.geojson').then(response => {
      if (!response.ok) throw new Error('Country outlines did not load');
      return response.json();
    });
    const labels = countryData.features
      .filter(feature => Number.isFinite(feature.properties.labelX) && Number.isFinite(feature.properties.labelY))
      .map(feature => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [feature.properties.labelX, feature.properties.labelY] }, properties: feature.properties }));
    map = new maplibregl.Map({
      container: 'map',
      style: { version: 8, glyphs: `${window.location.origin}/fonts/{fontstack}/{range}.pbf`, sources: {}, layers: [{ id: 'sea', type: 'background', paint: { 'background-color': '#173740' } }] },
      center: [12, 21], zoom: window.innerWidth < 700 ? 0.85 : 1.1,
      minZoom: 0.5, maxZoom: 6, renderWorldCopies: false,
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.on('load', () => {
      map.addSource('countries', { type: 'geojson', data: countryData, generateId: false });
      map.addLayer({ id: 'land', type: 'fill', source: 'countries', paint: { 'fill-color': ['match', ['get', 'id'], ['USA', 'CAN', 'BRA', 'AUS', 'CHN', 'RUS'], '#d4ccaf', '#c4c5a8'], 'fill-opacity': 0.98 } });
      map.addLayer({ id: 'borders', type: 'line', source: 'countries', paint: { 'line-color': '#668078', 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 4, 1.4], 'line-opacity': 0.9 } });
      map.addLayer({ id: 'tried-country', type: 'fill', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'fill-color': '#314d50', 'fill-opacity': 0.55 } });
      map.addLayer({ id: 'selected-country', type: 'fill', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'fill-color': '#e4a94d', 'fill-opacity': 0.83 } });
      map.addLayer({ id: 'selected-border', type: 'line', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#fff2c3', 'line-width': 2.3 } });
      map.addSource('country-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: labels } });
      map.addLayer({ id: 'labels', type: 'symbol', source: 'country-labels', layout: { 'text-field': ['get', 'name'], 'text-size': ['interpolate', ['linear'], ['zoom'], 0, 9, 3, 12], 'text-font': ['Open Sans Semibold'], 'text-allow-overlap': false }, paint: { 'text-color': '#395a57', 'text-halo-color': '#dfdcc1', 'text-halo-width': 1.2 } });
      map.on('click', 'land', event => {
        if (!game || game.snapshot().status !== 'playing') return;
        const feature = event.features?.[0];
        if (feature) selectMapCountry({ id: feature.properties.id, country: feature.properties.name });
      });
      map.on('mouseenter', 'land', () => { map.getCanvas().style.cursor = game ? 'pointer' : 'grab'; });
      map.on('mouseleave', 'land', () => { map.getCanvas().style.cursor = ''; });
      elements.mapLoading.classList.add('hidden');
    });
    map.on('click', collapseSheetForMap);
    map.on('dragstart', collapseSheetForMap);
    map.on('zoomstart', collapseSheetForMap);
    map.on('error', error => console.warn('Map detail could not render:', error.error || error));
  } catch (error) {
    console.error(error);
    elements.mapLoading.textContent = 'The map could not load. Refresh to try again.';
  }
}

async function loadPuzzleSet() {
  try {
    const remote = await loadPuzzles();
    if (remote.length) {
      // Keep the bundled editorial set current until the Firestore seed catches up.
      const includedIds = new Set(fallbackPuzzles.map(puzzle => puzzle.id));
      puzzles = [...fallbackPuzzles, ...remote.filter(puzzle => !includedIds.has(puzzle.id))];
    }
  } catch (error) {
    console.warn('Using included clue set:', error);
  }
  updateHomeStatus();
}

function renderSelection(state) {
  const isVisible = state.status === 'playing' && !!state.selected;
  elements.selection.classList.toggle('hidden', !isVisible);
  if (isVisible) elements.selectionName.textContent = state.selected.country;
}

function renderGame() {
  if (!game) return;
  const state = game.tick();
  if (state.status !== 'playing') { finish(state); return; }
  const minutes = Math.floor(state.remaining / 60);
  const seconds = state.remaining % 60;
  elements.timer.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
  elements.progress.style.width = `${(state.remaining / 120) * 100}%`;
  elements.hud.classList.toggle('timer-urgent', state.remaining <= 30);
  elements.clueCount.textContent = `${String(state.cluesVisible).padStart(2, '0')} / 03`;
  elements.sheetCount.textContent = elements.clueCount.textContent;
  elements.sheetClue.textContent = state.revealedCountry
    ? `Treasure location: ${state.puzzle.country}`
    : state.puzzle.clues[state.cluesVisible - 1];
  elements.clueList.innerHTML = state.puzzle.clues.map((clue, index) => {
    const open = index < state.cluesVisible;
    return `<div class="clue-card ${open ? 'clue-open' : 'clue-locked'}"><span class="clue-index">${String(index + 1).padStart(2, '0')}</span><div class="clue-body"><small>${index === 0 ? 'THE FIRST WHISPER' : index === 1 ? 'A CLOSER LOOK' : 'THE FINAL PIECE'}</small><p>${open ? escapeHTML(clue) : 'This clue is still waiting to be uncovered.'}</p></div><span class="clue-state">${open ? '✦' : '⌁'}</span></div>`;
  }).join('');
  elements.unlock.classList.toggle('hidden', state.cluesVisible === 3);
  elements.unlock.disabled = state.remaining <= CLUE_COST;
  elements.reveal.classList.toggle('hidden', state.cluesVisible !== 3 || state.revealedCountry);
  elements.reveal.disabled = state.remaining <= REVEAL_COST;
  elements.revealNote.classList.toggle('hidden', !state.revealedCountry);
  if (state.revealedCountry) elements.revealNote.innerHTML = `The treasure is in <strong>${escapeHTML(state.puzzle.country)}</strong>. Find it on the map to finish the hunt.`;
  renderSelection(state);
  if (map?.getLayer('tried-country')) map.setFilter('tried-country', ['in', ['get', 'id'], ['literal', state.tried]]);
}

function startHunt() {
  if (!map?.getLayer('land')) { showToast('The map is still loading. One moment!'); return; }
  activeLevel = completedWins + 1;
  const lastId = sessionStorage.getItem('treasurehunch:last-country') || '';
  const puzzle = choosePuzzle(puzzles, lastId, Math.random, activeLevel);
  sessionStorage.setItem('treasurehunch:last-country', puzzle.id);
  $('#level-label').textContent = `LEVEL ${String(activeLevel).padStart(2, '0')} · ${difficultyForLevel(activeLevel).toUpperCase()} HUNT`;
  game = createGame(puzzle);
  saved = false;
  lastResult = null;
  clearMapSelection();
  elements.home.classList.add('hidden');
  elements.result.classList.add('hidden');
  elements.game.classList.remove('hidden');
  elements.hud.classList.remove('hidden');
  document.body.classList.add('in-game');
  setSheetCollapsed(false);
  clearInterval(ticker);
  ticker = setInterval(renderGame, 200);
  renderGame();
  map.resize();
}

function huntRecord(state) {
  return {
    huntId: crypto.randomUUID(),
    puzzleId: state.puzzle.id,
    country: state.puzzle.country,
    result: state.status === 'won' ? 'won' : 'lost',
    timeLeft: state.remaining,
    cluesUsed: state.cluesVisible,
    wrongGuesses: state.wrongGuesses,
    revealedCountry: state.revealedCountry,
    level: state.level || activeLevel,
    difficulty: state.puzzle.difficulty || difficultyForLevel(state.level || activeLevel),
  };
}

function renderLeaderboardGate() {
  if (!lastResult) return;
  const won = lastResult.status === 'won';
  const pending = !!sessionStorage.getItem(PENDING_ENTRY_KEY);
  elements.leaderboardSignIn.classList.toggle('hidden', !!user && !pending);
  elements.leaderboardSignIn.innerHTML = user
    ? 'Retry leaderboard entry <span>↗</span>'
    : won ? 'Sign in to enter this find <span>↗</span>' : 'Sign in for future finds <span>↗</span>';
  elements.leaderboardNote.textContent = won
    ? user ? pending ? 'Your find is waiting to be posted.' : 'Your best winning hunt is entered automatically.' : 'Your find is waiting. Sign in to put it on the board.'
    : 'Winning hunts are ranked by seconds remaining. Sign in to enter your next find.';
}

async function refreshLeaderboard() {
  if (!lastResult) return;
  const forResult = lastResult;
  elements.leaderboardRows.textContent = 'Loading the leaderboard…';
  try {
    const leaders = await loadLeaderboard();
    if (lastResult !== forResult) return;
    elements.leaderboardRows.innerHTML = leaders.length
      ? leaders.map((entry, index) => `<div class="leaderboard-row"><span class="leaderboard-rank">${String(index + 1).padStart(2, '0')}</span><span class="leaderboard-player"><strong>${escapeHTML(entry.name)}</strong><small>${escapeHTML(entry.country)}</small></span><strong class="leaderboard-score">${Number(entry.score)}s</strong></div>`).join('')
      : '<p class="leaderboard-empty">No finds yet. The first place is yours to claim.</p>';
  } catch (error) {
    console.error(error);
    elements.leaderboardRows.textContent = 'The leaderboard is temporarily unavailable.';
  }
}

async function saveSignedInResult(player, state) {
  let huntSaved = false;
  try {
    const hunt = huntRecord(state);
    await saveHunt(player, hunt);
    huntSaved = true;
    if (lastResult === state) elements.saveStatus.textContent = 'Saved to your explorer log.';
    if (hunt.result === 'won') await enterLeaderboard(player, hunt);
    await refreshLeaderboard();
  } catch (error) {
    console.error(error);
    if (lastResult === state) elements.saveStatus.textContent = huntSaved
      ? 'Your hunt was saved, but your score could not reach the leaderboard.'
      : 'This hunt could not be saved. Check your connection and try again later.';
  }
}

function postPendingGuestEntry(player) {
  if (!player || pendingEntryPromise) return pendingEntryPromise;
  const pending = sessionStorage.getItem(PENDING_ENTRY_KEY);
  if (!pending) return null;
  pendingEntryPromise = (async () => {
    const hunt = JSON.parse(pending);
    await enterLeaderboard(player, hunt);
    await saveHunt(player, hunt);
    sessionStorage.removeItem(PENDING_ENTRY_KEY);
    sessionStorage.removeItem(RESUME_RESULT_KEY);
    if (lastResult) elements.saveStatus.textContent = 'Your find is saved and entered on the leaderboard.';
    renderLeaderboardGate();
    await refreshLeaderboard();
  })().catch(error => {
    console.error(error);
    if (lastResult) elements.saveStatus.textContent = 'Your find is still saved on this device. Tap retry to post it.';
    renderLeaderboardGate();
  }).finally(() => { pendingEntryPromise = null; });
  return pendingEntryPromise;
}

function finish(state) {
  clearInterval(ticker);
  if (saved) return;
  saved = true;
  const won = state.status === 'won';
  const resultLevel = state.level || activeLevel;
  state.level = resultLevel;
  if (won && game) {
    completedWins += 1;
    rememberCompletedWins();
    updateHomeStatus();
  }
  lastResult = state;
  clearMapSelection();
  document.body.classList.remove('in-game');
  setSheetCollapsed(false);
  elements.hud.classList.add('hidden');
  elements.home.classList.add('hidden');
  elements.game.classList.add('hidden');
  elements.result.classList.remove('hidden');
  $('#result-art').textContent = won ? '✦' : '⌛';
  $('#result-eyebrow').textContent = `LEVEL ${String(resultLevel).padStart(2, '0')} · ${won ? 'TREASURE FOUND' : 'THE TRAIL WENT COLD'}`;
  $('#result-title').textContent = won ? 'Beautifully found.' : 'The world is still waiting.';
  $('#result-copy').textContent = won ? `You found ${state.puzzle.country} with ${state.remaining} seconds to spare. Level ${resultLevel + 1} is ready.` : `The treasure was hiding in ${state.puzzle.country}. Try level ${resultLevel} again with a new country.`;
  $('#result-stats').innerHTML = `<div><strong>${state.remaining}s</strong><span>ON THE CLOCK</span></div><div><strong>${state.cluesVisible}/3</strong><span>CLUES OPENED</span></div><div><strong>${state.wrongGuesses}</strong><span>WRONG GUESSES</span></div>`;
  $('#result-fact').textContent = state.puzzle.fact;
  elements.saveStatus.textContent = user ? 'Saving this hunt…' : won ? 'Sign in to keep this winning find.' : 'Your hunt is complete. Play again for the leaderboard.';
  if (user) saveSignedInResult(user, state);
  else if (won) {
    const previous = JSON.parse(sessionStorage.getItem(PENDING_ENTRY_KEY) || 'null');
    const current = huntRecord(state);
    if (!previous || current.timeLeft > previous.timeLeft) sessionStorage.setItem(PENDING_ENTRY_KEY, JSON.stringify(current));
  }
  renderLeaderboardGate();
  refreshLeaderboard();
}

function leaveHunt() {
  clearInterval(ticker);
  game = null;
  clearMapSelection();
  document.body.classList.remove('in-game');
  setSheetCollapsed(false);
  elements.hud.classList.add('hidden');
  elements.game.classList.add('hidden');
  elements.selection.classList.add('hidden');
  elements.home.classList.remove('hidden');
}

async function openAccount(purpose = 'log') {
  const multiplayer = purpose === 'multiplayer';
  $('#account-dialog-kicker').textContent = multiplayer ? '✦   PLAY TOGETHER' : '✦   YOUR EXPLORER LOG';
  elements.accountDialog.showModal();
  if (!user) {
    elements.accountContent.innerHTML = multiplayer
      ? '<h2>Sign in to play together.</h2><p>Multiplayer will require a Google account. Sign in now to get ready; friend hunts are coming soon.</p><button id="dialog-sign-in" class="primary-button" type="button">Sign in with Google <span>↗</span></button>'
      : '<h2>Keep your discoveries.</h2><p>Sign in with Google to save each completed hunt and revisit your explorer log.</p><button id="dialog-sign-in" class="primary-button" type="button">Continue with Google <span>↗</span></button>';
    $('#dialog-sign-in').addEventListener('click', async () => {
      try {
        await login();
        if (elements.accountDialog.open) elements.accountDialog.close();
        if (multiplayer) showToast('Signed in! Friend hunts are coming soon.');
      } catch (error) {
        showToast('Sign-in could not start. Please try again.');
        console.error(error);
      }
    });
    return;
  }
  if (multiplayer) {
    elements.accountContent.innerHTML = '<h2>You’re ready to play together.</h2><p>Multiplayer matches are still in development. Your account is ready, and solo hunts are open now.</p><button id="dialog-solo" class="primary-button" type="button">Start a solo hunt <span>↗</span></button>';
    $('#dialog-solo').addEventListener('click', () => { elements.accountDialog.close(); startHunt(); });
    return;
  }
  elements.accountContent.innerHTML = `<h2>Welcome back, ${escapeHTML(user.displayName?.split(' ')[0] || 'Explorer')}.</h2><p>Your discoveries live here.</p><div id="account-stats" class="account-stats">Loading your log…</div><button id="dialog-sign-out" class="text-button" type="button">Sign out ↗</button>`;
  $('#dialog-sign-out').addEventListener('click', async () => { await logout(); elements.accountDialog.close(); });
  try {
    const hunts = await loadHunts(user);
    if (!elements.accountDialog.open) return;
    const wins = hunts.filter(hunt => hunt.result === 'won');
    const places = new Set(wins.map(hunt => hunt.puzzleId));
    $('#account-stats').innerHTML = `<div><strong>${hunts.length}</strong><span>HUNTS PLAYED</span></div><div><strong>${wins.length}</strong><span>TREASURES FOUND</span></div><div><strong>${places.size}</strong><span>PLACES DISCOVERED</span></div>`;
  } catch (error) {
    console.error(error);
    $('#account-stats').textContent = 'Your log is temporarily unavailable.';
  }
}

$('#start-button').addEventListener('click', startHunt);
$('#multiplayer-button').addEventListener('click', () => openAccount('multiplayer'));
elements.leaderboardSignIn.addEventListener('click', async () => {
  if (!lastResult) return;
  if (user) { postPendingGuestEntry(user); return; }
  sessionStorage.setItem(RESUME_RESULT_KEY, JSON.stringify(lastResult));
  try {
    await login();
    if (user) sessionStorage.removeItem(RESUME_RESULT_KEY);
  } catch (error) {
    sessionStorage.removeItem(RESUME_RESULT_KEY);
    showToast('Sign-in could not start. Please try again.');
    console.error(error);
  }
});
$('#play-again-button').addEventListener('click', startHunt);
$('#leave-button').addEventListener('click', leaveHunt);
elements.sheetToggle.addEventListener('click', () => setSheetCollapsed(!document.body.classList.contains('sheet-collapsed')));
$('#unlock-button').addEventListener('click', () => { game?.unlock(); renderGame(); });
$('#reveal-button').addEventListener('click', () => { game?.reveal(); renderGame(); });
$('#cancel-button').addEventListener('click', () => { game?.cancel(); clearMapSelection(); renderGame(); });
$('#guess-button').addEventListener('click', () => {
  if (!game) return;
  const before = game.snapshot();
  const after = game.guess();
  if (after.status === 'playing' && before.selected) {
    clearMapSelection();
    showToast(`${before.selected.country} isn't the one. −5 seconds.`);
  }
  renderGame();
});
$('#zoom-in').addEventListener('click', () => map?.zoomIn());
$('#zoom-out').addEventListener('click', () => map?.zoomOut());
elements.accountButton.addEventListener('click', () => openAccount());
$('#close-account').addEventListener('click', () => elements.accountDialog.close());
elements.accountDialog.addEventListener('click', event => { if (event.target === elements.accountDialog) elements.accountDialog.close(); });

loadMap();
loadPuzzleSet();
try {
  const resumed = sessionStorage.getItem(RESUME_RESULT_KEY);
  if (resumed) {
    sessionStorage.removeItem(RESUME_RESULT_KEY);
    finish(JSON.parse(resumed));
  }
} catch (error) {
  console.warn('Could not restore the last result:', error);
  sessionStorage.removeItem(RESUME_RESULT_KEY);
}

watchUser(nextUser => {
  user = nextUser;
  elements.accountButton.innerHTML = nextUser ? `<span class="account-avatar">${escapeHTML((nextUser.displayName || 'E')[0])}</span><span class="account-label">My log</span>` : 'Sign in <span aria-hidden="true">↗</span>';
  elements.accountButton.setAttribute('aria-label', nextUser ? 'Open explorer log' : 'Sign in with Google');
  $('#multiplayer-hint').textContent = nextUser ? 'You’re signed in · Coming soon' : 'Sign in required · Coming soon';
  renderLeaderboardGate();
  if (nextUser) {
    sessionStorage.removeItem(RESUME_RESULT_KEY);
    postPendingGuestEntry(nextUser);
    loadHunts(nextUser).then(hunts => {
      if (user?.uid !== nextUser.uid) return;
      const remoteWins = hunts.filter(hunt => hunt.result === 'won').length;
      if (remoteWins > completedWins) {
        completedWins = remoteWins;
        rememberCompletedWins();
        updateHomeStatus();
      }
    }).catch(error => console.warn('Could not sync explorer level:', error));
  }
});
