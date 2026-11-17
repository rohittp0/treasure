import { trackEvent, EVENTS, setAnalyticsUser, soloEventParameters, analyticsIds } from './events.js';
import { historyContent } from './friend-result.js';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './style.css';
import fallbackPuzzles from '../data/countries.json';
import bundledDailySchedules from '../data/daily-quests.json';
import { choosePuzzle, createGame, difficultyForLevel, CLUE_COST, REVEAL_COST } from './game.js';
import { loadFriendHunts, watchUser, login, logout, loadPuzzles, saveHunt, loadHunts, loadLeaderboard, enterLeaderboard, loadProfile, claimUsername, isUsernameAvailable, watchChallenges, markChallengeRead, registerChallengePush, loadDailySchedule, loadDailyRecords, startDailyRecord, finishDailyRecord, loadMonthlyLeaderboard, enterMonthlyLeaderboard, saveAtlas, loadAtlas, loadWhatsApp, setWhatsAppOptIn, setWhatsAppTimeZone, snoozeWhatsAppPrompt, deleteAccount } from './firebase.js';
import { createWhatsAppVerify } from './whatsapp-verify.js';
import { inAppBrowser, platform, googleErrorReason } from './inapp.js';
import { arrival, clearHandoffParams, outboundHandoff, removeUrlParams, setUrlParam } from './handoff.js';
import { DISPLAY_MODE, createInstaller, createWakeLock, setAppBadge, shouldOfferInstall, startServiceWorker } from './pwa.js';
import { CONSENT_COPY, browserTimeZone, isVerified, maskPhone, whatsappPromptEligible } from './whatsapp.js';
import { dailyLinkSource, dayKey, monthKey, daysInMonth, msUntilNextDay, dailyQuest, validDailySchedule, currentStreak, scoreMonth, atlasFromRecords, mergeDailyRecords, validDailyRecord } from './daily.js';
import { createFriendController } from './friend-controller.js';
import { clockText, huntSheetKey } from './hunt-view.js';
import { pickTapFeature, TAP_RADIUS } from './map-tap.js';
import { acceptTerms, loadTermsAccepted, watchBlocks } from './firebase.js';
import { visibleChallenges, visibleHunts } from './moderation.js';
import { createModerationDialog } from './moderation-dialog.js';

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
  mapHint: $('#map-hint'),
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
// What the hunt screen last drew, so timer ticks only touch what changed.
let huntView = { remaining: null, sheet: '' };
let mapHintTimeout;
let mapHintShown = false;
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
// Explorers this explorer blocked (users/{uid}/blocks), and the friend hunts last loaded into My logs.
let blockedUids = new Set();
let accountHistory = null;
let inboxChallenges = [];
// Settles once the signed-in explorer's blocked list has loaded, so a ?hunt= link can wait for it.
let blocksLoaded = Promise.resolve();
// WhatsApp daily quest alert: the explorer's private state, the result card and the ?whatsapp=stop link.
let whatsappState = null;
let resultAlertVerify = null;
let resultAlertVersion = 0;
let pendingUnsubscribe = new URLSearchParams(location.search).get('whatsapp') === 'stop';
// ?account=delete (the public deletion link): sign in if needed, then ask to confirm.
let deleteSource = 'account';
let pendingDelete = new URLSearchParams(location.search).get('account') === 'delete';
let signInContext = null;
let signInVerify = null;
// Opt-in from the WhatsApp sign-in form; the welcome dialog waits for it before offering WhatsApp again.
let signInOptInTask = Promise.resolve();
let welcomeVerify = null;
let accountVerify = null;
let whatsappDialogVerify = null;
// The uid whose profile (username) has loaded; deferred dialogs wait for it.
let profileReadyFor = '';
// Set by the daily notification link (?daily=1); the quest starts once the map is ready.
let pendingDaily = new URLSearchParams(location.search).has('daily');
// Read before the URL is cleaned: which alert (WhatsApp, push, …) brought the explorer to today's quest.
let dailyArrivalSource = dailyLinkSource(location.search);
// In-app browsers (Instagram, Facebook, WhatsApp…) keep their own storage, can't finish Google sign-in and
// can't install the app. index.html sends a first visit on to the real browser by itself (src/escape.js);
// anyone still here gets a link out from the sign-in sheet and the install card. Those links land with
// ?from=inapp plus signin=google or install=1, read once into `arrival` before the address is tidied.
const IN_APP = inAppBrowser(navigator.userAgent);
const IN_APP_PLATFORM = platform(navigator.userAgent);
let pendingGoogleSignIn = arrival.signIn;
let pendingInstall = arrival.install;
// Daily lists by month; the bundled copy is replaced by Firestore's once it loads.
const dailySchedules = { ...bundledDailySchedules };
let dailyScheduleMonth = '';
const PROGRESS_KEY = 'treasurehunch:solo-wins';
const FOUND_KEY = 'treasurehunch:solo-found';
const DAILY_KEY_PREFIX = 'treasurehunch:daily:';
const PENDING_ENTRY_KEY = 'treasurehunch:pending-leaderboard';
const RESUME_RESULT_KEY = 'treasurehunch:resume-result';
const MAP_HINT_KEY = 'treasurehunch:map-hint-seen';
// Set when the Terms of Use box is ticked and a sign-in starts; a Google redirect reloads the page before it ends.
// The in-memory flag covers browsers that block session storage (WhatsApp and the Google popup).
const TERMS_KEY = 'treasurehunch:terms-accepted';
let termsTicked = false;
let completedWins = readCompletedWins();
let soloFoundIds = readSoloFound();

// Session storage can throw where storage is blocked; nothing here may stop a hunt over it.
const session = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* Kept in memory for this page only. */ } },
  remove(key) { try { sessionStorage.removeItem(key); } catch { /* Nothing to remove. */ } },
};

