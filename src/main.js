import { trackEvent, EVENTS, setAnalyticsUser, soloEventParameters } from './events.js';
import { historyContent } from './friend-result.js';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import fallbackPuzzles from '../data/countries.json';
import { choosePuzzle, createGame, difficultyForLevel, CLUE_COST, REVEAL_COST } from './game.js';
import { loadFriendHunts, watchUser, login, logout, loadPuzzles, saveHunt, loadHunts, loadLeaderboard, enterLeaderboard, loadProfile, claimUsername, isUsernameAvailable, watchChallenges, markChallengeRead, registerChallengePush } from './firebase.js';
import { createFriendController } from './friend-controller.js';

maplibregl.setWorkerUrl(mapWorkerUrl);

// Safari still emits its own gesture events even when touch-action blocks page zoom.
document.addEventListener('gesturestart', event => event.preventDefault(), { passive: false });

const $ = selector => document.querySelector(selector);
const elements = {
  home: $('#home-screen'), game: $('#game-panel'), result: $('#result-screen'),
  homeStatus: $('#home-status'), homeUsername: $('#home-username'), mapLoading: $('#map-loading'),
  hud: $('#game-hud'), timer: $('#timer-value'), progress: $('#timer-progress'), clueList: $('#clue-list'),
  clueCount: $('#clue-count'), unlock: $('#unlock-button'), reveal: $('#reveal-button'),
  sheetToggle: $('#sheet-toggle'), sheetAction: $('#sheet-toggle-action'),
  sheetCount: $('#sheet-peek-count'), sheetClue: $('#sheet-peek-clue'),
  revealNote: $('#reveal-note'), selection: $('#selection-card'), selectionName: $('#selection-name'),
  toast: $('#toast'), accountButton: $('#account-button'), accountDialog: $('#account-dialog'),
  accountContent: $('#account-content'), saveStatus: $('#save-status'),
  leaderboardScreen: $('#leaderboard-screen'), leaderboardRows: $('#leaderboard-rows'), leaderboardSignIn: $('#leaderboard-sign-in'),
  leaderboardNote: $('#leaderboard-note'),
};

let map;
let puzzles = fallbackPuzzles;
let user = null;
let username = '';
let stopChallenges = null;
let welcomeFor = null;
let authVersion = 0;
let game = null;
let selectedMapId = '';
let saved = false;
let ticker;
let toastTimeout;
let victoryTimeout;
let countryData;
let lastResult = null;
let pendingEntryPromise = null;
let leaderboardSyncFailed = false;
let leaderboardReturn = 'home';
let leaderboardOpenedHere = false;
let leaderboardLoadVersion = 0;
let usernameCheckVersion = 0;
let usernameCheckTimer;
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

