import { trackEvent, EVENTS, setAnalyticsUser, soloEventParameters } from './events.js';
import { historyContent } from './friend-result.js';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import fallbackPuzzles from '../data/countries.json';
import { choosePuzzle, createGame, difficultyForLevel, CLUE_COST, REVEAL_COST } from './game.js';
import { loadFriendHunts, watchUser, login, logout, loadPuzzles, saveHunt, loadHunts, loadLeaderboard, enterLeaderboard, loadProfile, claimUsername, isUsernameAvailable, watchChallenges, markChallengeRead, registerChallengePush, loadDailyRecords, startDailyRecord, finishDailyRecord, loadMonthlyLeaderboard, enterMonthlyLeaderboard, saveAtlas, loadAtlas } from './firebase.js';
import { dayKey, monthKey, daysInMonth, msUntilNextDay, dailyPuzzle, currentStreak, scoreMonth, atlasFromRecords, mergeDailyRecords, validDailyRecord } from './daily.js';
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
let activeMode = 'solo';
let dailyRecords = [];
let dailySyncPromise = null;
let leaderboardBoard = 'monthly';
let atlasView = null;
const PROGRESS_KEY = 'treasurehunch:solo-wins';
const DAILY_KEY_PREFIX = 'treasurehunch:daily:';
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
  $('#solo-hint').textContent = `Level ${String(nextLevel).padStart(2, '0')} · ${difficulty[0].toUpperCase()}${difficulty.slice(1)}`;
  elements.homeStatus.textContent = `${puzzles.length} places to discover · A new daily country at 00:00 UTC`;
}

// Daily records live on this device per account ('guest' before sign-in) and in Firestore once signed in.
function dailyOwner() {
  return user?.uid || 'guest';
}

function readDailyStore(owner = dailyOwner()) {
  try {
    const stored = JSON.parse(localStorage.getItem(`${DAILY_KEY_PREFIX}${owner}`) || '[]');
    return Array.isArray(stored) ? stored.filter(record => record && typeof record.day === 'string') : [];
  } catch {
    return [];
  }
}

function writeDailyStore(records, owner = dailyOwner()) {
  try { localStorage.setItem(`${DAILY_KEY_PREFIX}${owner}`, JSON.stringify(records.slice(-400))); } catch { /* The quest still plays without storage. */ }
}

function rememberDailyRecord(record) {
  const others = readDailyStore().filter(item => item.day !== record.day);
  writeDailyStore([...others, record].sort((a, b) => a.day.localeCompare(b.day)));
  dailyRecords = [...dailyRecords.filter(item => item.day !== record.day), record].sort((a, b) => a.day.localeCompare(b.day));
}

function todayRecord() {
  return dailyRecords.find(record => record.day === dayKey());
}

function formatCountdown(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

function monthName(month = monthKey()) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString('en', { month: 'long', timeZone: 'UTC' });
}

function renderDailyHome() {
  const record = todayRecord();
  const today = dayKey();
  const nextIn = formatCountdown(msUntilNextDay());
  const label = new Date(`${today}T00:00:00Z`).toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const button = $('#daily-button');
  button.classList.toggle('daily-done', !!record && record.status !== 'playing');
  if (!record) {
    $('#daily-title').textContent = "Start today's quest";
    $('#daily-hint').textContent = `${label} · Same country for everyone`;
  } else if (record.status === 'playing') {
    $('#daily-title').textContent = "Resume today's quest";
    $('#daily-hint').textContent = 'Your clock is still running';
  } else {
    $('#daily-title').textContent = record.status === 'won' ? `${record.country} is on your map` : 'The trail went cold today';
    $('#daily-hint').textContent = `Next country in ${nextIn} · Open your map`;
  }
  const month = scoreMonth(dailyRecords, monthKey());
  const streak = currentStreak(dailyRecords);
  const dayOfMonth = Number(today.slice(8, 10));
  $('#daily-streak').textContent = `✦ ${streak ? `${streak}-day streak` : 'Start a streak today'} · ${month.found} of ${dayOfMonth} found in ${monthName()}`;
}