function readSoloFound() {
  try {
    const stored = JSON.parse(localStorage.getItem(FOUND_KEY) || '[]');
    return new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function rememberSoloFound(ids) {
  for (const id of ids) soloFoundIds.add(id);
  try { localStorage.setItem(FOUND_KEY, JSON.stringify([...soloFoundIds])); } catch { /* Selection still works without storage. */ }
}

async function loadDailyList(month = monthKey()) {
  dailyScheduleMonth = month;
  try {
    const days = await loadDailySchedule(month);
    if (validDailySchedule(days, month)) dailySchedules[month] = days;
  } catch (error) {
    console.warn('Using the bundled daily list:', error);
  }
  renderDailyHome();
}

function dailyCountryCount() {
  return new Set(Object.values(dailySchedules).flat().map(puzzle => puzzle.id)).size;
}
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
  elements.homeStatus.textContent = `${puzzles.length + dailyCountryCount()} places to discover · A new daily country at 00:00 UTC`;
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

// The installed app's icon shows unread challenges, plus one while today's quest is still unplayed.
let unreadChallenges = 0;
function refreshBadge() {
  const record = todayRecord();
  setAppBadge(unreadChallenges + (record && record.status !== 'playing' ? 0 : 1));
}

function renderDailyHome() {
  refreshBadge();
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

// A guest's daily win waiting for a username to be claimed.
function unclaimedDailyWin() {
  return !username && lastResult?.mode === 'daily' && lastResult.status === 'won' ? lastResult.puzzle.country : '';
}

function showWelcome(player, existingUsername = '') {
  welcomeFor = player;
  const claim = existingUsername ? '' : unclaimedDailyWin();
  $('#welcome-dialog h2').innerHTML = claim ? `Claim <em>${escapeHTML(claim)}.</em>` : 'Choose your <em>name.</em>';
  $('#welcome-intro').textContent = claim
    ? `Pick a username to put ${claim} on your map. It also appears on the leaderboards and lets friends challenge you.`
    : "Your username appears on the leaderboards and your shared map, and friends can challenge you with it. Turn on alerts to hear when each day's quest arrives.";
  clearTimeout(usernameCheckTimer);
  usernameCheckVersion += 1;
  const input = $('#welcome-username');
  input.value = existingUsername;
  input.readOnly = !!existingUsername;
  input.required = !existingUsername;
  const saveButton = $('#welcome-save');
  saveButton.textContent = existingUsername ? 'Continue to TreasureHunch ↗' : claim ? `Claim ${claim} ↗` : 'Save and continue ↗';
  saveButton.disabled = !existingUsername;
  $('#welcome-status').textContent = existingUsername
    ? `Your username is @${existingUsername}.`
    : 'Enter a username to check if it is available.';
  $('#welcome-status').dataset.state = existingUsername ? 'available' : 'idle';
  const notificationButton = $('#welcome-notifications');
  const notificationStatus = $('#notification-status');
  notificationButton.classList.toggle('hidden', !browserNotificationsAvailable() || Notification.permission !== 'default');
  notificationButton.textContent = claim ? "Remind me when tomorrow's country arrives" : 'Enable browser notifications';
  notificationStatus.textContent = !browserNotificationsAvailable()
    ? 'Browser notifications are unavailable here. Challenges will still appear in your inbox.'
    : Notification.permission === 'granted' ? "Browser notifications are on. You'll hear when each day's quest arrives."
      : Notification.permission === 'denied' ? 'Browser notifications are off. Challenges will still appear in your inbox.'
        : claim ? 'One alert a day keeps your streak going. You can also continue without it.'
          : "Tap to get an alert when each day's quest arrives or a friend challenges you.";
  renderWelcomeWhatsApp(player, !existingUsername);
  renderWelcomeTerms(player, !existingUsername);
  if (!$('#welcome-dialog').open) $('#welcome-dialog').showModal();
  if (!existingUsername) setTimeout(() => input.focus(), 0);
}

async function refreshWhatsApp(player = user) {
  if (!player) { whatsappState = null; return null; }
  const state = await loadWhatsApp(player);
  if (user?.uid !== player.uid) return null;
  whatsappState = { uid: player.uid, ...state };
  return whatsappState;
}

// Opt-in is only ever written after an explicit tick or toggle. Rules reject turning on twice.
async function turnOnWhatsApp(player, source) {
  const state = await refreshWhatsApp(player);
  if (state?.whatsapp?.optIn === true) return;
  await setWhatsAppOptIn(player, true, browserTimeZone());
  trackEvent(EVENTS.WHATSAPP_OPT_IN, { source });
  await refreshWhatsApp(player).catch(() => {});
}

async function turnOffWhatsApp(player, source) {
  await setWhatsAppOptIn(player, false);
  trackEvent(EVENTS.WHATSAPP_OPT_OUT, { source });
  await refreshWhatsApp(player).catch(() => {});
}

// New explorers see an optional WhatsApp section: the full number check for Google sign-ups,
// or just the consent box when they signed up with an already verified WhatsApp number.
function renderWelcomeWhatsApp(player, signingUp) {
  const section = $('#welcome-whatsapp');
  const consent = $('#welcome-whatsapp-consent');
  welcomeVerify?.destroy();
  welcomeVerify = null;
  section.classList.add('hidden');
  consent.classList.add('hidden');
  consent.querySelector('input').checked = false;
  if (!signingUp) return;
  signInOptInTask.then(() => refreshWhatsApp(player)).then(state => {
    if (!state || welcomeFor?.uid !== player.uid || !$('#welcome-dialog').open) return;
    const whatsapp = state.whatsapp;
    if (whatsapp?.optIn === true || whatsapp?.optOutAt) return;
    section.classList.remove('hidden');
    if (isVerified(whatsapp)) {
      $('#welcome-whatsapp-caption').textContent = `Optional. Get one message on ${maskPhone(whatsapp.phone)} when each new daily quest goes live. That's the only thing we'll send there.`;
      consent.classList.remove('hidden');
      return;
    }
    $('#welcome-whatsapp-caption').textContent = "Optional. Get one WhatsApp message when each new daily quest goes live. That's the only thing we'll send there.";
    welcomeVerify = createWhatsAppVerify($('#welcome-whatsapp-verify'), {
      purpose: 'verify_phone', source: 'welcome', requireConsent: true, submitLabel: 'Verify on WhatsApp',
      onVerified: async () => {
        await turnOnWhatsApp(player, 'welcome');
        welcomeVerify?.destroy();
        welcomeVerify = null;
        $('#welcome-whatsapp-caption').textContent = "✓ You're in. We'll message you when each new daily quest goes live. Reply STOP anytime.";
      },
    });
  }).catch(error => console.warn('WhatsApp settings unavailable:', error));
}

// ---- Shared sign-in sheet: Google or WhatsApp, from every place that asks the explorer to sign in.
const SIGN_IN_COPY = {
  account: ['Keep your <em>discoveries.</em>', 'Sign in to save each completed hunt and revisit your explorer log.'],
  multiplayer: ['Sign in to <em>play together.</em>', 'Sign in to hide a treasure or join a friend’s hunt.'],
  atlas: ['Share your <em>map.</em>', 'Sign in to keep the countries you claim and share your explorer map.'],
  unsubscribe: ['Manage WhatsApp <em>alerts.</em>', 'Sign in with the WhatsApp number that gets the daily quest alert, or the Google account it belongs to.'],
  open_in_browser: ['Continue with <em>Google.</em>', 'You’re in your browser now. Continue with Google below, or use WhatsApp.'],
};

function openSignIn(source, { title, copy, resumeResult = false } = {}) {
  const [defaultTitle, defaultCopy] = SIGN_IN_COPY[source] || SIGN_IN_COPY.account;
  signInContext = { source, resumeResult };
  $('#sign-in-title').innerHTML = title || defaultTitle;
  $('#sign-in-copy').textContent = copy || defaultCopy;
  $('#sign-in-status').textContent = '';
  $('#sign-in-google').disabled = false;
  $('#sign-in-terms').checked = false;
  $('#sign-in-terms').disabled = false;
  // Signing in only to stop WhatsApp alerts or to delete the account asks for no new agreement.
  $('#sign-in-dialog .sign-in-terms').classList.toggle('hidden', TERMS_EXEMPT_SOURCES.has(source));
  signInVerify?.destroy();
  // WhatsApp is the primary way in: the number field is ready as soon as the sheet opens.
  // The unticked box is the only opt-in here; signing in alone never turns alerts on.
  signInVerify = createWhatsAppVerify($('#sign-in-whatsapp-verify'), {
    purpose: 'login', source, consent: source === 'unsubscribe' ? 'none' : 'optional', submitLabel: 'Send sign-in code',
    // Once a code is on its way the box is locked, so the sign-in it finishes is the one agreed to.
    beforeSend: () => {
      if (!termsAgreed()) return TERMS_NEEDED;
      $('#sign-in-terms').disabled = true;
      return '';
    },
    onVerified: ({ player, consent }) => {
      if (consent && player) signInOptInTask = optInAfterSignIn(player);
      closeSignIn();
    },
  });
  renderInAppSignIn();
  trackEvent(EVENTS.SIGN_IN_OPENED, { source });
  if (!$('#sign-in-dialog').open) $('#sign-in-dialog').showModal();
  signInVerify.focus();
}

// Every sign-in needs the unticked Terms of Use box ticked first. The acceptance is stored once the
// explorer is signed in (recordTermsAcceptance), since a Google redirect reloads the page first.
const TERMS_NEEDED = 'Tick the box to agree to the Terms of Use first.';
// Sign-ins that only stop WhatsApp alerts (?whatsapp=stop) or delete the account (?account=delete) are exempt.
const TERMS_EXEMPT_SOURCES = new Set(['unsubscribe', 'account_delete']);
let termsRecording = null;
function termsAgreed() {
  if (TERMS_EXEMPT_SOURCES.has(signInContext?.source)) return true;
  if (!$('#sign-in-terms').checked) return false;
  termsTicked = true;
  session.set(TERMS_KEY, '1');
  return true;
}

// An account without termsAcceptedAt (made before the box, or signed in only to unsubscribe or delete) ticks it in
// the username dialog: every username needs it, and everything an explorer posts needs a username.
function renderWelcomeTerms(player, choosing) {
  const box = $('#welcome-terms');
  box.classList.add('hidden');
  box.querySelector('input').checked = false;
  if (!choosing || termsTicked || session.get(TERMS_KEY) === '1') return;
  loadTermsAccepted(player).then(accepted => {
    if (!accepted && welcomeFor?.uid === player.uid && $('#welcome-dialog').open) box.classList.remove('hidden');
  }).catch(error => console.warn('Could not check the Terms of Use acceptance:', error));
}

// Before a username is claimed: stores a pending acceptance now, or throws so the explorer can try again.
async function ensureTermsAccepted(player) {
  const box = $('#welcome-terms');
  if (!box.classList.contains('hidden')) {
    if (!box.querySelector('input').checked) throw Object.assign(new Error(TERMS_NEEDED), { reason: 'terms' });
    termsTicked = true;
    session.set(TERMS_KEY, '1');
  }
  if (!termsTicked && session.get(TERMS_KEY) !== '1') return;
  await termsRecording;
  if (!termsTicked && session.get(TERMS_KEY) !== '1') return;
  await acceptTerms(player);
  termsTicked = false;
  session.remove(TERMS_KEY);
}

// The pending flags are cleared only once the acceptance is stored; after a failure the next auth event tries again.
function recordTermsAcceptance(player) {
  if (termsRecording || (!termsTicked && session.get(TERMS_KEY) !== '1')) return;
  termsRecording = acceptTerms(player)
    .then(() => { termsTicked = false; session.remove(TERMS_KEY); })
    .catch(error => console.warn('Could not record the Terms of Use acceptance:', error))
    .finally(() => { termsRecording = null; });
}

// In an in-app browser Google is hidden: WhatsApp works there, and a small link (tapped, never automatic)
// reopens the page in the real browser for Google. A guest's unclaimed find lives only in this browser's
// storage, so while there is one the link is left out and WhatsApp is the way to keep it.
function renderInAppSignIn() {
  const inApp = !!IN_APP;
  $('#sign-in-google').classList.toggle('hidden', inApp);
  $('#sign-in-dialog .sign-in-divider').classList.toggle('hidden', inApp);
  $('#sign-in-inapp').classList.toggle('hidden', !inApp);
  $('#sign-in-inapp-url').classList.add('hidden');
  if (!inApp) return;
  const keepHere = !!signInContext?.resumeResult || guestFindsHere();
  const todayFound = lastResult?.mode === 'daily' && lastResult.status === 'won';
  $('#sign-in-open-browser').classList.toggle('hidden', keepHere);
  $('#sign-in-open-browser').textContent = IN_APP_PLATFORM === 'android' ? 'Prefer Google? Open in Chrome' : 'Prefer Google? Open in your browser';
  $('#sign-in-inapp-note').textContent = keepHere ? `Sign in with WhatsApp here to keep ${todayFound ? "today's find" : 'your progress'}.` : '';
  $('#sign-in-inapp-note').classList.toggle('hidden', !keepHere);
}

// Guest wins not yet on an account: this month's daily finds (local storage) and solo wins awaiting the board.
function guestFindsHere() {
  if (user) return false;
  const month = monthKey();
  return pendingGuestHunts().length > 0 || dailyRecords.some(record => record.status === 'won' && record.day?.startsWith(month));
}

async function optInAfterSignIn(player) {
  try {
    const { whatsapp } = await loadWhatsApp(player);
    if (whatsapp?.optIn === true) return;
    await setWhatsAppOptIn(player, true, browserTimeZone());
    trackEvent(EVENTS.WHATSAPP_OPT_IN, { source: 'sign_in' });
    await refreshWhatsApp(player).catch(() => {});
  } catch (error) {
    console.warn('Could not turn on WhatsApp alerts after sign-in:', error);
    showToast("You're signed in, but WhatsApp alerts couldn't be turned on. Try again from My logs.");
  }
}

// ---- Account deletion: a confirmation, then the server erases everything and the explorer is a guest again.
function openDeleteAccount(source) {
  $('#delete-account-status').textContent = '';
  $('#delete-account-confirm').disabled = false;
  $('#delete-account-keep').disabled = false;
  trackEvent(EVENTS.ACCOUNT_DELETE_OPENED, { source });
  deleteSource = source;
  if (!$('#delete-account-dialog').open) $('#delete-account-dialog').showModal();
}

async function confirmDeleteAccount() {
  const confirm = $('#delete-account-confirm'), keep = $('#delete-account-keep');
  confirm.disabled = keep.disabled = true;
  $('#delete-account-status').textContent = 'Deleting…';
  try {
    await deleteAccount();
  } catch (error) {
    console.warn('Could not delete the account:', error);
    confirm.disabled = keep.disabled = false;
    $('#delete-account-status').textContent = 'Your account could not be deleted. Try again.';
    return;
  }
  trackEvent(EVENTS.ACCOUNT_DELETED, { source: deleteSource });
  $('#delete-account-dialog').close();
  showToast('Your account has been deleted.');
}

function closeSignIn() {
  if ($('#sign-in-dialog').open) $('#sign-in-dialog').close();
}

// ---- The unsubscribe link waits until no other dialog or hunt is on screen.
function dialogsBusy() {
  return ['#welcome-dialog', '#sign-in-dialog', '#delete-account-dialog', '#whatsapp-dialog', '#account-dialog', '#install-dialog'].some(selector => $(selector).open);
}

function showDeferredDialogs() {
  if (!user || profileReadyFor !== user.uid || dialogsBusy()) return;
  if (pendingUnsubscribe) showUnsubscribe();
  else if (pendingDelete) showDeleteLink();
}

function showDeleteLink() {
  pendingDelete = false;
  removeUrlParams(['account']);
  openDeleteAccount('link');
}

function openWhatsAppDialog(kicker, html) {
  whatsappDialogVerify?.destroy();
  whatsappDialogVerify = null;
  $('#whatsapp-dialog-kicker').textContent = kicker;
  $('#whatsapp-dialog-content').innerHTML = html;
  if (!$('#whatsapp-dialog').open) $('#whatsapp-dialog').showModal();
}

function whatsappDoneView(phone) {
  return `<h2>You're <em>in.</em></h2><p class="wa-lead">We'll message ${escapeHTML(maskPhone(phone))} on WhatsApp when each new daily quest goes live, and nothing else. Reply STOP or turn it off in My logs anytime.</p><button id="wa-dialog-done" class="primary-button" type="button">Done <span aria-hidden="true">↗</span></button>`;
}

function bindWhatsAppDone() {
  $('#wa-dialog-done')?.addEventListener('click', () => $('#whatsapp-dialog').close());
}

// Asks for browser notification permission, then registers this browser for background alerts.
// The notifications_permission event waits for the registration so it can carry its outcome.
async function requestBrowserNotifications(source) {
  const permission = await Notification.requestPermission();
  const player = user;
  (async () => {
    const outcome = permission !== 'granted' ? (permission === 'denied' ? 'denied' : 'dismissed')
      : player ? await registerChallengePush(player) : 'signed_out';
    trackEvent(EVENTS.NOTIFICATIONS_PERMISSION, { permission, outcome, source });
  })();
  return permission;
}

// ---- Daily quest alert card: after a daily quest, signed-in explorers with a username who haven't
// opted in (or out) see it below the result's actions. Guests are asked during sign-in instead.
const resultAlert = document.createElement('section');
resultAlert.className = 'wa-section result-alert hidden';
resultAlert.setAttribute('aria-labelledby', 'result-alert-heading');
elements.result.append(resultAlert);

// ---- Installing the app. src/pwa.js decides which way this browser can install: its own prompt, the iOS
// Share menu, or a trip to the real browser first.
//
// The install sheet opens by itself after a win and after signing in, at most once every two days.
// A sign-up ask always goes first: a guest's winning result shows the sign-in ask with the install card
// beneath it and the sheet follows once they have signed in, a new explorer picks a username before the
// sheet, and the daily quest alert card is answered before the sheet opens over it.
//
// Every offer ends in one of two events: install_started (the explorer took it) or
// install_prompt_dismissed (they closed it or said "Not now"). app_installed follows when the browser
// confirms the install, or on the installed app's first launch where it cannot (iOS and the Play app).
const INSTALLED_KEY = 'treasurehunch.installed';
function rememberInstalled() {
  try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { /* Counted again next launch at worst. */ }
}
let installMethod = '';
const installer = createInstaller({ track: () => {
  rememberInstalled();
  trackEvent(EVENTS.APP_INSTALLED, { method: installMethod || 'browser', display_mode: DISPLAY_MODE });
} });
if (DISPLAY_MODE !== 'browser') {
  let counted = true;
  try { counted = localStorage.getItem(INSTALLED_KEY) === '1'; } catch { /* Without storage it cannot be counted once. */ }
  if (!counted) {
    rememberInstalled();
    trackEvent(EVENTS.APP_INSTALLED, { method: DISPLAY_MODE === 'twa' ? 'play_store' : 'home_screen', display_mode: DISPLAY_MODE });
  }
}
const wakeLock = createWakeLock();
const resultInstall = document.createElement('section');
resultInstall.className = 'wa-section result-install hidden';
resultInstall.setAttribute('aria-labelledby', 'result-install-heading');
elements.result.append(resultInstall);
const REAL_BROWSER = IN_APP_PLATFORM === 'android' ? 'Chrome' : IN_APP_PLATFORM === 'ios' ? 'Safari' : 'your browser';
const IN_APP_NAME = { instagram: 'Instagram', facebook: 'Facebook', messenger: 'Messenger', whatsapp: 'WhatsApp', line: 'LINE' }[IN_APP] || 'This app';
const INSTALL_COPY = {
  prompt: ['Get the app', 'One tap from your home screen'],
  ios_steps: ['Add to Home Screen', 'Full screen, no App Store needed'],
  open_in_browser: [`Open in ${REAL_BROWSER} to install`, `${IN_APP_NAME}'s browser can't add apps`],
};
const SHARE_ICON = '<svg class="install-share-icon" viewBox="0 0 15 17" aria-hidden="true"><path d="M7.5 1v10M4 4l3.5-3L11 4M2 8v7.5h11V8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function hideResultInstall() {
  resultInstall.classList.add('hidden');
  resultInstall.replaceChildren();
}

function renderInstallEntry() {
  const path = installer.path();
  const copy = INSTALL_COPY[path];
  $('#home-install-button').classList.toggle('hidden', !copy);
  if (!copy) { hideResultInstall(); return; }
  $('#home-install-button strong').textContent = copy[0];
  $('#home-install-hint').textContent = copy[1];
  trackEvent(EVENTS.INSTALL_PROMPT_SHOWN, { source: 'home', method: path }, 'home');
}

// A guest's winning result: the card sits beneath the sign-in ask, so signing up is always seen first.
// Explorers with a username get the sheet instead.
function showResultInstall() {
  const path = installer.path();
  if (!lastResult || lastResult.status !== 'won' || elements.result.classList.contains('hidden') || (user && username)
      || !shouldOfferInstall({ path, promptedAt: installer.promptedAt() })) { hideResultInstall(); return; }
  resultInstall.innerHTML = `<h3 id="result-install-heading">Keep TreasureHunch one tap away</h3>
    <p class="wa-caption">${path === 'open_in_browser'
    ? `Put TreasureHunch on your home screen. ${IN_APP_NAME}'s browser can't do that, so it opens in ${REAL_BROWSER} first.`
    : 'Put TreasureHunch on your home screen: full screen, quicker to open, and it works offline.'}</p>
    <button id="result-install-start" class="secondary-button" type="button">${INSTALL_COPY[path][0]} <span aria-hidden="true">↗</span></button>
    <div class="result-alert-links"><button id="result-install-later" class="text-button" type="button">Not now</button></div>`;
  resultInstall.classList.remove('hidden');
  trackEvent(EVENTS.INSTALL_PROMPT_SHOWN, { source: 'result_card', method: path }, `result-${lastResult.day || `${lastResult.puzzle?.id}-${lastResult.level || ''}`}`);
  $('#result-install-start').addEventListener('click', () => startInstall('result_card'));
  // "Not now" pauses every install offer for two days on this device.
  $('#result-install-later').addEventListener('click', () => {
    installer.markPrompted();
    hideResultInstall();
    trackEvent(EVENTS.INSTALL_PROMPT_DISMISSED, { source: 'result_card', method: path });
  });
}

// `installDue` holds why a sheet is waiting to open ('win' or 'sign_in'). It waits for dialogs to close,
// for any sign-up ask to be answered and, on Android, for the browser to hand over its install prompt.
// Starting a hunt drops it: the moment has passed, and the next win raises it again.
let installDue = '';
let sawSignedOut = false;
let installSheet = null;
// True while the daily quest alert card is on screen waiting for an answer.
let alertAsking = false;
function maybeOfferInstall() {
  if (!installDue || dialogsBusy() || document.body.classList.contains('in-game') || document.body.classList.contains('in-hide')) return;
  // Sign-up first: a guest sees the sign-in ask (and the card), a new explorer still has a username to
  // choose, and the alert card is waiting for its answer.
  if (!user || !username || alertAsking) return;
  const path = installer.path();
  if (!shouldOfferInstall({ path, promptedAt: installer.promptedAt() })) {
    // 'unavailable' can still turn into 'prompt' a few seconds into a first visit; anything else is final.
    if (path !== 'unavailable') installDue = '';
    return;
  }
  const source = installDue;
  installDue = '';
  installer.markPrompted();
  hideResultInstall();
  trackEvent(EVENTS.INSTALL_PROMPT_SHOWN, { source, method: path });
  openInstallDialog(source, path === 'prompt' ? 'offer' : path);
}
// A short pause lets the win, or the claim's confirmation, be seen first.
const offerInstallSoon = () => setTimeout(maybeOfferInstall, 1200);
function requestInstallSheet(reason) {
  installDue = reason;
  offerInstallSoon();
}

// The explorer took an install offer. The browser's own prompt is shown where there is one; elsewhere
// the sheet explains how, and its main button counts as taking the offer.
async function startInstall(source) {
  const path = installer.path();
  if (path !== 'prompt') { openInstallDialog(source, path); return; }
  trackEvent(EVENTS.INSTALL_STARTED, { source, method: 'prompt' });
  installMethod = 'prompt';
  const outcome = await installer.prompt();
  if (outcome === 'accepted') {
    hideResultInstall();
    showToast('Adding TreasureHunch to your home screen…');
  } else if (outcome === 'dismissed') {
    installer.markPrompted();
    trackEvent(EVENTS.INSTALL_PROMPT_DISMISSED, { source, method: 'prompt' });
  } else {
    openInstallDialog(source, 'unavailable');
  }
  renderInstallEntry();
}

function openInstallDialog(source, path = installer.path()) {
  const content = $('#install-content');
  const sheet = { source, method: path === 'offer' ? 'prompt' : path, acted: false };
  installSheet = sheet;
  const later = '<button id="install-later" class="text-button" type="button">Not now</button>';
  if (path === 'offer') {
    // One button, which is the tap the browser needs before it will show its own prompt.
    content.innerHTML = `<h2>Keep your map <em>one tap away.</em></h2>
      <p>Add TreasureHunch to your home screen. It opens full screen, works offline, and tomorrow's country is a single tap away.</p>
      <button id="install-now" class="primary-button" type="button">Install the app <span aria-hidden="true">↗</span></button>${later}`;
    $('#install-now').addEventListener('click', () => { sheet.acted = true; $('#install-dialog').close(); startInstall(source); });
  } else if (path === 'ios_steps') {
    installMethod = 'ios_steps';
    content.innerHTML = `<h2>Add it to your <em>Home Screen.</em></h2>
      <p>TreasureHunch then opens full screen from its own icon and can send you each day's quest as a notification.</p>
      <ol class="install-steps"><li>Tap <b>Share</b> ${SHARE_ICON} in the browser's toolbar.</li><li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>, then open TreasureHunch from the new icon.</li></ol>
      <p class="wa-caption">The app keeps its own sign-in, so sign in once inside it to bring your map along.</p>
      <button id="install-close" class="primary-button" type="button">Got it <span aria-hidden="true">↗</span></button>${later}`;
    // iOS reports nothing until the app is first opened, so "Got it" is the install action here.
    $('#install-close').addEventListener('click', () => {
      sheet.acted = true;
      trackEvent(EVENTS.INSTALL_STARTED, { source, method: 'ios_steps' });
      $('#install-dialog').close();
    });
  } else if (path === 'open_in_browser') {
    content.innerHTML = `<h2>Open in <em>${REAL_BROWSER}.</em></h2>
      <p>${IN_APP_NAME}'s built-in browser can't add apps to your phone. Open TreasureHunch in ${REAL_BROWSER} and install it from there.</p>
      ${guestFindsHere() ? '<p class="wa-caption">Sign in here first: finds made as a guest stay in this browser, while a signed-in map comes with you.</p>' : user ? `<p class="wa-caption">Sign in again in ${REAL_BROWSER} and your map is there.</p>` : ''}
      <button id="install-open-browser" class="primary-button" type="button">Open in ${REAL_BROWSER} <span aria-hidden="true">↗</span></button>${later}
      <p id="install-inapp-note" class="wa-caption hidden" aria-live="polite"></p>
      <input id="install-inapp-url" class="sign-in-inapp-url hidden" type="url" readonly aria-label="Link to open in your browser">`;
    $('#install-open-browser').addEventListener('click', () => {
      sheet.acted = true;
      trackEvent(EVENTS.INSTALL_STARTED, { source, method: 'open_in_browser' });
      openInRealBrowser('install', { install: '1' }, $('#install-inapp-note'), $('#install-inapp-url'));
    });
    $('#install-inapp-url').addEventListener('focus', event => event.target.select());
  } else {
    // A browser that has not offered its prompt yet (it can take a few seconds), or one without a prompt.
    content.innerHTML = `<h2>Install <em>TreasureHunch.</em></h2>
      <p>Add it to your home screen for a full-screen game that opens in one tap.</p>
      <button id="install-now" class="primary-button" type="button">Install <span aria-hidden="true">↗</span></button>${later}
      <p class="wa-caption">If the button does nothing, open your browser's menu (⋮) and choose <b>Add to Home screen</b> or <b>Install app</b>.</p>`;
    const button = $('#install-now');
    const sync = () => { if (button.isConnected) button.disabled = installer.path() !== 'prompt'; };
    sync();
    const stop = installer.onChange(sync);
    $('#install-dialog').addEventListener('close', stop, { once: true });
    button.addEventListener('click', () => { sheet.acted = true; $('#install-dialog').close(); startInstall(source); });
  }
  $('#install-later').addEventListener('click', () => $('#install-dialog').close());
  if (!$('#install-dialog').open) $('#install-dialog').showModal();
}

function hideResultAlert() {
  alertAsking = false;
  resultAlertVersion += 1;
  resultAlertVerify?.destroy();
  resultAlertVerify = null;
  resultAlert.classList.add('hidden');
  resultAlert.replaceChildren();
}

async function showResultAlert(day) {
  hideResultAlert();
  const player = user;
  if (!player || !username) return;
  const version = resultAlertVersion;
  const state = await refreshWhatsApp(player).catch(error => { console.warn('WhatsApp settings unavailable:', error); return null; });
  if (!state || version !== resultAlertVersion || user?.uid !== player.uid || lastResult?.day !== day) return;
  if (!whatsappPromptEligible({ signedIn: true, username, whatsapp: state.whatsapp, snoozedAt: state.snoozedAt })) return;
  const whatsapp = state.whatsapp;
  const verified = isVerified(whatsapp);
  const offerPush = browserNotificationsAvailable() && Notification.permission === 'default';
  resultAlert.innerHTML = `<h3 id="result-alert-heading">Get tomorrow's country on WhatsApp</h3>
    <p class="wa-caption">One message when each new daily quest goes live. Nothing else. Reply STOP anytime.</p>
    ${verified
    ? `<label class="wa-consent"><input id="result-alert-consent" type="checkbox" /><span>${CONSENT_COPY}</span></label><p class="wa-caption">We'll message ${escapeHTML(maskPhone(whatsapp.phone))}.</p><button id="result-alert-on" class="secondary-button" type="button" disabled>Yes, alert me <span aria-hidden="true">↗</span></button>`
    : '<button id="result-alert-start" class="secondary-button" type="button">Get alerts on WhatsApp <span aria-hidden="true">↗</span></button><div id="result-alert-verify"></div>'}
    <p id="result-alert-status" class="friend-status" role="status" aria-live="polite"></p>
    <div class="result-alert-links">${offerPush ? '<button id="result-alert-push" class="text-button" type="button">Or get a browser notification</button>' : ''}<button id="result-alert-later" class="text-button" type="button">Not now</button></div>`;
  resultAlert.classList.remove('hidden');
  alertAsking = true;
  trackEvent(EVENTS.WHATSAPP_PROMPT_SHOWN, { source: 'result_card', step: verified ? 'consent' : 'verify' }, day);
  const setStatus = message => { $('#result-alert-status').textContent = message; };
  const accepted = phone => {
    if (version !== resultAlertVersion) return;
    resultAlertVerify?.destroy();
    resultAlertVerify = null;
    resultAlert.innerHTML = `<h3 id="result-alert-heading">You're <em>in.</em></h3><p class="wa-caption">We'll message ${escapeHTML(maskPhone(phone))} on WhatsApp when each new daily quest goes live, and nothing else. Reply STOP or turn it off in My logs anytime.</p>`;
    alertAsking = false;
    offerInstallSoon();
  };
  if (verified) {
    const consent = $('#result-alert-consent');
    const button = $('#result-alert-on');
    consent.addEventListener('change', () => { button.disabled = !consent.checked; });
    button.addEventListener('click', async () => {
      if (!consent.checked) return;
      button.disabled = true;
      try {
        await turnOnWhatsApp(player, 'result_card');
        accepted(whatsapp.phone);
      } catch (error) {
        console.error(error);
        setStatus('Alerts could not be turned on. Please try again.');
        button.disabled = !consent.checked;
      }
    });
  } else {
    $('#result-alert-start').addEventListener('click', event => {
      event.currentTarget.remove();
      resultAlertVerify = createWhatsAppVerify($('#result-alert-verify'), {
        purpose: 'verify_phone', source: 'result_card', requireConsent: true, submitLabel: 'Verify on WhatsApp',
        onVerified: async ({ phone }) => {
          await turnOnWhatsApp(player, 'result_card');
          accepted(phone);
        },
      });
      resultAlertVerify.focus();
    });
  }
  $('#result-alert-push')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const permission = await requestBrowserNotifications('result_card');
      setStatus(permission === 'granted' ? "Browser notifications are on. You'll hear when each day's quest arrives."
        : permission === 'denied' ? 'Browser notifications are off. You can still get the alert on WhatsApp.' : '');
    } catch (error) {
      console.warn('Notification permission could not be requested:', error);
      setStatus('Browser notifications are unavailable here.');
    }
    button.remove();
  });
  // "Not now" hides the card until the next daily quest (the next UTC day) on this account.
  $('#result-alert-later').addEventListener('click', () => {
    hideResultAlert();
    offerInstallSoon();
    trackEvent(EVENTS.WHATSAPP_PROMPT_DISMISSED, { source: 'result_card' });
    snoozeWhatsAppPrompt(player).catch(error => console.warn('Could not snooze the WhatsApp prompt:', error));
  });
}

// The template's "Stop these alerts" link (?whatsapp=stop). The link carries no token, so the explorer
// signs in first; then the alert is switched off straight away, with one tap to turn it back on.
async function showUnsubscribe() {
  const player = user;
  pendingUnsubscribe = false;
  removeUrlParams(['whatsapp']);
  let state = null;
  let stopped = false;
  try {
    state = await refreshWhatsApp(player);
    if (state?.whatsapp?.optIn === true) {
      await turnOffWhatsApp(player, 'unsubscribe');
      stopped = true;
    }
  } catch (error) {
    console.error(error);
    if (user?.uid !== player.uid) return;
    openWhatsAppDialog('✦   WHATSAPP ALERTS', `<h2>Something went <em>wrong.</em></h2>
      <p class="wa-lead">Your WhatsApp alerts could not be switched off just now. Reply STOP to the WhatsApp message, or turn them off in My logs.</p>
      <button id="wa-dialog-done" class="primary-button" type="button">Done <span aria-hidden="true">↗</span></button>`);
    bindWhatsAppDone();
    return;
  }
  if (user?.uid !== player.uid) return;
  const whatsapp = state?.whatsapp;
  const canResume = isVerified(whatsapp);
  openWhatsAppDialog('✦   WHATSAPP ALERTS', `<h2>You're <em>unsubscribed.</em></h2>
    <p class="wa-lead">${stopped ? "You won't get daily quests on WhatsApp any more." : "You're not getting daily quests on WhatsApp, so nothing will be sent."}${stopped || canResume ? ' Your number stays linked so you can still sign in with it.' : ''} If the message came to a different number, sign in with that WhatsApp number, or reply STOP to the message.</p>
    ${canResume ? `<div class="wa-section"><h3>Changed your mind?</h3><label class="wa-consent"><input id="wa-resume-consent" type="checkbox" /><span>${CONSENT_COPY}</span></label><p class="wa-caption">We'll message ${escapeHTML(maskPhone(whatsapp.phone))}.</p><button id="wa-resume" class="secondary-button" type="button" disabled>Turn alerts back on <span aria-hidden="true">↗</span></button><p id="wa-resume-status" class="friend-status" role="status"></p></div>` : ''}
    <button id="wa-dialog-done" class="primary-button" type="button">Done <span aria-hidden="true">↗</span></button>`);
  bindWhatsAppDone();
  if (!canResume) return;
  const consent = $('#wa-resume-consent');
  const resume = $('#wa-resume');
  consent.addEventListener('change', () => { resume.disabled = !consent.checked; });
  resume.addEventListener('click', async () => {
    resume.disabled = true;
    try {
      await turnOnWhatsApp(player, 'unsubscribe');
      $('#whatsapp-dialog-content').innerHTML = whatsappDoneView(whatsapp.phone);
      bindWhatsAppDone();
    } catch (error) {
      console.error(error);
      $('#wa-resume-status').textContent = 'Alerts could not be turned back on. Try again from My logs.';
      resume.disabled = !consent.checked;
    }
  });
}

// ---- Settings in the explorer log: verify, switch on or off, or change the number.
async function renderAccountWhatsApp(player, changing = false) {
  const body = $('#account-whatsapp-body');
  if (!body) return;
  accountVerify?.destroy();
  accountVerify = null;
  let state;
  try { state = await refreshWhatsApp(player); }
  catch (error) {
    console.warn('WhatsApp settings unavailable:', error);
    if (body.isConnected) body.textContent = 'Your WhatsApp settings could not load.';
    return;
  }
  if (!state || !body.isConnected || user?.uid !== player.uid) return;
  const whatsapp = state.whatsapp;
  if (!isVerified(whatsapp) || changing) {
    body.innerHTML = `<p class="log-caption">${changing ? "Verify your new number. It's also the number you sign in with on WhatsApp." : "Get one WhatsApp message when each new daily quest goes live. Nothing else, and you can stop anytime."}</p><div id="account-whatsapp-verify"></div>${changing ? '<button id="account-whatsapp-cancel" class="text-button" type="button">Keep my current number</button>' : ''}`;
    accountVerify = createWhatsAppVerify($('#account-whatsapp-verify'), {
      purpose: 'verify_phone', source: 'settings', requireConsent: true, submitLabel: 'Verify on WhatsApp',
      onVerified: async () => {
        await turnOnWhatsApp(player, 'settings');
        showToast('WhatsApp alerts are on.');
        renderAccountWhatsApp(player);
      },
    });
    $('#account-whatsapp-cancel')?.addEventListener('click', () => renderAccountWhatsApp(player));
    return;
  }
  const on = whatsapp.optIn === true;
  body.innerHTML = `<label class="wa-toggle"><input id="account-whatsapp-toggle" type="checkbox" role="switch" ${on ? 'checked' : ''} /><span class="wa-toggle-track" aria-hidden="true"></span><span class="wa-toggle-copy"><strong>${on ? 'On' : 'Off'}</strong><small>${escapeHTML(maskPhone(whatsapp.phone))}</small></span></label><p class="log-caption">${on ? 'One message when each new daily quest goes live, in your morning. Reply STOP anytime.' : CONSENT_COPY}</p><p id="account-whatsapp-status" class="friend-status" role="status"></p><button id="account-whatsapp-change" class="text-button" type="button">Change number</button>`;
  const toggle = $('#account-whatsapp-toggle');
  toggle.addEventListener('change', async () => {
    const next = toggle.checked;
    toggle.disabled = true;
    try {
      if (next) await turnOnWhatsApp(player, 'settings'); else await turnOffWhatsApp(player, 'settings');
      renderAccountWhatsApp(player);
    } catch (error) {
      console.error(error);
      toggle.checked = !next;
      toggle.disabled = false;
      $('#account-whatsapp-status').textContent = 'Your alert setting could not be saved. Try again.';
    }
  });
  $('#account-whatsapp-change').addEventListener('click', () => renderAccountWhatsApp(player, true));
}

// The inbox, without challenges from blocked explorers. Blocks are watched alongside, so a new block hides
// that explorer's challenges and friend hunts at once.
function watchInbox(player) {
  stopChallenges?.();
  let firstSnapshot = true;
  let known = new Set();
  // Nothing is shown until both the inbox and the blocks have loaded once, so no blocked challenge flashes up.
  let received = null;
  let blocksReady = false;
  blockedUids = new Set();
  let markBlocksLoaded;
  blocksLoaded = new Promise(resolve => { markBlocksLoaded = resolve; });
  const stopInbox = watchChallenges(player, next => {
    if (user?.uid !== player.uid) return;
    received = next;
    renderInbox();
  }, error => console.warn('Could not load challenges:', error));
  const stopBlocks = watchBlocks(player, blocked => {
    if (user?.uid !== player.uid) return;
    blockedUids = blocked;
    blocksReady = true;
    markBlocksLoaded();
    renderInbox();
    renderAccountHistory();
  }, error => {
    console.warn('Could not load blocked explorers:', error);
    blocksReady = true;
    markBlocksLoaded();
    renderInbox();
  });
  stopChallenges = () => {
    stopInbox();
    stopBlocks();
    blockedUids = new Set();
    inboxChallenges = [];
    accountHistory = null;
    blocksLoaded = Promise.resolve();
  };

  function renderInbox() {
    if (user?.uid !== player.uid || !received || !blocksReady) return;
    const challenges = visibleChallenges(received, blockedUids);
    inboxChallenges = challenges;
    const unread = challenges.filter(challenge => !challenge.read);
    unreadChallenges = unread.length;
    refreshBadge();
    $('#account-challenge-count').textContent = String(unread.length);
    $('#account-challenge-count').classList.toggle('hidden', unread.length === 0);
    elements.accountButton.setAttribute('aria-label', unread.length
      ? `Open explorer log, ${unread.length} new ${unread.length === 1 ? 'challenge' : 'challenges'}`
      : 'Open explorer log');
    $('#challenge-inbox-count').textContent = String(unread.length);
    $('#challenge-list').innerHTML = challenges.length
      ? challenges.map(challenge => `<div class="challenge-row"><button class="challenge-item ${challenge.read ? '' : 'unread'}" type="button" data-code="${escapeHTML(challenge.code)}"><span><strong>@${escapeHTML(challenge.fromUsername)}</strong> hid a treasure for you.<small>${challenge.read ? 'Open hunt' : 'New challenge · open hunt'}</small></span><span aria-hidden="true">↗</span></button><span class="moderation-actions"><button class="text-button" type="button" data-report="${escapeHTML(challenge.code)}" aria-label="Report @${escapeHTML(challenge.fromUsername)}">Report</button><button class="text-button" type="button" data-block="${escapeHTML(challenge.code)}" aria-label="Block @${escapeHTML(challenge.fromUsername)}">Block</button></span></div>`).join('')
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
  }
}

function inboxSender(code) {
  const challenge = inboxChallenges.find(item => item.code === code);
  return challenge ? { uid: challenge.fromUid, name: `@${challenge.fromUsername}` } : null;
}

// Friend hunts in My logs, without those played with blocked explorers.
function renderAccountHistory() {
  const container = $('#multiplayer-log');
  if (!accountHistory || !container?.isConnected || user?.uid !== accountHistory.uid) return;
  container.innerHTML = historyContent(visibleHunts(accountHistory.hunts, accountHistory.uid, blockedUids), accountHistory.uid);
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

// New seekers often read the first clue and never touch the map, so their first hunt on a device points at it once.
function mapHintSeen() {
  if (mapHintShown) return true;
  try { return localStorage.getItem(MAP_HINT_KEY) === '1'; } catch { return false; }
}

function scheduleMapHint() {
  hideMapHint();
  const returning = completedWins > 0 || dailyRecords.some(record => record.status !== 'playing');
  if (returning || mapHintSeen()) return;
  // A short pause lets the seeker read the first clue before the map is pointed out.
  mapHintTimeout = setTimeout(() => {
    const state = game?.snapshot();
    if (!state || state.status !== 'playing' || state.selected) return;
    mapHintShown = true;
    try { localStorage.setItem(MAP_HINT_KEY, '1'); } catch { /* Without storage it shows once per page load. */ }
    elements.mapHint.classList.remove('hidden');
    trackEvent(EVENTS.ONBOARDING_HINT_SHOWN, huntParameters(state));
  }, 1200);
}

function hideMapHint() {
  clearTimeout(mapHintTimeout);
  elements.mapHint.classList.add('hidden');
}

function selectMapCountry(country) {
  if (!game) return;
  const state = game.select(country);
  if (state.selected?.id !== country.id) {
    if (state.tried.includes(country.id)) showToast('You already ruled that country out.');
    return;
  }
  trackEvent(EVENTS.COUNTRY_SELECTED, { ...huntParameters(state), method: 'map' });
  if (!elements.mapHint.classList.contains('hidden')) trackEvent(EVENTS.ONBOARDING_HINT_COMPLETED, huntParameters(state));
  hideMapHint();
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
      // Finger jitter of a few pixels would otherwise turn a tap into a tiny drag and drop the click.
      clickTolerance: 10,
      attributionControl: false,
      // Keeps the last frame readable so session replay can capture the map canvas.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.on('load', () => {
      map.addSource('countries', { type: 'geojson', data: countryData, generateId: false });
      map.addLayer({ id: 'land', type: 'fill', source: 'countries', paint: { 'fill-color': ['match', ['get', 'id'], ['USA', 'CAN', 'BRA', 'AUS', 'CHN', 'RUS'], '#d4ccaf', '#c4c5a8'], 'fill-opacity': 0.98 } });
      map.addLayer({ id: 'borders', type: 'line', source: 'countries', paint: { 'line-color': '#668078', 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 4, 1.4], 'line-opacity': 0.9 } });
      // Claimed countries: amber for earlier months, coral for this month, with a soft glow.
      map.addLayer({ id: 'atlas-glow', type: 'line', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#ffc93c', 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 5, 4, 10], 'line-blur': 4, 'line-opacity': 0.75 } });
      map.addLayer({ id: 'atlas-country', type: 'fill', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'fill-color': '#ffb000', 'fill-opacity': 0.95 } });
      map.addLayer({ id: 'atlas-recent', type: 'fill', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'fill-color': '#ff5a36', 'fill-opacity': 0.95 } });
      map.addLayer({ id: 'atlas-border', type: 'line', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#fff8e1', 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 1.2, 4, 2.4] } });
      map.addLayer({ id: 'tried-country', type: 'fill', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'fill-color': '#314d50', 'fill-opacity': 0.55 } });
      map.addLayer({ id: 'selected-country', type: 'fill', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'fill-color': '#e4a94d', 'fill-opacity': 0.83 } });
      map.addLayer({ id: 'selected-border', type: 'line', source: 'countries', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#fff2c3', 'line-width': 2.3 } });
      map.addSource('country-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: labels } });
      map.addLayer({ id: 'labels', type: 'symbol', source: 'country-labels', layout: { 'text-field': ['get', 'name'], 'text-size': ['interpolate', ['linear'], ['zoom'], 0, 9, 3, 12], 'text-font': ['Open Sans Semibold'], 'text-allow-overlap': false }, paint: { 'text-color': '#395a57', 'text-halo-color': '#dfdcc1', 'text-halo-width': 1.2 } });
      // A tap near a small country still selects it; see map-tap.js.
      map.on('click', event => {
        const { x, y } = event.point;
        const nearby = map.queryRenderedFeatures([[x - TAP_RADIUS, y - TAP_RADIUS], [x + TAP_RADIUS, y + TAP_RADIUS]], { layers: ['land'] });
        const feature = pickTapFeature(nearby, event.point, position => map.project(position));
        if (!feature) return;
        if (friend.mapCountry(feature, event.lngLat)) return;
        if (game?.snapshot().status === 'playing') selectMapCountry({ id: feature.properties.id, country: feature.properties.name });
      });
      map.on('mouseenter', 'land', () => { map.getCanvas().style.cursor = game || ['hiding', 'seeker'].includes(friend.mode) ? 'pointer' : 'grab'; });
      map.on('mouseleave', 'land', () => { map.getCanvas().style.cursor = ''; });
      elements.mapLoading.classList.add('hidden');
      applyAtlasLayers();
      focusAtlas();
      startPendingDaily();
    });
    map.on('click', collapseSheetForMap);
    map.on('dragstart', collapseSheetForMap);
    map.on('zoomstart', event => {
      if (event.huntStart || (friend.mode === 'hiding' && friend.suppressSearchZoom)) return;
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

// The ticker runs five times a second. The clock changes once a second, and the sheet only when clues or guesses do.
function renderGame() {
  if (!game) return;
  const state = game.tick();
  if (state.status !== 'playing') { finish(state); return; }
  if (state.remaining !== huntView.remaining) {
    huntView.remaining = state.remaining;
    elements.timer.textContent = clockText(state.remaining);
    elements.progress.style.width = `${(state.remaining / state.roundSeconds) * 100}%`;
    elements.hud.classList.toggle('timer-urgent', state.remaining <= 30);
  }
  const sheetKey = huntSheetKey(state);
  if (sheetKey === huntView.sheet) return;
  huntView.sheet = sheetKey;
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
  const lastId = session.get('treasurehunch:last-country') || '';
  const puzzle = choosePuzzle(puzzles, lastId, Math.random, activeLevel, [...soloFoundIds]);
  session.set('treasurehunch:last-country', puzzle.id);
  $('#level-label').textContent = `LEVEL ${String(activeLevel).padStart(2, '0')} · ${difficultyForLevel(activeLevel).toUpperCase()} HUNT`;
  game = createGame(puzzle);
  trackEvent(EVENTS.HUNT_STARTED, huntParameters(game.snapshot()));
  openHuntScreen();
}

function openHuntScreen() {
  saved = false;
  lastResult = null;
  installDue = '';
  hideResultInstall();
  clearMapSelection();
  elements.home.classList.add('hidden');
  elements.result.classList.add('hidden');
  elements.game.classList.remove('hidden');
  $('#hunt-moderation').classList.add('hidden');
  elements.hud.classList.remove('hidden');
  document.body.classList.add('in-game', 'solo-game');
  $('#end-level-button').classList.remove('hidden');
  setSheetCollapsed(false);
  clearInterval(ticker);
  huntView = { remaining: null, sheet: '' };
  ticker = setInterval(renderGame, 200);
  // The clock keeps running while the screen is off, so keep the screen on for the three minutes.
  wakeLock.on();
  renderGame();
  map.resize();
  frameHuntStart();
  scheduleMapHint();
}

// On phones the clue sheet covers the lower half of the map, so the opening world view showed mostly
// Greenland and the Arctic. Each hunt instead starts a little closer in, centred in the strip above the sheet.
function frameHuntStart() {
  if (window.innerWidth >= 700) return;
  const sheet = elements.game.getBoundingClientRect().height;
  map.easeTo({ center: [20, 15], zoom: 1.2, offset: [0, -sheet / 2], duration: 0 }, { huntStart: true });
}

// The daily quest uses the bundled country list so every browser builds the same schedule.
function startPendingDaily() {
  if (!pendingDaily || !map?.getLayer('land')) return;
  pendingDaily = false;
  removeUrlParams(['daily']);
  if (dailyArrivalSource) trackEvent(EVENTS.DAILY_LINK_OPENED, { source: dailyArrivalSource });
  startDaily();
  dailyArrivalSource = '';
}

// Guests can play; sign-in is asked for on the result screen, to claim the find.
function startDaily() {
  const record = todayRecord();
  if (record && record.status !== 'playing') { openAtlas('', 'home'); return; }
  if (!map?.getLayer('land')) { showToast('The map is still loading. One moment!'); return; }
  if (friend.mode !== 'idle') friend.home();
  clearVictory();
  closeAtlasView();
  const today = dayKey();
  // A resumed attempt keeps its country even if the list changed after it started.
  const scheduled = dailyQuest(dailySchedules, today);
  const puzzle = record ? Object.values(dailySchedules).flat().find(item => item.id === record.puzzleId) || scheduled : scheduled;
  activeMode = 'daily';
  game = createGame(puzzle, undefined, record?.puzzleId === puzzle.id ? record : null);
  const state = game.snapshot();
  const label = new Date(`${today}T00:00:00Z`).toLocaleDateString('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).toUpperCase();
  $('#level-label').textContent = `DAILY QUEST · ${label} · ${(puzzle.difficulty || 'medium').toUpperCase()}`;
  saveDailyProgress(state);
  if (!record) trackEvent(EVENTS.HUNT_STARTED, { ...huntParameters(state), ...(dailyArrivalSource ? { source: dailyArrivalSource } : {}) });
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
  // The country is only sent once the hunt is over, so a live quest's answer never appears in analytics calls.
  if (fresh) trackEvent(EVENTS.HUNT_COMPLETED, { ...soloEventParameters(state, undefined, 'daily'), outcome: won ? 'won' : 'lost', winner_role: won ? 'seeker' : 'none', streak, country: state.puzzle?.id });
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
    elements.saveStatus.textContent = won ? 'Kept on this device until you sign in.' : '';
  }
  renderLeaderboardGate();
  showResultAlert(record.day).finally(() => {
    if (!won || lastResult?.day !== record.day) return;
    showResultInstall();
    requestInstallSheet('win');
  });
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
    const stored = JSON.parse(session.get(PENDING_ENTRY_KEY) || 'null');
    return Array.isArray(stored) ? stored : stored ? [stored] : [];
  } catch {
    return [];
  }
}

function rememberPendingGuestHunt(hunt) {
  const pending = pendingGuestHunts();
  if (!pending.some(item => item.level === hunt.level && item.puzzleId === hunt.puzzleId && item.timeLeft === hunt.timeLeft))
    pending.push(hunt);
  session.set(PENDING_ENTRY_KEY, JSON.stringify(pending));
}

function renderLeaderboardGate() {
  if (!lastResult) return;
  // An unclaimed daily win has one obvious next step: the claim button moves up under the stats
  // and the other actions (leaderboard, another hunt) turn quiet until it's done.
  const claimPending = lastResult.mode === 'daily' && lastResult.status === 'won' && !(user && username);
  elements.result.classList.toggle('claim-pending', claimPending);
  if (claimPending) $('#result-stats').after($('#result-atlas-button'));
  else $('#result-fact').after($('#result-atlas-button'));
  if (lastResult.mode === 'daily') {
    const dailyWon = lastResult.status === 'won';
    const claimed = !!user && !!username;
    const country = escapeHTML(lastResult.puzzle.country);
    // A guest's win is claimed with the main button, so the box below only covers losses.
    $('#result-atlas-button').innerHTML = claimed || !dailyWon ? 'Open my map <span>↗</span>'
      : user ? `Choose a username to claim ${country} <span>↗</span>` : `Sign in to claim ${country} <span>↗</span>`;
    elements.leaderboardSignIn.classList.toggle('hidden', claimed || dailyWon);
    elements.leaderboardSignIn.innerHTML = user ? 'Choose your username <span>↗</span>'
      : dailyWon ? `Sign in to claim ${escapeHTML(lastResult.puzzle.country)} <span>↗</span>` : 'Sign in to keep your streak <span>↗</span>';
    elements.leaderboardNote.textContent = claimed ? ''
      : dailyWon ? `Your username puts ${lastResult.puzzle.country} on your map, starts your streak and enters you on this month's board.`
        : 'Sign in to start a streak and enter the monthly board with your next find.';
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
  map.setFilter('atlas-glow', ['in', ['get', 'id'], ['literal', ids]]);
  // Dim unclaimed land while a map is open so claimed countries stand out.
  map.setPaintProperty('land', 'fill-opacity', atlasView ? 0.5 : 0.98);
  map.setFilter('atlas-border', ['in', ['get', 'id'], ['literal', ids]]);
  map.setFilter('atlas-recent', ['in', ['get', 'id'], ['literal', recent]]);
}

// The map shrinks to the area beside (desktop) or above (mobile) the map card, then frames the claimed countries.
function focusAtlas() {
  const card = $('#atlas-screen');
  if (!map?.getLayer('land') || !atlasView || atlasView.loading || card.classList.contains('hidden')) return;
  const stage = map.getContainer().parentElement;
  const rect = card.getBoundingClientRect();
  const mobile = window.innerWidth <= 700;
  stage.style.left = mobile ? '' : `${Math.round(rect.right + 12)}px`;
  stage.style.bottom = mobile ? `${Math.round(window.innerHeight - rect.top + 8)}px` : '';
  // Narrow phones need to zoom out further than a hunt allows to fit claims on different continents.
  map.setMinZoom(0);
  map.resize();
  const ids = new Set(Object.keys(atlasView.countries || {}));
  let bounds = null;
  const extend = ([lng, lat]) => {
    bounds = bounds ? [Math.min(bounds[0], lng), Math.min(bounds[1], lat), Math.max(bounds[2], lng), Math.max(bounds[3], lat)] : [lng, lat, lng, lat];
  };
  const walk = coordinates => (typeof coordinates[0] === 'number' ? extend(coordinates) : coordinates.forEach(walk));
  for (const feature of countryData?.features || []) if (ids.has(feature.properties.id)) walk(feature.geometry.coordinates);
  // With nothing claimed yet, or claims spanning the date line, frame the whole world instead.
  if (!bounds || bounds[2] - bounds[0] > 300) bounds = [-165, -50, 175, 72];
  map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: mobile ? 22 : { top: 100, bottom: 40, left: 40, right: 90 }, maxZoom: 3.2, duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900 });
}