function renderUsername() {
  elements.homeUsername.classList.toggle('hidden', !username);
  elements.homeUsername.textContent = username ? `✦ EXPLORING AS @${username}` : '';
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

function playVictory(card) {
  card.classList.remove('victory');
  void card.offsetWidth;
  card.classList.add('victory');
  const effects = $('#victory-effects');
  effects.replaceChildren();
  clearTimeout(victoryTimeout);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const flash = document.createElement('div');
  flash.className = 'victory-flash';
  effects.append(flash);
  const colors = ['#f4c56b', '#fff0b8', '#c87b4b', '#5b9994', '#f7e5c3'];
  for (let index = 0; index < 42; index += 1) {
    const angle = (index / 42) * Math.PI * 2 + (Math.random() - .5) * .22;
    const distance = 115 + Math.random() * Math.min(window.innerWidth * .4, 240);
    const particle = document.createElement('i');
    particle.className = 'victory-particle';
    particle.style.setProperty('--x', `${Math.cos(angle) * distance}px`);
    particle.style.setProperty('--y', `${Math.sin(angle) * distance + 65}px`);
    particle.style.setProperty('--spin', `${Math.round((Math.random() - .5) * 900)}deg`);
    particle.style.setProperty('--delay', `${Math.random() * .18}s`);
    particle.style.backgroundColor = colors[index % colors.length];
    effects.append(particle);
  }
  victoryTimeout = setTimeout(() => effects.replaceChildren(), 3100);
}

function clearVictory() {
  clearTimeout(victoryTimeout);
  $('#victory-effects').replaceChildren();
  elements.result.classList.remove('victory');
  $('#friend-result').classList.remove('victory');
}

function browserNotificationsAvailable() {
  return typeof Notification !== 'undefined' && window.isSecureContext;
}

function showWelcome(player, existingUsername = '') {
  welcomeFor = player;
  clearTimeout(usernameCheckTimer);
  usernameCheckVersion += 1;
  const input = $('#welcome-username');
  input.value = existingUsername;
  input.readOnly = !!existingUsername;
  input.required = !existingUsername;
  const saveButton = $('#welcome-save');
  saveButton.textContent = existingUsername ? 'Continue to TreasureHunch ↗' : 'Save and continue ↗';
  saveButton.disabled = !existingUsername;
  $('#welcome-status').textContent = existingUsername
    ? `Your username is @${existingUsername}.`
    : 'Enter a username to check if it is available.';
  $('#welcome-status').dataset.state = existingUsername ? 'available' : 'idle';
  const notificationButton = $('#welcome-notifications');
  const notificationStatus = $('#notification-status');
  notificationButton.classList.toggle('hidden', !browserNotificationsAvailable() || Notification.permission !== 'default');
  notificationStatus.textContent = !browserNotificationsAvailable()
    ? 'Browser notifications are unavailable here. Challenges will still appear in your inbox.'
    : Notification.permission === 'granted' ? 'Browser notifications are on.'
      : Notification.permission === 'denied' ? 'Browser notifications are off. Challenges will still appear in your inbox.'
        : 'Tap to allow alerts when a friend challenges you, or continue without them.';
  if (!$('#welcome-dialog').open) $('#welcome-dialog').showModal();
  if (!existingUsername) setTimeout(() => input.focus(), 0);
}

function watchInbox(player) {
  stopChallenges?.();
  let firstSnapshot = true;
  let known = new Set();
  stopChallenges = watchChallenges(player, challenges => {
    if (user?.uid !== player.uid) return;
    const unread = challenges.filter(challenge => !challenge.read);
    $('#account-challenge-count').textContent = String(unread.length);
    $('#account-challenge-count').classList.toggle('hidden', unread.length === 0);
    elements.accountButton.setAttribute('aria-label', unread.length
      ? `Open explorer log, ${unread.length} new ${unread.length === 1 ? 'challenge' : 'challenges'}`
      : 'Open explorer log');
    $('#challenge-inbox-count').textContent = String(unread.length);
    $('#challenge-list').innerHTML = challenges.length
      ? challenges.map(challenge => `<button class="challenge-item ${challenge.read ? '' : 'unread'}" type="button" data-code="${escapeHTML(challenge.code)}"><span><strong>@${escapeHTML(challenge.fromUsername)}</strong> hid a treasure for you.<small>${challenge.read ? 'Open hunt' : 'New challenge · open hunt'}</small></span><span aria-hidden="true">↗</span></button>`).join('')
      : 'No challenges yet. Ask a friend to find you by username.';
    if (!firstSnapshot && document.visibilityState === 'visible' && browserNotificationsAvailable() && Notification.permission === 'granted') {
      for (const challenge of unread) {
        if (!known.has(challenge.id)) {
          try {
            const alert = new Notification('A TreasureHunch challenge awaits', { body: `@${challenge.fromUsername} hid a treasure for you.`, tag: `hunt-${challenge.code}` });
            alert.onclick = () => { window.focus(); friend.joinCode(challenge.code).catch(error => showToast(error.message)); alert.close(); };
          } catch (error) { console.warn('Browser alert was unavailable:', error); }
        }
      }
    }
    known = new Set(challenges.map(challenge => challenge.id));
    firstSnapshot = false;
  }, error => console.warn('Could not load challenges:', error));
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
  if (friend.mode === 'seeker' || friend.mode === 'hiding') { friend.collapseOnMap(); return; }
  if (game?.snapshot().status === 'playing') setSheetCollapsed(true);
}

function selectMapCountry(country) {
  if (!game) return;
  const state = game.select(country);
  if (state.selected?.id !== country.id) {
    if (state.tried.includes(country.id)) showToast('You already ruled that country out.');
    return;
  }
  trackEvent(EVENTS.COUNTRY_SELECTED, { ...soloEventParameters(state, activeLevel), method: 'map' });
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
        const feature = event.features?.[0];
        if (!feature) return;
        if (friend.mapCountry(feature, event.lngLat)) return;
        if (game?.snapshot().status === 'playing') selectMapCountry({ id: feature.properties.id, country: feature.properties.name });
      });
      map.on('mouseenter', 'land', () => { map.getCanvas().style.cursor = game || ['hiding', 'seeker'].includes(friend.mode) ? 'pointer' : 'grab'; });
      map.on('mouseleave', 'land', () => { map.getCanvas().style.cursor = ''; });
      elements.mapLoading.classList.add('hidden');
    });
    map.on('click', collapseSheetForMap);
    map.on('dragstart', collapseSheetForMap);
    map.on('zoomstart', () => {
      if (friend.mode === 'hiding' && friend.suppressSearchZoom) return;
      collapseSheetForMap();
    });
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
  elements.progress.style.width = `${(state.remaining / state.roundSeconds) * 100}%`;
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
  if (friend.mode !== 'idle') friend.home();
  clearVictory();
  activeLevel = completedWins + 1;
  const lastId = sessionStorage.getItem('treasurehunch:last-country') || '';
  const puzzle = choosePuzzle(puzzles, lastId, Math.random, activeLevel);
  sessionStorage.setItem('treasurehunch:last-country', puzzle.id);
  $('#level-label').textContent = `LEVEL ${String(activeLevel).padStart(2, '0')} · ${difficultyForLevel(activeLevel).toUpperCase()} HUNT`;
  game = createGame(puzzle);
  trackEvent(EVENTS.HUNT_STARTED, soloEventParameters(game.snapshot(), activeLevel));
  saved = false;
  lastResult = null;
  clearMapSelection();
  elements.home.classList.add('hidden');
  elements.result.classList.add('hidden');
  elements.game.classList.remove('hidden');
  elements.hud.classList.remove('hidden');
  document.body.classList.add('in-game', 'solo-game');
  $('#end-level-button').classList.remove('hidden');
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
    roundSeconds: state.roundSeconds ?? 120,
    cluesUsed: state.cluesVisible,
    wrongGuesses: state.wrongGuesses,
    revealedCountry: state.revealedCountry,
    level: state.level || activeLevel,
    difficulty: state.puzzle.difficulty || difficultyForLevel(state.level || activeLevel),
  };
}