function huntParameters(state) {
  return activeMode === 'daily' ? soloEventParameters(state, undefined, 'daily') : soloEventParameters(state, activeLevel);
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
  trackEvent(EVENTS.COUNTRY_SELECTED, { ...huntParameters(state), method: 'map' });
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
      map.addLayer({ id: 'atlas-country', type: 'fill', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'fill-color': '#d9a24f', 'fill-opacity': 0.72 } });
      map.addLayer({ id: 'atlas-recent', type: 'fill', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'fill-color': '#f2c46b', 'fill-opacity': 0.92 } });
      map.addLayer({ id: 'atlas-border', type: 'line', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#fff2c3', 'line-width': 1.4 } });
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
      applyAtlasLayers();
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
  closeAtlasView();
  activeMode = 'solo';
  activeLevel = completedWins + 1;
  const lastId = sessionStorage.getItem('treasurehunch:last-country') || '';
  const puzzle = choosePuzzle(puzzles, lastId, Math.random, activeLevel);
  sessionStorage.setItem('treasurehunch:last-country', puzzle.id);
  $('#level-label').textContent = `LEVEL ${String(activeLevel).padStart(2, '0')} · ${difficultyForLevel(activeLevel).toUpperCase()} HUNT`;
  game = createGame(puzzle);
  trackEvent(EVENTS.HUNT_STARTED, huntParameters(game.snapshot()));
  openHuntScreen();
}

function openHuntScreen() {
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

// The daily quest uses the bundled country list so every browser builds the same schedule.
function startDaily() {
  const record = todayRecord();
  if (record && record.status !== 'playing') { openAtlas('', 'home'); return; }
  if (!map?.getLayer('land')) { showToast('The map is still loading. One moment!'); return; }
  if (friend.mode !== 'idle') friend.home();
  clearVictory();
  closeAtlasView();
  const today = dayKey();
  const puzzle = dailyPuzzle(fallbackPuzzles, today);
  activeMode = 'daily';
  game = createGame(puzzle, undefined, record?.puzzleId === puzzle.id ? record : null);
  const state = game.snapshot();
  const label = new Date(`${today}T00:00:00Z`).toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).toUpperCase();
  $('#level-label').textContent = `DAILY QUEST · ${label} · ${(puzzle.difficulty || 'medium').toUpperCase()}`;
  saveDailyProgress(state);
  if (!record) trackEvent(EVENTS.HUNT_STARTED, huntParameters(state));
  openHuntScreen();
  const player = user;
  if (player && !record) {
    startDailyRecord(player, { day: today, puzzleId: puzzle.id, country: puzzle.country }).then(remote => {
      if (!remote || user?.uid !== player.uid || activeMode !== 'daily' || !game) return;
      if (remote.status !== 'playing') {
        // Today's quest was already finished on another device.
        rememberDailyRecord(remote);
        leaveHunt(false);
        renderDailyHome();
        showToast("You've already played today's quest on another device.");
      } else if (Number.isFinite(remote.startedAt)) {
        game = createGame(puzzle, undefined, { ...game.snapshot(), startedAt: remote.startedAt });
        saveDailyProgress(game.snapshot());
      }
    }).catch(error => console.warn('Could not record the daily start:', error));
  }
}

function saveDailyProgress(state) {
  if (activeMode !== 'daily' || state.status !== 'playing') return;
  rememberDailyRecord({
    day: dayKey(state.startedAt), puzzleId: state.puzzle.id, country: state.puzzle.country, status: 'playing',
    startedAt: state.startedAt, costSeconds: state.costSeconds, cluesVisible: state.cluesVisible,
    revealedCountry: state.revealedCountry, wrongGuesses: state.wrongGuesses, tried: state.tried,
  });
}

function dailyResultRecord(state) {
  return {
    day: state.day || dayKey(state.startedAt), puzzleId: state.puzzle.id, country: state.puzzle.country,
    status: state.status === 'won' ? 'won' : 'lost',
    timeUsed: Math.min(state.roundSeconds, Math.max(0, state.roundSeconds - state.remaining)),
    cluesUsed: state.cluesVisible, wrongGuesses: state.wrongGuesses, revealedCountry: state.revealedCountry,
    startedAt: state.startedAt,
  };
}

// Brings Firestore, this device and the public boards in line with each other.
function syncDaily(player) {
  if (!player) return Promise.resolve();
  if (dailySyncPromise) return dailySyncPromise;
  dailySyncPromise = (async () => {
    const remote = await loadDailyRecords(player);
    const remoteByDay = new Map(remote.map(record => [record.day, record]));
    const local = [...readDailyStore('guest'), ...readDailyStore(player.uid)];
    const month = monthKey();
    for (const record of local) {
      if (!validDailyRecord(record) || !record.day.startsWith(month) || (remoteByDay.get(record.day)?.status ?? 'playing') !== 'playing') continue;
      await finishDailyRecord(player, record);
      remoteByDay.set(record.day, record);
    }
    if (user?.uid !== player.uid) return;
    const merged = mergeDailyRecords([...remoteByDay.values()], local);
    writeDailyStore(merged, player.uid);
    try { localStorage.removeItem(`${DAILY_KEY_PREFIX}guest`); } catch { /* Nothing to clear. */ }
    dailyRecords = merged;
    renderDailyHome();
    if (atlasView?.self) renderAtlas();
    if (!username) return;
    await Promise.all([
      enterMonthlyLeaderboard(player, merged, month),
      saveAtlas(player, username, atlasFromRecords(merged)),
      merged.some(record => record.status === 'won') ? enterLeaderboard(player) : null,
    ]);
    await refreshLeaderboard();
  })().catch(error => {
    console.warn('Daily quest sync failed:', error);
    throw error;
  }).finally(() => { dailySyncPromise = null; });
  return dailySyncPromise;
}

function finishDaily(state) {
  const fresh = !!game;
  const won = state.status === 'won';
  const record = dailyResultRecord(state);
  if (fresh || !dailyRecords.some(item => item.day === record.day && item.status !== 'playing')) rememberDailyRecord(record);
  const streak = currentStreak(dailyRecords);
  lastResult = { ...state, mode: 'daily', day: record.day };
  if (fresh) trackEvent(EVENTS.HUNT_COMPLETED, { ...soloEventParameters(state, undefined, 'daily'), outcome: won ? 'won' : 'lost', winner_role: won ? 'seeker' : 'none', streak });
  game = null;
  showResultScreen(state);
  const month = scoreMonth(dailyRecords, monthKey());
  $('#challenge-after-win').classList.add('hidden');
  $('#result-atlas-button').classList.remove('hidden');
  $('#result-leaderboard-button').classList.remove('hidden');
  $('#play-again-button').classList.remove('primary-button');
  $('#play-again-button').innerHTML = 'Play solo levels <span>↗</span>';
  $('#result-eyebrow').textContent = `DAILY QUEST · ${won ? 'COUNTRY CLAIMED' : 'THE TRAIL WENT COLD'}`;
  $('#result-title').textContent = won ? `${state.puzzle.country} is yours.` : 'Missed this one.';
  $('#result-copy').textContent = won
    ? `Found in ${record.timeUsed} ${record.timeUsed === 1 ? 'second' : 'seconds'} and claimed for your map. ${month.found} ${month.found === 1 ? 'country' : 'countries'} found in ${monthName()}.`
    : `Today's treasure was hiding in ${state.puzzle.country}. A new country arrives in ${formatCountdown(msUntilNextDay())}.`;
  $('#result-stats').innerHTML = `<div><strong>${won ? `${record.timeUsed}s` : '—'}</strong><span>TIME USED</span></div><div><strong>${streak}</strong><span>DAY STREAK</span></div><div><strong>${month.found}</strong><span>FOUND THIS MONTH</span></div>`;
  if (won) playVictory(elements.result);
  renderDailyHome();
  if (user) {
    elements.saveStatus.textContent = 'Saving to your map…';
    const player = user;
    finishDailyRecord(player, record)
      .then(() => syncDaily(player))
      .then(() => { if (lastResult?.day === record.day) elements.saveStatus.textContent = username ? 'Saved to your map and this month\'s board.' : 'Saved. Choose a username to enter the monthly board.'; })
      .catch(error => {
        console.error(error);
        if (lastResult?.day === record.day) elements.saveStatus.textContent = 'Saved on this device. It will sync when you are back online.';
      });
  } else {
    elements.saveStatus.textContent = won ? 'Kept on this device for now.' : '';
  }
  renderLeaderboardGate();
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
  if (lastResult.mode === 'daily') {
    const dailyWon = lastResult.status === 'won';
    elements.leaderboardSignIn.classList.toggle('hidden', !!user && !!username);
    elements.leaderboardSignIn.innerHTML = user ? 'Choose your username <span>↗</span>'
      : dailyWon ? `Sign in to claim ${escapeHTML(lastResult.puzzle.country)} <span>↗</span>` : 'Sign in to keep your streak <span>↗</span>';
    elements.leaderboardNote.textContent = !user ? 'Daily finds are ranked each month and count extra on the all-time board.'
      : !username ? "Choose a username to enter this month's board." : '';
    $('#result-leaderboard').classList.remove('hidden');
    return;
  }
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

function renderBoardTabs() {
  const monthly = leaderboardBoard === 'monthly';
  $('#board-monthly').setAttribute('aria-selected', String(monthly));
  $('#board-all-time').setAttribute('aria-selected', String(!monthly));
  const month = monthKey();
  const daysLeft = daysInMonth(month) - Number(dayKey().slice(8, 10));
  $('#leaderboard-title').innerHTML = monthly ? `${monthName(month)} <em>quest.</em>` : 'All-time <em>leaderboard.</em>';
  $('#leaderboard-description').textContent = monthly
    ? `Most daily countries found this month wins; ties go to the least total time used. A missed day is a missed country. ${daysLeft ? `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left.` : 'Final day!'}`
    : "Each solo level's best win counts once and level N weighs N. Every daily find counts double your highest level. Lower average times rank higher.";
  $('#leaderboard-heading-score').textContent = monthly ? 'FOUND · TIME USED' : 'WEIGHTED TIME USED';
}

async function refreshLeaderboard() {
  if (elements.leaderboardScreen.classList.contains('hidden')) return;
  const version = ++leaderboardLoadVersion;
  const monthly = leaderboardBoard === 'monthly';
  renderBoardTabs();
  elements.leaderboardRows.textContent = 'Loading the leaderboard…';
  try {
    const leaders = monthly ? await loadMonthlyLeaderboard(monthKey()) : await loadLeaderboard();
    if (version !== leaderboardLoadVersion) return;
    const row = (entry, index, detail, score) => `<button class="leaderboard-row" type="button" data-atlas="${escapeHTML(entry.name)}" aria-label="Open @${escapeHTML(entry.name)}'s map"><span class="leaderboard-rank">${String(index + 1).padStart(2, '0')}</span><span class="leaderboard-player"><strong>@${escapeHTML(entry.name)}</strong><small>${detail}</small></span>${score}</button>`;
    elements.leaderboardRows.innerHTML = !leaders.length
      ? `<p class="leaderboard-empty">${monthly ? "No finds this month yet. Today's country could put you first." : 'No finds yet. The first place is yours to claim.'}</p>`
      : monthly
        ? leaders.map((entry, index) => row(entry, index, `${Number(entry.played)} ${entry.played === 1 ? 'day' : 'days'} played · ${formatDuration(Number(entry.timeUsed))} used`, `<strong class="leaderboard-score">${Number(entry.found)}<small>FOUND</small></strong>`)).join('')
        : leaders.map((entry, index) => {
          const levels = Number(entry.levelsCompleted);
          const finds = Number(entry.dailyFinds || 0);
          const parts = [];
          if (levels) parts.push(`${levels} ${levels === 1 ? 'level' : 'levels'} · reached level ${Number(entry.highestLevel)}`);
          if (finds) parts.push(`${finds} daily ${finds === 1 ? 'find' : 'finds'}`);
          return row(entry, index, parts.join(' · '), `<strong class="leaderboard-score">${(Number(entry.averageTenths) / 10).toFixed(1)}s<small>AVG</small></strong>`);
        }).join('');
  } catch (error) {
    if (version !== leaderboardLoadVersion) return;
    console.error(error);
    elements.leaderboardRows.textContent = 'The leaderboard is temporarily unavailable.';
  }
}

function setLeaderboardBoard(board) {
  if (board === leaderboardBoard) return;
  leaderboardBoard = board;
  trackEvent(EVENTS.LEADERBOARD_VIEWED, { source: 'tab', board: board === 'monthly' ? 'monthly' : 'all_time' });
  refreshLeaderboard();
}

function applyAtlasLayers() {
  if (!map?.getLayer('atlas-country')) return;
  const countries = atlasView?.countries || {};
  const ids = Object.keys(countries);
  const recent = ids.filter(id => countries[id].startsWith(`${monthKey()}-`));
  map.setFilter('atlas-country', ['in', ['get', 'id'], ['literal', ids]]);
  map.setFilter('atlas-border', ['in', ['get', 'id'], ['literal', ids]]);
  map.setFilter('atlas-recent', ['in', ['get', 'id'], ['literal', recent]]);
}

function countryName(id) {
  return fallbackPuzzles.find(puzzle => puzzle.id === id)?.country
    || countryData?.features.find(feature => feature.properties.id === id)?.properties.name || id;
}

function atlasLink(handle) {
  return `${location.origin}/?atlas=${encodeURIComponent(handle)}`;
}

function renderAtlas() {
  if (!atlasView) return;
  if (atlasView.self) atlasView.countries = atlasFromRecords(dailyRecords);
  const { self, name, countries = {}, loading, missing } = atlasView;
  const ids = Object.keys(countries).sort((a, b) => countries[b].localeCompare(countries[a]));
  const month = monthKey();
  const thisMonth = ids.filter(id => countries[id].startsWith(`${month}-`)).length;
  $('#atlas-title').innerHTML = self ? 'Your <em>world.</em>' : `@${escapeHTML(name)}'s <em>world.</em>`;
  $('#atlas-copy').textContent = loading ? 'Unrolling the map…'
    : missing ? `@${name} hasn't started a map yet.`
      : self ? (ids.length ? 'Every daily country you find is claimed here. Missed days stay blank.' : "Find today's country to claim your first place on the map.")
        : `${ids.length} ${ids.length === 1 ? 'country' : 'countries'} claimed from daily quests.`;
  const third = self
    ? `<div><strong>${currentStreak(dailyRecords)}</strong><span>DAY STREAK</span></div>`
    : `<div><strong>${Math.round((ids.length / fallbackPuzzles.length) * 100)}%</strong><span>OF THE QUEST WORLD</span></div>`;
  $('#atlas-stats').innerHTML = loading || missing ? '' : `<div><strong>${ids.length}</strong><span>COUNTRIES</span></div><div><strong>${thisMonth}</strong><span>IN ${monthName(month).toUpperCase()}</span></div>${third}`;
  $('#atlas-stats').classList.toggle('hidden', loading || missing);
  $('#atlas-countries').innerHTML = ids.map(id => `<span class="atlas-chip ${countries[id].startsWith(`${month}-`) ? 'recent' : ''}">${escapeHTML(countryName(id))}</span>`).join('');
  $('#atlas-share').classList.toggle('hidden', !self || !user || !username);
  $('#atlas-sign-in').classList.toggle('hidden', !self || (!!user && !!username));
  $('#atlas-sign-in').innerHTML = user ? 'Choose a username to share your map <span aria-hidden="true">↗</span>' : 'Sign in to share your map <span aria-hidden="true">↗</span>';
  $('#atlas-own-button').classList.toggle('hidden', self);
  applyAtlasLayers();
}

async function openAtlas(handle = '', source = 'home') {
  const normalized = String(handle || '').trim().replace(/^@/, '').toLowerCase();
  const self = !normalized || normalized === username;
  const returnTo = !elements.leaderboardScreen.classList.contains('hidden') ? 'leaderboard'
    : !elements.result.classList.contains('hidden') ? 'result'
      : atlasView?.returnTo || 'home';
  if (friend.mode !== 'idle') friend.home();
  leaderboardOpenedHere = false;
  clearVictory();
  elements.home.classList.add('hidden');
  elements.result.classList.add('hidden');
  elements.leaderboardScreen.classList.add('hidden');
  $('#atlas-screen').classList.remove('hidden');
  document.body.classList.add('atlas-view');
  $('#atlas-status').textContent = '';
  const version = Symbol('atlas');
  atlasView = { self, name: self ? username : normalized, countries: {}, loading: !self, version, returnTo, source };
  history.replaceState({}, '', self && username ? `?atlas=${username}` : self ? location.pathname : `?atlas=${normalized}`);
  renderAtlas();
  if (self) {
    trackEvent(EVENTS.ATLAS_VIEWED, { owner: 'self', source, countries: Object.keys(atlasView.countries).length });
    return;
  }
  try {
    const atlas = await loadAtlas(normalized);
    if (atlasView?.version !== version) return;
    atlasView = { ...atlasView, loading: false, missing: !atlas, countries: atlas?.countries || {} };
    trackEvent(EVENTS.ATLAS_VIEWED, { owner: 'other', source, countries: Object.keys(atlasView.countries).length });
  } catch (error) {
    console.error(error);
    if (atlasView?.version !== version) return;
    atlasView = { ...atlasView, loading: false, missing: true };
    $('#atlas-status').textContent = 'This map could not be loaded. Try again shortly.';
  }
  renderAtlas();
}

function closeAtlasView() {
  if (!atlasView) return;
  atlasView = null;
  $('#atlas-screen').classList.add('hidden');
  document.body.classList.remove('atlas-view');
  if (new URLSearchParams(location.search).has('atlas')) history.replaceState({}, '', location.pathname);
  applyAtlasLayers();
}

async function shareAtlas(native) {
  if (!username) return;
  const link = atlasLink(username);
  const countries = Object.keys(atlasView?.countries || {}).length;
  if (native && navigator.share) {
    try {
      await navigator.share({ title: 'My TreasureHunch map', text: `I've claimed ${countries} ${countries === 1 ? 'country' : 'countries'} on TreasureHunch. Can you find today's?`, url: link });
      trackEvent(EVENTS.ATLAS_SHARED, { method: 'native', countries });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(link);
    trackEvent(EVENTS.ATLAS_SHARED, { method: 'clipboard', countries });
    $('#atlas-status').textContent = 'Map link copied.';
  } catch {
    $('#atlas-status').textContent = link;
  }
}

function showLeaderboard() {
  if (!elements.leaderboardScreen.classList.contains('hidden')) return;
  clearVictory();
  closeAtlasView();
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
  leaderboardBoard = lastResult && !elements.result.classList.contains('hidden') && lastResult.mode !== 'daily' ? 'all_time' : 'monthly';
  trackEvent(EVENTS.LEADERBOARD_VIEWED, { source: elements.result.classList.contains('hidden') ? 'home' : 'result', board: leaderboardBoard });
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

function showResultScreen(state) {
  clearMapSelection();
  renderSelection(state);
  document.body.classList.remove('in-game', 'solo-game');
  $('#end-level-button').classList.add('hidden');
  setSheetCollapsed(false);
  elements.hud.classList.add('hidden');
  elements.home.classList.add('hidden');
  elements.game.classList.add('hidden');
  elements.leaderboardScreen.classList.add('hidden');
  closeAtlasView();
  elements.result.classList.remove('hidden');
  elements.result.classList.remove('victory');
  $('#result-art').textContent = state.status === 'won' ? '✦' : '⌛';
  $('#result-fact').textContent = state.puzzle.fact;
}

function finish(state) {
  clearInterval(ticker);
  if (saved) return;
  saved = true;
  if (state.mode === 'daily' || (game && activeMode === 'daily')) { finishDaily(state); return; }
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
  showResultScreen(state);
  $('#result-atlas-button').classList.add('hidden');
  $('#play-again-button').innerHTML = 'Hunt again <span>↗</span>';
  $('#challenge-after-win').classList.toggle('hidden', !won);
  $('#result-leaderboard-button').classList.toggle('hidden', !won);
  $('#play-again-button').classList.toggle('primary-button', !won);
  $('#result-eyebrow').textContent = `LEVEL ${String(resultLevel).padStart(2, '0')} · ${won ? 'TREASURE FOUND' : 'THE TRAIL WENT COLD'}`;
  $('#result-title').textContent = won ? 'Beautifully found.' : 'The world is still waiting.';
  const timeUsed = Math.max(0, (state.roundSeconds ?? 120) - state.remaining);
  $('#result-copy').textContent = won ? `You found ${state.puzzle.country} using ${timeUsed} seconds. Level ${resultLevel + 1} is ready.` : `The treasure was hiding in ${state.puzzle.country}. Try level ${resultLevel} again with a new country.`;
  $('#result-stats').innerHTML = `<div><strong>${won ? timeUsed : state.remaining}s</strong><span>${won ? 'TIME USED' : 'ON THE CLOCK'}</span></div><div><strong>${state.cluesVisible}/3</strong><span>CLUES OPENED</span></div><div><strong>${state.wrongGuesses}</strong><span>WRONG GUESSES</span></div>`;
  if (won) playVictory(elements.result);
  elements.saveStatus.textContent = user && username ? 'Saving this hunt…' : won
    ? user ? 'Choose a username to keep this winning find.' : 'Sign in to keep this winning find.'
    : 'Your hunt is complete. Play again for the leaderboard.';
  if (user && username) saveSignedInResult(user, state);
  else if (won) rememberPendingGuestHunt(huntRecord(state));
  renderLeaderboardGate();
  refreshLeaderboard();
}

function leaveHunt(track = true) {
  const dailyRunning = activeMode === 'daily' && game?.snapshot().status === 'playing';
  if (track && game?.snapshot().status === 'playing') trackEvent(EVENTS.HUNT_ABANDONED, huntParameters(game.snapshot()));
  if (track && dailyRunning) showToast("Today's clock keeps running. Resume from the home screen.");
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
  renderDailyHome();
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
      if (game?.snapshot().status === 'playing') trackEvent(EVENTS.HUNT_ABANDONED, { ...huntParameters(game.snapshot()), source: 'history' });
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
    syncDaily(user).catch(() => {});
    if (atlasView?.self) { atlasView.name = username; renderAtlas(); }
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
$('#daily-button').addEventListener('click', startDaily);
$('#home-atlas-button').addEventListener('click', () => openAtlas('', 'home'));
$('#result-atlas-button').addEventListener('click', () => openAtlas('', 'result'));
$('#atlas-own-button').addEventListener('click', () => openAtlas('', atlasView?.source || 'home'));
$('#atlas-share-button').addEventListener('click', () => shareAtlas(true));
$('#atlas-copy-button').addEventListener('click', () => shareAtlas(false));
$('#atlas-sign-in').addEventListener('click', () => {
  if (user) showWelcome(user);
  else login().catch(error => { console.error(error); showToast('Sign-in could not start. Please try again.'); });
});
$('#atlas-back-button').addEventListener('click', () => {
  const returnTo = atlasView?.returnTo || 'home';
  closeAtlasView();
  if (returnTo === 'leaderboard') { leaderboardOpenedHere = false; location.hash = 'leaderboard'; showLeaderboard(); }
  else if (returnTo === 'result' && lastResult) elements.result.classList.remove('hidden');
  else { elements.home.classList.remove('hidden'); renderDailyHome(); }
});
$('#board-monthly').addEventListener('click', () => setLeaderboardBoard('monthly'));
$('#board-all-time').addEventListener('click', () => setLeaderboardBoard('all_time'));
elements.leaderboardRows.addEventListener('click', event => {
  const row = event.target.closest('[data-atlas]');
  if (row) openAtlas(row.dataset.atlas, 'leaderboard');
});
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
    else if (lastResult.mode === 'daily') syncDaily(user).catch(() => {});
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
// Keep the daily countdown and day rollover current on the home screen.
setInterval(() => { if (!elements.home.classList.contains('hidden')) renderDailyHome(); }, 30000);
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
  if (after.cluesVisible > before.cluesVisible) trackEvent(EVENTS.CLUE_OPENED, { ...huntParameters(after), clue_number: after.cluesVisible, cost_seconds: CLUE_COST });
  saveDailyProgress(after);
  renderGame();
});
$('#reveal-button').addEventListener('click', () => {
  if (friend.mode === 'seeker') return friend.reveal();
  if (!game) return;
  const before = game.snapshot(); const after = game.reveal();
  if (!before.revealedCountry && after.revealedCountry) trackEvent(EVENTS.COUNTRY_REVEALED, { ...huntParameters(after), cost_seconds: REVEAL_COST });
  saveDailyProgress(after);
  renderGame();
});
$('#cancel-button').addEventListener('click', () => {
  if (friend.mode === 'seeker') return friend.cancelSelection();
  if (game?.snapshot().selected) trackEvent(EVENTS.SELECTION_CANCELLED, huntParameters(game.snapshot()));
  game?.cancel(); clearMapSelection(); renderGame();
});
$('#guess-button').addEventListener('click', () => {
  if (friend.mode === 'seeker') { friend.guess(); return; }
  if (!game) return;
  const before = game.snapshot();
  const after = game.guess();
  if (before.selected && (after.status === 'won' || after.wrongGuesses > before.wrongGuesses)) trackEvent(EVENTS.GUESS_SUBMITTED, { ...huntParameters(after), outcome: after.status === 'won' ? 'correct' : 'wrong', cost_seconds: after.status === 'won' ? 0 : 5 });
  if (after.status === 'playing' && before.selected) {
    clearMapSelection();
    showToast(`${before.selected.country} isn't the one. −5 seconds.`);
  }
  saveDailyProgress(after);
  renderGame();
});
$('#zoom-in').addEventListener('click', () => map?.zoomIn());
$('#zoom-out').addEventListener('click', () => map?.zoomOut());
$('#end-level-button').addEventListener('click', leaveHunt);
elements.accountButton.addEventListener('click', () => openAccount());
$('#close-account').addEventListener('click', () => elements.accountDialog.close());
elements.accountDialog.addEventListener('click', event => { if (event.target === elements.accountDialog) elements.accountDialog.close(); });

dailyRecords = readDailyStore('guest');
renderDailyHome();
loadMap();
loadPuzzleSet();
{
  const sharedAtlas = new URLSearchParams(location.search).get('atlas');
  if (sharedAtlas && !new URLSearchParams(location.search).get('hunt')) openAtlas(sharedAtlas, 'link');
}
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
  dailyRecords = nextUser ? mergeDailyRecords(readDailyStore(nextUser.uid), readDailyStore('guest')) : readDailyStore('guest');
  renderDailyHome();
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
    syncDaily(nextUser).catch(() => {});
    if (atlasView?.self) { atlasView.name = username; renderAtlas(); }
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