function releaseAtlasStage() {
  const stage = map?.getContainer().parentElement;
  if (!stage || (!stage.style.left && !stage.style.bottom)) return;
  stage.style.left = '';
  stage.style.bottom = '';
  map.setMinZoom(0.5);
  map.resize();
}

function countryName(id) {
  return Object.values(dailySchedules).flat().find(puzzle => puzzle.id === id)?.country
    || puzzles.find(puzzle => puzzle.id === id)?.country
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
    : `<div><strong>${Math.round((ids.length / (countryData?.features.length || 177)) * 100)}%</strong><span>OF THE WORLD</span></div>`;
  $('#atlas-stats').innerHTML = loading || missing ? '' : `<div><strong>${ids.length}</strong><span>COUNTRIES</span></div><div><strong>${thisMonth}</strong><span>IN ${monthName(month).toUpperCase()}</span></div>${third}`;
  $('#atlas-stats').classList.toggle('hidden', !!(loading || missing));
  $('#atlas-screen').classList.toggle('atlas-empty', !!(loading || missing || !ids.length));
  $('#atlas-countries').innerHTML = ids.map(id => `<span class="atlas-chip ${countries[id].startsWith(`${month}-`) ? 'recent' : ''}">${escapeHTML(countryName(id))}</span>`).join('');
  $('#atlas-share').classList.toggle('hidden', !self || !user || !username);
  $('#atlas-sign-in').classList.toggle('hidden', !self || (!!user && !!username));
  $('#atlas-sign-in').innerHTML = user ? 'Choose a username to share your map <span aria-hidden="true">↗</span>' : 'Sign in to share your map <span aria-hidden="true">↗</span>';
  $('#atlas-own-button').classList.toggle('hidden', self);
  $('#atlas-moderation').classList.toggle('hidden', self || loading || missing || !atlasView.uid || atlasView.uid === user?.uid);
  applyAtlasLayers();
  requestAnimationFrame(focusAtlas);
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
  setUrlParam('atlas', self ? username : normalized);
  renderAtlas();
  if (self) {
    trackEvent(EVENTS.ATLAS_VIEWED, { owner: 'self', source, countries: Object.keys(atlasView.countries).length });
    return;
  }
  try {
    const atlas = await loadAtlas(normalized);
    if (atlasView?.version !== version) return;
    atlasView = { ...atlasView, loading: false, missing: !atlas, countries: atlas?.countries || {}, uid: atlas?.uid || '' };
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
  removeUrlParams(['atlas']);
  applyAtlasLayers();
  releaseAtlasStage();
  map?.easeTo({ center: [12, 21], zoom: window.innerWidth < 700 ? 0.85 : 1.1, duration: 0 });
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
      session.remove(PENDING_ENTRY_KEY);
      session.remove(RESUME_RESULT_KEY);
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
  hideResultAlert();
  hideResultInstall();
  elements.result.classList.remove('hidden');
  elements.result.classList.remove('victory');
  $('#result-art').textContent = state.status === 'won' ? '✦' : '⌛';
  $('#result-fact').textContent = state.puzzle.fact;
}

function finish(state) {
  clearInterval(ticker);
  wakeLock.off();
  hideMapHint();
  if (saved) return;
  saved = true;
  if (state.mode === 'daily' || (game && activeMode === 'daily')) { finishDaily(state); return; }
  const won = state.status === 'won';
  const resultLevel = state.level || activeLevel;
  state.level = resultLevel;
  if (won && game) {
    completedWins += 1;
    rememberCompletedWins();
    rememberSoloFound([state.puzzle.id]);
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
  if (won) {
    showResultInstall();
    requestInstallSheet('win');
  }
}

function leaveHunt(track = true) {
  const dailyRunning = activeMode === 'daily' && game?.snapshot().status === 'playing';
  if (track && game?.snapshot().status === 'playing') trackEvent(EVENTS.HUNT_ABANDONED, huntParameters(game.snapshot()));
  if (track && dailyRunning) showToast("Today's clock keeps running. Resume from the home screen.");
  clearVictory();
  clearInterval(ticker);
  wakeLock.off();
  hideMapHint();
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
  if (!user) {
    openSignIn(multiplayer ? 'multiplayer' : 'account');
    return;
  }
  elements.accountDialog.showModal();
  if (multiplayer) {
    elements.accountDialog.close();
    friend.openLobby();
    return;
  }
  elements.accountContent.innerHTML = `<h2>Welcome back, ${username ? `@${escapeHTML(username)}` : escapeHTML(user.displayName?.split(' ')[0] || 'Explorer')}.</h2><p>Your discoveries live here.</p><h3 class="log-heading">SOLO EXPLORATIONS</h3><div id="account-stats" class="account-stats">Loading your log…</div><section class="account-whatsapp" aria-labelledby="account-whatsapp-heading"><h3 id="account-whatsapp-heading" class="log-heading">DAILY QUEST ALERT ON WHATSAPP</h3><div id="account-whatsapp-body" class="log-caption">Loading…</div></section><section class="multiplayer-history" aria-labelledby="multiplayer-log-heading"><h3 id="multiplayer-log-heading" class="log-heading">FRIEND HUNTS</h3><p class="log-caption">Your rivalries, kept apart from the solo leaderboard.</p><div id="multiplayer-log" role="status">Loading friend hunts…</div><button id="multiplayer-log-retry" class="text-button hidden" type="button">Retry friend hunts ↗</button></section><button id="dialog-sign-out" class="text-button" type="button">Sign out ↗</button><button id="dialog-delete-account" class="text-button" type="button">Delete account</button>`;
  const logUser = user;
  const logContainer = $('#multiplayer-log');
  const retry = $('#multiplayer-log-retry');
  async function loadMultiplayerLog() {
    retry.classList.add('hidden');
    logContainer.textContent = 'Loading friend hunts…';
    try {
      const hunts = await loadFriendHunts(logUser);
      if (user?.uid !== logUser.uid || !logContainer.isConnected) return;
      accountHistory = { uid: logUser.uid, hunts };
      renderAccountHistory();
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
  renderAccountWhatsApp(logUser);
  $('#dialog-sign-out').addEventListener('click', async () => { await logout(); elements.accountDialog.close(); });
  $('#dialog-delete-account').addEventListener('click', () => { elements.accountDialog.close(); openDeleteAccount('account'); });
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
  // A friend hunt the explorer personally won.
  playVictory: card => { playVictory(card); requestInstallSheet('win'); },
  clearVictory,
  requestSignIn: () => openAccount('multiplayer'),
  requestUsername: () => { if (user) showWelcome(user); },
  clearMapSelection,
  setSheetCollapsed,
  isBlocked: uid => blockedUids.has(uid),
  // Never waits long: a slow or failed list must not keep an invite from opening.
  whenBlocksLoaded: () => Promise.race([blocksLoaded, new Promise(resolve => setTimeout(resolve, 5000))]),
  openModeration: (action, target) => moderation.open(action, target),
});

const moderation = createModerationDialog({
  getUser: () => user,
  requestSignIn: () => openSignIn('account'),
  // The toast sits under an open modal, so a report made from My logs is confirmed in the inbox too.
  showToast: message => {
    showToast(message);
    if (elements.accountDialog.open) $('#account-challenge-status').textContent = message;
  },
  // Blocking the other explorer of a hunt leaves it (result or clue sheet); a map stays, since maps are public anyway.
  onBlocked: target => { if (target.context === 'hunt' && friend.mode !== 'idle') friend.home(); },
});

$('#welcome-notifications').addEventListener('click', async () => {
  if (!browserNotificationsAvailable()) return;
  try {
    const permission = await requestBrowserNotifications('welcome');
    $('#welcome-notifications').classList.add('hidden');
    $('#notification-status').textContent = permission === 'granted'
      ? "Browser notifications are on. You'll hear when each day's quest arrives." : 'No problem. Challenges will still appear in your inbox.';
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
      await ensureTermsAccepted(welcomeFor);
      username = await claimUsername(welcomeFor, handle);
      installDue = 'sign_in';
      setAnalyticsUser({ uid: welcomeFor.uid, username });
      renderUsername();
    }
    const whatsappConsent = $('#welcome-whatsapp-consent');
    if (!whatsappConsent.classList.contains('hidden') && whatsappConsent.querySelector('input').checked) {
      await turnOnWhatsApp(welcomeFor, 'welcome').catch(error => {
        console.error(error);
        showToast('WhatsApp alerts could not be turned on. Try again from My logs.');
      });
    }
    $('#welcome-dialog').close();
    welcomeFor = null;
    watchInbox(user);
    friend.onAuth(user);
    renderLeaderboardGate();
    postPendingGuestEntry(user);
    const claimedCountry = lastResult?.mode === 'daily' && lastResult.status === 'won' ? lastResult.puzzle.country : '';
    syncDaily(user).then(() => {
      if (!claimedCountry) return;
      showToast(`${claimedCountry} is on your map.`);
      if (!elements.result.classList.contains('hidden')) elements.saveStatus.textContent = "Claimed and entered on this month's board.";
    }).catch(() => {});
    if (atlasView?.self) { atlasView.name = username; renderAtlas(); }
    startPendingDaily();
    if (browserNotificationsAvailable() && Notification.permission === 'granted')
      registerChallengePush(user).catch(error => console.warn('Background alerts could not start:', error));
  } catch (error) {
    console.error(error);
    status.textContent = error.message || 'Your username could not be saved. Try again.';
    // The server found no accepted Terms (a stale view, or another device): ask for the box here.
    if (error.reason === 'terms') {
      $('#welcome-terms').classList.remove('hidden');
      $('#welcome-terms').querySelector('input').focus();
    }
    if (error.message?.includes('taken') || error.message?.includes('allowed')) status.dataset.state = 'unavailable';
  } finally {
    if ($('#welcome-dialog').open) saveButton.disabled = !username && status.dataset.state !== 'available';
  }
});
$('#close-welcome').addEventListener('click', () => $('#welcome-dialog').close());
$('#welcome-dialog').addEventListener('close', () => {
  welcomeVerify?.destroy();
  welcomeVerify = null;
  showDeferredDialogs();
  offerInstallSoon();
});
$('#challenge-list').addEventListener('click', async event => {
  const action = event.target.closest('button[data-report], button[data-block]');
  if (action && user) {
    const code = action.dataset.report || action.dataset.block;
    const sender = inboxSender(code);
    if (sender) moderation.open(action.dataset.report ? 'report' : 'block', { ...sender, context: 'challenge', code, source: 'inbox' });
    return;
  }
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
$('#result-atlas-button').addEventListener('click', () => {
  // On a guest's daily win this button is the claim: sign in (or pick a username) first.
  if (lastResult?.mode === 'daily' && lastResult.status === 'won' && (!user || !username)) elements.leaderboardSignIn.click();
  else openAtlas('', 'result');
});
$('#atlas-own-button').addEventListener('click', () => openAtlas('', atlasView?.source || 'home'));
$('#atlas-share-button').addEventListener('click', () => shareAtlas(true));
$('#atlas-copy-button').addEventListener('click', () => shareAtlas(false));
for (const [selector, action] of [['#atlas-report-button', 'report'], ['#atlas-block-button', 'block']]) {
  $(selector).addEventListener('click', () => {
    if (atlasView?.uid) moderation.open(action, { uid: atlasView.uid, name: `@${atlasView.name}`, context: 'map', source: 'map' });
  });
}
$('#atlas-sign-in').addEventListener('click', () => {
  if (user) showWelcome(user);
  else openSignIn('atlas');
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
  const daily = lastResult.mode === 'daily';
  const country = escapeHTML(lastResult.puzzle.country);
  openSignIn(daily ? 'claim' : 'leaderboard', {
    resumeResult: true,
    title: daily && lastResult.status === 'won' ? `Claim <em>${country}.</em>` : daily ? 'Keep your <em>streak.</em>' : 'Enter the <em>leaderboard.</em>',
    copy: daily && lastResult.status === 'won' ? `Sign in, then pick a username to put ${lastResult.puzzle.country} on your map.`
      : daily ? 'Sign in to start a streak and enter the monthly board with your next find.' : 'Sign in to put your winning finds on the leaderboard.',
  });
});
$('#sign-in-google').addEventListener('click', async () => {
  if (!termsAgreed()) {
    $('#sign-in-status').textContent = TERMS_NEEDED;
    $('#sign-in-terms').focus();
    return;
  }
  const context = signInContext;
  // A redirect sign-in reloads the page, so the result screen is restored from session storage.
  if (context?.resumeResult && lastResult) session.set(RESUME_RESULT_KEY, JSON.stringify(lastResult));
  $('#sign-in-google').disabled = true;
  $('#sign-in-status').textContent = '';
  try {
    await login();
    if (user) session.remove(RESUME_RESULT_KEY);
    closeSignIn();
  } catch (error) {
    session.remove(RESUME_RESULT_KEY);
    // Never silent: a closed popup is the usual in-app browser failure, so point at WhatsApp above.
    const reason = googleErrorReason(error);
    trackEvent(EVENTS.LOGIN_FAILED, { method: 'google', reason });
    $('#sign-in-status').textContent = ['popup_closed', 'cancelled'].includes(reason)
      ? 'Google sign-in was closed before it finished. Try again, or use WhatsApp above.'
      : 'Sign-in could not start. Please try again.';
    console.error(error);
  } finally {
    $('#sign-in-google').disabled = false;
  }
});
// Only on a tap. Android opens Chrome by intent, Instagram on iOS by its own external-browser link and other
// iOS apps by Safari's link. The address is also copied, with the app's menu named, in case the app refuses.
// The link carries the campaign tags this visit arrived with and its analytics ids, so the visit continues
// in the real browser as the same person from the same ad.
async function openInRealBrowser(source, reason, note, field) {
  const handoff = outboundHandoff(reason, analyticsIds());
  trackEvent(EVENTS.OPEN_IN_BROWSER, { method: handoff.method, source, step: 'tap', in_app: IN_APP });
  // Android either opens Chrome or loads the same address here, so there is nothing more to explain.
  if (handoff.method === 'intent') { location.href = handoff.url; return; }
  if (handoff.method !== 'copy') location.href = handoff.url;
  try {
    await navigator.clipboard.writeText(handoff.address);
    note.textContent = handoff.method === 'copy'
      ? 'Link copied. Tap ··· (or the share icon) and choose Open in browser, or paste it into Safari.'
      : 'If nothing opened, the link is copied: tap ··· and choose Open in browser, or paste it into Safari.';
    field.classList.add('hidden');
  } catch {
    note.textContent = 'Copy this link, then open it in Safari or your browser.';
    field.value = handoff.address;
    field.classList.remove('hidden');
    if (handoff.method === 'copy') { field.focus(); field.select(); }
  }
  note.classList.remove('hidden');
}
$('#sign-in-open-browser').addEventListener('click', () =>
  openInRealBrowser('sign_in', { signin: 'google' }, $('#sign-in-inapp-note'), $('#sign-in-inapp-url')));
$('#sign-in-inapp-url').addEventListener('focus', event => event.target.select());
$('#close-sign-in').addEventListener('click', closeSignIn);
$('#sign-in-dialog').addEventListener('close', () => {
  signInVerify?.destroy();
  signInVerify = null;
  // Closed without signing in: the ?account=delete confirmation must not appear later, unprompted.
  if (!user) pendingDelete = false;
  showDeferredDialogs();
  offerInstallSoon();
});
$('#close-install').addEventListener('click', () => $('#install-dialog').close());
// Closing an install sheet without taking it is a "Not now": tracked, and no offer returns for two days.
$('#install-dialog').addEventListener('close', () => {
  const sheet = installSheet;
  installSheet = null;
  if (!sheet || sheet.acted) return;
  installer.markPrompted();
  trackEvent(EVENTS.INSTALL_PROMPT_DISMISSED, { source: sheet.source, method: sheet.method });
});
$('#home-install-button').addEventListener('click', () => startInstall('home'));
installer.onChange(() => { renderInstallEntry(); maybeOfferInstall(); });
renderInstallEntry();
$('#delete-account-dialog').addEventListener('cancel', event => { if ($('#delete-account-confirm').disabled) event.preventDefault(); });
$('#delete-account-keep').addEventListener('click', () => $('#delete-account-dialog').close());
$('#delete-account-confirm').addEventListener('click', confirmDeleteAccount);
$('#close-delete-account').addEventListener('click', () => { if (!$('#delete-account-confirm').disabled) $('#delete-account-dialog').close(); });
$('#close-whatsapp').addEventListener('click', () => $('#whatsapp-dialog').close());
$('#whatsapp-dialog').addEventListener('close', () => {
  whatsappDialogVerify?.destroy();
  whatsappDialogVerify = null;
});
$('#play-again-button').addEventListener('click', startHunt);
window.addEventListener('resize', () => { if (atlasView) requestAnimationFrame(focusAtlas); });
// Offline shell and updates. A new build is only switched in from the home screen, never mid-hunt or
// while a result or dialog is open, and an app left open for days then reloads itself onto it.
const appUpdates = startServiceWorker({
  isIdle: () => !game && friend.mode === 'idle' && !elements.home.classList.contains('hidden') && !dialogsBusy(),
});
// Keep the daily countdown and day rollover current on the home screen.
setInterval(() => {
  if (dailyScheduleMonth !== monthKey()) loadDailyList();
  if (!elements.home.classList.contains('hidden')) renderDailyHome();
  appUpdates.check();
}, 30000);
// A link out of an in-app browser that asked to install lands here: show how, once the page has settled.
if (pendingInstall) {
  setTimeout(() => {
    pendingInstall = false;
    if (dialogsBusy() || game || installer.path() === 'installed') return;
    trackEvent(EVENTS.INSTALL_PROMPT_SHOWN, { source: 'handoff', method: installer.path() });
    openInstallDialog('handoff', installer.path() === 'ios_steps' ? 'ios_steps' : installer.path() === 'open_in_browser' ? 'open_in_browser' : 'unavailable');
  }, 1200);
}
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
// Show this device's own level straight away; the remote puzzle list can take seconds or never arrive.
updateHomeStatus();
loadDailyList();
loadMap();
loadPuzzleSet();
// A link out of an in-app browser lands here: count it, then drop the handoff's own parameters and keep
// the rest (utm_*, fbclid…). `in_app` is the app the visit left; outcome=in_app means the link opened
// inside an in-app browser again (Chrome missing, or the app refused to let go).
if (arrival.fromInApp) {
  trackEvent(EVENTS.OPEN_IN_BROWSER, {
    step: 'landed', source: arrival.signIn ? 'sign_in' : arrival.install ? 'install' : 'landing',
    ...((arrival.inApp || IN_APP) && { in_app: arrival.inApp || IN_APP }), outcome: IN_APP ? 'in_app' : 'browser',
  });
}
clearHandoffParams();
{
  const sharedAtlas = new URLSearchParams(location.search).get('atlas');
  if (sharedAtlas && !new URLSearchParams(location.search).get('hunt')) openAtlas(sharedAtlas, 'link');
}
if (location.hash === '#leaderboard') showLeaderboard();
if (pendingUnsubscribe) trackEvent(EVENTS.WHATSAPP_UNSUBSCRIBE_VIEWED, { source: 'link' });
try {
  const resumed = session.get(RESUME_RESULT_KEY);
  if (resumed) {
    session.remove(RESUME_RESULT_KEY);
    finish(JSON.parse(resumed));
  }
} catch (error) {
  console.warn('Could not restore the last result:', error);
  session.remove(RESUME_RESULT_KEY);
}

watchUser(async nextUser => {
  const currentVersion = ++authVersion;
  // Signed in during this visit, as opposed to a session restored from an earlier one.
  if (!nextUser) sawSignedOut = true;
  else if (sawSignedOut) { sawSignedOut = false; installDue = 'sign_in'; }
  user = nextUser;
  profileReadyFor = '';
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
  if (!nextUser && $('#whatsapp-dialog').open) $('#whatsapp-dialog').close();
  if (nextUser) closeSignIn();
  whatsappState = null;
  hideResultAlert();
  if (!nextUser && pendingUnsubscribe) openSignIn('unsubscribe');
  else if (!nextUser && pendingDelete) openSignIn('account_delete');
  else if (!nextUser && pendingGoogleSignIn) openSignIn('open_in_browser');
  pendingGoogleSignIn = false;
  elements.accountButton.innerHTML = nextUser ? `<span class="account-avatar">${escapeHTML((nextUser.displayName || 'E')[0])}</span><span class="account-label">My logs</span><span id="account-challenge-count" class="account-alert-count hidden">0</span>` : 'Sign in <span aria-hidden="true">↗</span>';
  elements.accountButton.setAttribute('aria-label', nextUser ? 'Open explorer log' : 'Sign in');
  $('#multiplayer-hint').textContent = nextUser ? 'Hide or join a hunt' : 'Sign in required';
  if (!nextUser) friend.onAuth(null);
  else {
    try {
      const profile = await loadProfile(nextUser);
      if (currentVersion !== authVersion) return;
      username = profile?.username || '';
      profileReadyFor = nextUser.uid;
      setAnalyticsUser({ uid: nextUser.uid, username });
      renderUsername();
      if (!username || (browserNotificationsAvailable() && Notification.permission === 'default' && !session.get(`treasurehunch:notify-asked:${nextUser.uid}`))) {
        session.set(`treasurehunch:notify-asked:${nextUser.uid}`, '1');
        showWelcome(nextUser, username);
      }
      if (username) {
        watchInbox(nextUser);
        friend.onAuth(nextUser);
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
    recordTermsAcceptance(nextUser);
    session.remove(RESUME_RESULT_KEY);
    if (username) postPendingGuestEntry(nextUser);
    const claimedCountry = username && lastResult?.mode === 'daily' && lastResult.status === 'won' ? lastResult.puzzle.country : '';
    syncDaily(nextUser).then(() => {
      if (!claimedCountry || user?.uid !== nextUser.uid || elements.result.classList.contains('hidden')) return;
      showToast(`${claimedCountry} is on your map.`);
      elements.saveStatus.textContent = "Claimed and entered on this month's board.";
    }).catch(() => {});
    if (atlasView?.self) { atlasView.name = username; renderAtlas(); }
    else if (atlasView && username && atlasView.name === username) openAtlas('', atlasView.source);
    startPendingDaily();
    // The guest's card gives way once there is a username; a waiting sheet may open now.
    if (lastResult) showResultInstall();
    offerInstallSoon();
    refreshWhatsApp(nextUser).then(state => {
      const zone = browserTimeZone();
      if (state?.whatsapp?.optIn === true && zone && state.whatsapp.timeZone !== zone)
        setWhatsAppTimeZone(nextUser, zone).catch(error => console.warn('Could not update the alert time zone:', error));
    }).catch(() => {});
    showDeferredDialogs();
    loadHunts(nextUser).then(hunts => {
      if (user?.uid !== nextUser.uid) return;
      rememberSoloFound(hunts.filter(hunt => hunt.result === 'won' && typeof hunt.puzzleId === 'string').map(hunt => hunt.puzzleId));
      const remoteWins = Math.max(0, ...hunts.filter(hunt => hunt.result === 'won').map(hunt => Number.isSafeInteger(hunt.level) && hunt.level > 0 ? hunt.level : 1));
      if (remoteWins > completedWins) {
        completedWins = remoteWins;
        rememberCompletedWins();
        updateHomeStatus();
      }
    }).catch(error => console.warn('Could not sync explorer level:', error));
  }
});