function pendingGuestHunts() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(PENDING_ENTRY_KEY) || 'null');
    return Array.isArray(stored) ? stored : stored ? [stored] : [];
  } catch {
    return [];
  }
}

function rememberPendingGuestHunt(hunt) {
  const pending = pendingGuestHunts();
  if (!pending.some(item => item.level === hunt.level && item.puzzleId === hunt.puzzleId && item.timeLeft === hunt.timeLeft))
    pending.push(hunt);
  sessionStorage.setItem(PENDING_ENTRY_KEY, JSON.stringify(pending));
}

function renderLeaderboardGate() {
  if (!lastResult) return;
  const won = lastResult.status === 'won';
  const pending = pendingGuestHunts().length > 0;
  elements.leaderboardSignIn.classList.toggle('hidden', !!user && !!username && !pending && !leaderboardSyncFailed);
  elements.leaderboardSignIn.innerHTML = user && !username
    ? 'Choose your username <span>↗</span>'
    : user ? 'Retry leaderboard entry <span>↗</span>'
    : won ? 'Sign in to enter this find <span>↗</span>' : 'Sign in for future finds <span>↗</span>';
  elements.leaderboardNote.textContent = won
    ? user ? !username ? 'Choose an available username to enter this find.' : pending ? 'Your finds are waiting to be posted.' : leaderboardSyncFailed ? 'Your score needs another try to update.' : 'Your weighted average updates after each winning level.' : 'Your find is waiting. Sign in to put it on the board.'
    : user ? '' : 'Winning levels are ranked by weighted average time used. Sign in to enter your next find.';
  $('#result-leaderboard').classList.toggle('hidden', !won && !!user && !!username && !pending && !leaderboardSyncFailed);
}

async function refreshLeaderboard() {
  if (elements.leaderboardScreen.classList.contains('hidden')) return;
  const version = ++leaderboardLoadVersion;
  elements.leaderboardRows.textContent = 'Loading the leaderboard…';
  try {
    const leaders = await loadLeaderboard();
    if (version !== leaderboardLoadVersion) return;
    elements.leaderboardRows.innerHTML = leaders.length
      ? leaders.map((entry, index) => `<div class="leaderboard-row"><span class="leaderboard-rank">${String(index + 1).padStart(2, '0')}</span><span class="leaderboard-player"><strong>@${escapeHTML(entry.name)}</strong><small>${Number(entry.levelsCompleted)} ${entry.levelsCompleted === 1 ? 'level' : 'levels'} · reached level ${Number(entry.highestLevel)}</small></span><strong class="leaderboard-score">${(Number(entry.averageTenths) / 10).toFixed(1)}s<small>AVG</small></strong></div>`).join('')
      : '<p class="leaderboard-empty">No finds yet. The first place is yours to claim.</p>';
  } catch (error) {
    if (version !== leaderboardLoadVersion) return;
    console.error(error);
    elements.leaderboardRows.textContent = 'The leaderboard is temporarily unavailable.';
  }
}

function showLeaderboard() {
  if (!elements.leaderboardScreen.classList.contains('hidden')) return;
  clearVictory();
  elements.home.classList.add('hidden');
  elements.result.classList.add('hidden');
  elements.leaderboardScreen.classList.remove('hidden');
  refreshLeaderboard();
}

function restoreFromLeaderboard() {
  elements.leaderboardScreen.classList.add('hidden');
  const returnToResult = leaderboardReturn === 'result' && !!lastResult;
  elements.home.classList.toggle('hidden', returnToResult);
  elements.result.classList.toggle('hidden', !returnToResult);
}

function openLeaderboard() {
  trackEvent(EVENTS.LEADERBOARD_VIEWED, { source: elements.result.classList.contains('hidden') ? 'home' : 'result' });
  leaderboardReturn = elements.result.classList.contains('hidden') ? 'home' : 'result';
  leaderboardOpenedHere = true;
  location.hash = 'leaderboard';
  showLeaderboard();
}

function closeLeaderboard() {
  if (leaderboardOpenedHere) {
    history.back();
  } else {
    history.replaceState({}, '', `${location.pathname}${location.search}`);
    restoreFromLeaderboard();
  }
}

async function saveSignedInResult(player, state) {
  let huntSaved = false;
  try {
    const hunt = huntRecord(state);
    await saveHunt(player, hunt);
    huntSaved = true;
    if (lastResult === state) elements.saveStatus.textContent = 'Saved to your explorer log.';
    if (hunt.result === 'won') await enterLeaderboard(player);
    leaderboardSyncFailed = false;
    renderLeaderboardGate();
    await refreshLeaderboard();
  } catch (error) {
    console.error(error);
    leaderboardSyncFailed = huntSaved;
    renderLeaderboardGate();
    if (lastResult === state) elements.saveStatus.textContent = huntSaved
      ? 'Your hunt was saved, but your score could not reach the leaderboard.'
      : 'This hunt could not be saved. Check your connection and try again later.';
  }
}

function postPendingGuestEntry(player) {
  if (!player || pendingEntryPromise) return pendingEntryPromise;
  const pending = pendingGuestHunts();
  pendingEntryPromise = (async () => {
    for (const hunt of pending) await saveHunt(player, hunt);
    await enterLeaderboard(player);
    if (pending.length) {
      sessionStorage.removeItem(PENDING_ENTRY_KEY);
      sessionStorage.removeItem(RESUME_RESULT_KEY);
    }
    leaderboardSyncFailed = false;
    if (pending.length && lastResult) elements.saveStatus.textContent = 'Your finds are saved and entered on the leaderboard.';
    renderLeaderboardGate();
    await refreshLeaderboard();
  })().catch(error => {
    console.error(error);
    leaderboardSyncFailed = true;
    if (lastResult) elements.saveStatus.textContent = pending.length
      ? 'Your finds are still saved on this device. Tap retry to post them.'
      : 'Your score could not update. Tap retry to try again.';
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
  if (game) trackEvent(EVENTS.HUNT_COMPLETED, { ...soloEventParameters(state, resultLevel), outcome: won ? 'won' : 'lost', winner_role: won ? 'seeker' : 'none' });
  clearMapSelection();
  renderSelection(state);
  document.body.classList.remove('in-game', 'solo-game');
  $('#end-level-button').classList.add('hidden');
  setSheetCollapsed(false);
  elements.hud.classList.add('hidden');
  elements.home.classList.add('hidden');
  elements.game.classList.add('hidden');
  elements.leaderboardScreen.classList.add('hidden');
  elements.result.classList.remove('hidden');
  elements.result.classList.remove('victory');
  $('#challenge-after-win').classList.toggle('hidden', !won);
  $('#result-leaderboard-button').classList.toggle('hidden', !won);
  $('#play-again-button').classList.toggle('primary-button', !won);
  $('#result-art').textContent = won ? '✦' : '⌛';
  $('#result-eyebrow').textContent = `LEVEL ${String(resultLevel).padStart(2, '0')} · ${won ? 'TREASURE FOUND' : 'THE TRAIL WENT COLD'}`;
  $('#result-title').textContent = won ? 'Beautifully found.' : 'The world is still waiting.';
  const timeUsed = Math.max(0, (state.roundSeconds ?? 120) - state.remaining);
  $('#result-copy').textContent = won ? `You found ${state.puzzle.country} using ${timeUsed} seconds. Level ${resultLevel + 1} is ready.` : `The treasure was hiding in ${state.puzzle.country}. Try level ${resultLevel} again with a new country.`;
  $('#result-stats').innerHTML = `<div><strong>${won ? timeUsed : state.remaining}s</strong><span>${won ? 'TIME USED' : 'ON THE CLOCK'}</span></div><div><strong>${state.cluesVisible}/3</strong><span>CLUES OPENED</span></div><div><strong>${state.wrongGuesses}</strong><span>WRONG GUESSES</span></div>`;
  $('#result-fact').textContent = state.puzzle.fact;
  if (won) playVictory(elements.result);
  elements.saveStatus.textContent = user && username ? 'Saving this hunt…' : won
    ? user ? 'Choose a username to keep this winning find.' : 'Sign in to keep this winning find.'
    : 'Your hunt is complete. Play again for the leaderboard.';
  if (user && username) saveSignedInResult(user, state);
  else if (won) rememberPendingGuestHunt(huntRecord(state));
  renderLeaderboardGate();
  refreshLeaderboard();
}

function leaveHunt() {
  if (game?.snapshot().status === 'playing') trackEvent(EVENTS.HUNT_ABANDONED, soloEventParameters(game.snapshot(), activeLevel));
  clearVictory();
  clearInterval(ticker);
  game = null;
  clearMapSelection();
  document.body.classList.remove('in-game', 'solo-game');
  $('#end-level-button').classList.add('hidden');
  setSheetCollapsed(false);
  elements.hud.classList.add('hidden');
  elements.game.classList.add('hidden');
  elements.selection.classList.add('hidden');
  elements.home.classList.remove('hidden');
}

async function openAccount(purpose = 'log') {
  const multiplayer = purpose === 'multiplayer';
  $('#account-dialog-kicker').textContent = multiplayer ? '✦   PLAY TOGETHER' : '✦   YOUR EXPLORER LOG';
  $('#account-challenges').classList.toggle('hidden', !user || multiplayer);
  $('#account-challenge-status').textContent = '';
  if (!multiplayer) trackEvent(EVENTS.LOGS_OPENED);
  elements.accountDialog.showModal();
  if (!user) {
    elements.accountContent.innerHTML = multiplayer
      ? '<h2>Sign in to play together.</h2><p>Use your Google account to hide a treasure or join a friend’s hunt.</p><button id="dialog-sign-in" class="primary-button" type="button">Sign in with Google <span>↗</span></button>'
      : '<h2>Keep your discoveries.</h2><p>Sign in with Google to save each completed hunt and revisit your explorer log.</p><button id="dialog-sign-in" class="primary-button" type="button">Continue with Google <span>↗</span></button>';
    $('#dialog-sign-in').addEventListener('click', async () => {
      try {
        await login();
        if (elements.accountDialog.open) elements.accountDialog.close();
      } catch (error) {
        showToast('Sign-in could not start. Please try again.');
        console.error(error);
      }
    });
    return;
  }
  if (multiplayer) {
    elements.accountDialog.close();
    friend.openLobby();
    return;
  }
  elements.accountContent.innerHTML = `<h2>Welcome back, ${username ? `@${escapeHTML(username)}` : escapeHTML(user.displayName?.split(' ')[0] || 'Explorer')}.</h2><p>Your discoveries live here.</p><h3 class="log-heading">SOLO EXPLORATIONS</h3><div id="account-stats" class="account-stats">Loading your log…</div><section class="multiplayer-history" aria-labelledby="multiplayer-log-heading"><h3 id="multiplayer-log-heading" class="log-heading">FRIEND HUNTS</h3><p class="log-caption">Your rivalries, kept apart from the solo leaderboard.</p><div id="multiplayer-log" role="status">Loading friend hunts…</div><button id="multiplayer-log-retry" class="text-button hidden" type="button">Retry friend hunts ↗</button></section><button id="dialog-sign-out" class="text-button" type="button">Sign out ↗</button>`;
  const logUser = user;
  const logContainer = $('#multiplayer-log');
  const retry = $('#multiplayer-log-retry');
  async function loadMultiplayerLog() {
    retry.classList.add('hidden');
    logContainer.textContent = 'Loading friend hunts…';
    try {
      const hunts = await loadFriendHunts(logUser);
      if (user?.uid !== logUser.uid || !logContainer.isConnected) return;
      logContainer.innerHTML = historyContent(hunts, logUser.uid);
    } catch (error) {
      if (user?.uid !== logUser.uid || !logContainer.isConnected) return;
      console.warn('Friend history unavailable:', error);
      logContainer.textContent = 'Your friend hunts could not be loaded.';
      retry.classList.remove('hidden');
    }
  }
  retry.addEventListener('click', loadMultiplayerLog);
  logContainer.addEventListener('click', async event => {
    const entry = event.target.closest('[data-hunt]');
    if (!entry) return;
    entry.disabled = true;
    try {
      await friend.joinCode(entry.dataset.hunt, 'history');
      trackEvent(EVENTS.HISTORY_OPENED, { mode: 'multiplayer' });
      if (game?.snapshot().status === 'playing') trackEvent(EVENTS.HUNT_ABANDONED, { ...soloEventParameters(game.snapshot(), activeLevel), source: 'history' });
      clearInterval(ticker);
      game = null;
      elements.accountDialog.close();
    } catch (error) { showToast(error.message || 'This result could not be opened. Try again.'); }
    finally { entry.disabled = false; }
  });
  loadMultiplayerLog();
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

const friend = createFriendController({
  getUser: () => user,
  getUsername: () => username,
  getMap: () => map,
  getCountries: () => countryData,
  showToast,
  playVictory,
  clearVictory,
  requestSignIn: () => openAccount('multiplayer'),
  requestUsername: () => { if (user) showWelcome(user); },
  clearMapSelection,
  setSheetCollapsed,
});

$('#welcome-notifications').addEventListener('click', async () => {
  if (!browserNotificationsAvailable()) return;
  try {
    const permission = await Notification.requestPermission();
    trackEvent(EVENTS.NOTIFICATIONS_PERMISSION, { permission });
    $('#welcome-notifications').classList.add('hidden');
    $('#notification-status').textContent = permission === 'granted'
      ? 'Browser notifications are on.' : 'No problem. Challenges will still appear in your inbox.';
    if (permission === 'granted' && user) registerChallengePush(user).catch(error => console.warn('Background alerts could not start:', error));
  } catch (error) {
    console.warn('Notification permission could not be requested:', error);
    $('#notification-status').textContent = 'Browser alerts are unavailable. Challenges will still appear in your inbox.';
  }
});
$('#welcome-username').addEventListener('input', () => {
  const input = $('#welcome-username');
  if (!welcomeFor || input.readOnly) return;
  const player = welcomeFor;
  const handle = input.value.trim().toLowerCase();
  const version = ++usernameCheckVersion;
  const status = $('#welcome-status');
  clearTimeout(usernameCheckTimer);
  $('#welcome-save').disabled = true;
  status.dataset.state = 'checking';
  if (!/^[a-z][a-z0-9_]{2,19}$/.test(handle)) {
    status.textContent = 'Use 3–20 characters, starting with a letter. Letters, numbers and underscores work.';
    status.dataset.state = 'unavailable';
    return;
  }
  status.textContent = `Checking @${handle}…`;
  usernameCheckTimer = setTimeout(async () => {
    try {
      const available = await isUsernameAvailable(handle);
      if (version !== usernameCheckVersion || welcomeFor?.uid !== player.uid || input.value.trim().toLowerCase() !== handle) return;
      status.textContent = available ? `@${handle} is available.` : `@${handle} is taken. Try another.`;
      status.dataset.state = available ? 'available' : 'unavailable';
      $('#welcome-save').disabled = !available;
    } catch (error) {
      if (version !== usernameCheckVersion) return;
      console.error(error);
      status.textContent = 'Could not check this username. Try typing it again.';
      status.dataset.state = 'unavailable';
    }
  }, 300);
});
$('#welcome-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!welcomeFor || user?.uid !== welcomeFor.uid) return;
  const saveButton = $('#welcome-save');
  saveButton.disabled = true;
  const status = $('#welcome-status');
  try {
    if (!username) {
      const handle = $('#welcome-username').value.trim().toLowerCase();
      if (!await isUsernameAvailable(handle)) {
        status.dataset.state = 'unavailable';
        throw new Error(`@${handle} is taken. Try another.`);
      }
      username = await claimUsername(welcomeFor, handle);
      setAnalyticsUser({ uid: welcomeFor.uid, username });
      renderUsername();
    }
    $('#welcome-dialog').close();
    welcomeFor = null;
    friend.onAuth(user);
    watchInbox(user);
    renderLeaderboardGate();
    postPendingGuestEntry(user);
    if (browserNotificationsAvailable() && Notification.permission === 'granted')
      registerChallengePush(user).catch(error => console.warn('Background alerts could not start:', error));
  } catch (error) {
    console.error(error);
    status.textContent = error.message || 'Your username could not be saved. Try again.';
    if (error.message?.includes('taken')) status.dataset.state = 'unavailable';
  } finally {
    if ($('#welcome-dialog').open) saveButton.disabled = !username && status.dataset.state !== 'available';
  }
});
$('#close-welcome').addEventListener('click', () => $('#welcome-dialog').close());
$('#challenge-list').addEventListener('click', async event => {
  const button = event.target.closest('button[data-code]');
  if (!button || !user) return;
  const code = button.dataset.code;
  try {
    await markChallengeRead(user, code);
    await friend.joinCode(code);
    if (elements.accountDialog.open) elements.accountDialog.close();
  } catch (error) {
    console.error(error);
    $('#account-challenge-status').textContent = error.message || 'That challenge could not be opened.';
  }
});

$('#start-button').addEventListener('click', startHunt);
$('#multiplayer-button').addEventListener('click', () => friend.openLobby());
$('#home-leaderboard-button').addEventListener('click', openLeaderboard);
$('#result-leaderboard-button').addEventListener('click', openLeaderboard);
$('#leaderboard-back-button').addEventListener('click', closeLeaderboard);
window.addEventListener('hashchange', () => {
  if (location.hash === '#leaderboard') showLeaderboard();
  else if (!elements.leaderboardScreen.classList.contains('hidden')) {
    leaderboardOpenedHere = false;
    restoreFromLeaderboard();
  }
});
elements.leaderboardSignIn.addEventListener('click', async () => {
  if (!lastResult) return;
  if (user) {
    if (!username) showWelcome(user);
    else postPendingGuestEntry(user);
    return;
  }
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
$('#challenge-after-win').addEventListener('click', () => {
  if (!lastResult || lastResult.status !== 'won') return;
  clearVictory();
  friend.challengeFriend(lastResult.puzzle);
});
$('#leave-button').addEventListener('click', () => friend.mode === 'seeker' ? friend.home() : leaveHunt());
elements.sheetToggle.addEventListener('click', () => setSheetCollapsed(!document.body.classList.contains('sheet-collapsed')));
$('#unlock-button').addEventListener('click', () => {
  if (friend.mode === 'seeker') return friend.unlock();
  if (!game) return;
  const before = game.snapshot(); const after = game.unlock();
  if (after.cluesVisible > before.cluesVisible) trackEvent(EVENTS.CLUE_OPENED, { ...soloEventParameters(after, activeLevel), clue_number: after.cluesVisible, cost_seconds: CLUE_COST });
  renderGame();
});
$('#reveal-button').addEventListener('click', () => {
  if (friend.mode === 'seeker') return friend.reveal();
  if (!game) return;
  const before = game.snapshot(); const after = game.reveal();
  if (!before.revealedCountry && after.revealedCountry) trackEvent(EVENTS.COUNTRY_REVEALED, { ...soloEventParameters(after, activeLevel), cost_seconds: REVEAL_COST });
  renderGame();
});
$('#cancel-button').addEventListener('click', () => {
  if (friend.mode === 'seeker') return friend.cancelSelection();
  if (game?.snapshot().selected) trackEvent(EVENTS.SELECTION_CANCELLED, soloEventParameters(game.snapshot(), activeLevel));
  game?.cancel(); clearMapSelection(); renderGame();
});
$('#guess-button').addEventListener('click', () => {
  if (friend.mode === 'seeker') { friend.guess(); return; }
  if (!game) return;
  const before = game.snapshot();
  const after = game.guess();
  if (before.selected && (after.status === 'won' || after.wrongGuesses > before.wrongGuesses)) trackEvent(EVENTS.GUESS_SUBMITTED, { ...soloEventParameters(after, activeLevel), outcome: after.status === 'won' ? 'correct' : 'wrong', cost_seconds: after.status === 'won' ? 0 : 5 });
  if (after.status === 'playing' && before.selected) {
    clearMapSelection();
    showToast(`${before.selected.country} isn't the one. −5 seconds.`);
  }
  renderGame();
});
$('#zoom-in').addEventListener('click', () => map?.zoomIn());
$('#zoom-out').addEventListener('click', () => map?.zoomOut());
$('#end-level-button').addEventListener('click', leaveHunt);
elements.accountButton.addEventListener('click', () => openAccount());
$('#close-account').addEventListener('click', () => elements.accountDialog.close());
elements.accountDialog.addEventListener('click', event => { if (event.target === elements.accountDialog) elements.accountDialog.close(); });

loadMap();
loadPuzzleSet();
if (location.hash === '#leaderboard') showLeaderboard();
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

watchUser(async nextUser => {
  const currentVersion = ++authVersion;
  user = nextUser;
  setAnalyticsUser(nextUser && { uid: nextUser.uid });
  username = '';
  leaderboardSyncFailed = false;
  renderUsername();
  stopChallenges?.();
  stopChallenges = null;
  $('#account-challenges').classList.toggle('hidden', !nextUser);
  if (!nextUser && elements.accountDialog.open) elements.accountDialog.close();
  if (!nextUser && $('#welcome-dialog').open) $('#welcome-dialog').close();
  elements.accountButton.innerHTML = nextUser ? `<span class="account-avatar">${escapeHTML((nextUser.displayName || 'E')[0])}</span><span class="account-label">My logs</span><span id="account-challenge-count" class="account-alert-count hidden">0</span>` : 'Sign in <span aria-hidden="true">↗</span>';
  elements.accountButton.setAttribute('aria-label', nextUser ? 'Open explorer log' : 'Sign in with Google');
  $('#multiplayer-hint').textContent = nextUser ? 'Hide or join a hunt' : 'Sign in required';
  if (!nextUser) friend.onAuth(null);
  else {
    try {
      const profile = await loadProfile(nextUser);
      if (currentVersion !== authVersion) return;
      username = profile?.username || '';
      setAnalyticsUser({ uid: nextUser.uid, username });
      renderUsername();
      if (!username || (browserNotificationsAvailable() && Notification.permission === 'default' && !sessionStorage.getItem(`treasurehunch:notify-asked:${nextUser.uid}`))) {
        sessionStorage.setItem(`treasurehunch:notify-asked:${nextUser.uid}`, '1');
        showWelcome(nextUser, username);
      }
      if (username) {
        friend.onAuth(nextUser);
        watchInbox(nextUser);
        if (browserNotificationsAvailable() && Notification.permission === 'granted')
          registerChallengePush(nextUser).catch(error => console.warn('Background alerts could not start:', error));
      }
    } catch (error) {
      console.error(error);
      showToast('Your explorer profile could not load. Please try signing in again.');
    }
  }
  renderLeaderboardGate();
  if (nextUser) {
    sessionStorage.removeItem(RESUME_RESULT_KEY);
    if (username) postPendingGuestEntry(nextUser);
    loadHunts(nextUser).then(hunts => {
      if (user?.uid !== nextUser.uid) return;
      const remoteWins = Math.max(0, ...hunts.filter(hunt => hunt.result === 'won').map(hunt => Number.isSafeInteger(hunt.level) && hunt.level > 0 ? hunt.level : 1));
      if (remoteWins > completedWins) {
        completedWins = remoteWins;
        rememberCompletedWins();
        updateHomeStatus();
      }
    }).catch(error => console.warn('Could not sync explorer level:', error));
  }
});
