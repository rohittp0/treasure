// The event catalogue, payload policy and every analytics provider live here.
import { arrival, escapeAttempt, escapeOutcome, handoffIdentity, watchLateEscape } from './handoff.js';
import { inAppBrowser } from './escape.js';
import { DISPLAY_MODE } from './pwa.js';

export const META_PIXEL_ID = '1540952161129164';
export const POSTHOG_KEY = 'phc_mMjEnzpqWruQeWnybSbFzbFZkDRG5Ct5HcesQzZJEUPa';
export const POSTHOG_HOST = 'https://us.i.posthog.com';
// The version in package.json, sent with every event as app_version so releases can be told apart.
// Bump it whenever a release changes behaviour worth comparing before and after.
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
export const EVENTS = Object.freeze({
  PAGE_VIEW: 'page_view', LOGIN: 'login', SIGN_UP: 'sign_up', LOGOUT: 'logout',
  LOGIN_FAILED: 'login_failed', OPEN_IN_BROWSER: 'open_in_browser',
  HUNT_STARTED: 'hunt_started', HUNT_COMPLETED: 'hunt_completed', HUNT_ABANDONED: 'hunt_abandoned',
  COUNTRY_SELECTED: 'country_selected', SELECTION_CANCELLED: 'selection_cancelled',
  CLUE_OPENED: 'clue_opened', COUNTRY_REVEALED: 'country_revealed', GUESS_SUBMITTED: 'guess_submitted',
  MULTIPLAYER_OPENED: 'multiplayer_opened', CHALLENGE_SETUP: 'challenge_setup_opened',
  CHALLENGE_CREATED: 'challenge_created', CHALLENGE_ACCEPTED: 'challenge_accepted',
  INVITE_SHARED: 'invite_shared', RESULT_VIEWED: 'result_viewed', REMATCH_STARTED: 'rematch_started',
  POSTER_EXPORTED: 'poster_exported', LOGS_OPENED: 'logs_opened', HISTORY_OPENED: 'history_result_opened',
  LEADERBOARD_VIEWED: 'leaderboard_viewed', NOTIFICATIONS_PERMISSION: 'notifications_permission',
  ATLAS_VIEWED: 'atlas_viewed', ATLAS_SHARED: 'atlas_shared', SIGN_IN_OPENED: 'sign_in_opened',
  WHATSAPP_PROMPT_SHOWN: 'whatsapp_prompt_shown', WHATSAPP_PROMPT_DISMISSED: 'whatsapp_prompt_dismissed',
  WHATSAPP_CODE_REQUESTED: 'whatsapp_code_requested', WHATSAPP_VERIFIED: 'whatsapp_verified',
  WHATSAPP_VERIFY_FAILED: 'whatsapp_verify_failed', WHATSAPP_OPT_IN: 'whatsapp_opt_in',
  WHATSAPP_OPT_OUT: 'whatsapp_opt_out', WHATSAPP_UNSUBSCRIBE_VIEWED: 'whatsapp_unsubscribe_viewed',
  WHATSAPP_CODE_PASTED: 'whatsapp_code_pasted', DAILY_LINK_OPENED: 'daily_link_opened',
  ONBOARDING_HINT_SHOWN: 'onboarding_hint_shown', ONBOARDING_HINT_COMPLETED: 'onboarding_hint_completed',
  INSTALL_PROMPT_SHOWN: 'install_prompt_shown', INSTALL_PROMPT_DISMISSED: 'install_prompt_dismissed',
  INSTALL_STARTED: 'install_started', APP_INSTALLED: 'app_installed',
});
const eventNames = new Set(Object.values(EVENTS));
const allowedParameters = new Set(['in_app', 'mode', 'role', 'level', 'difficulty', 'round_seconds', 'time_used',
  'time_remaining', 'clues_opened', 'wrong_guesses', 'outcome', 'winner_role', 'personal_win', 'source',
  'method', 'targeted', 'revealed', 'clue_number', 'cost_seconds', 'permission', 'account_status',
  'board', 'owner', 'streak', 'countries', 'purpose', 'step', 'reason', 'country', 'display_mode', 'app_version']);
const metaStandardEvents = { page_view: 'PageView', sign_up: 'CompleteRegistration' };

export function cleanEventParameters(parameters = {}) {
  return Object.fromEntries(Object.entries(parameters).filter(([key, value]) =>
    allowedParameters.has(key) && (typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 80))));
}

// Injected sinks keep tracking testable and prevent a failed provider from affecting gameplay.
export function createEventTracker({ enabled = true, version = '', meta = () => {}, google = () => {}, posthog = () => {} } = {}) {
  const seen = new Set();
  let accountStatus = 'guest';
  return {
    setSignedIn(signedIn) { accountStatus = signedIn ? 'signed_in' : 'guest'; },
    track(name, parameters = {}, onceKey = '') {
      if (!enabled || !eventNames.has(name) || (onceKey && seen.has(`${name}:${onceKey}`))) return false;
      if (onceKey) seen.add(`${name}:${onceKey}`);
      const payload = cleanEventParameters({ ...parameters, account_status: accountStatus, ...(version ? { app_version: version } : {}) });
      try { google(name, payload); } catch { /* Analytics must never interrupt a hunt. */ }
      try { meta(metaStandardEvents[name] ? 'track' : 'trackCustom', metaStandardEvents[name] || name, payload); } catch { /* The other providers still receive their event. */ }
      try { posthog(name, payload); } catch { /* The other providers still receive their event. */ }
      return true;
    },
  };
}

let tracker = createEventTracker({ enabled: false });
let initialized = false;
let posthogClient = null;
let analyticsUser = { user_id: null, username: null };
// Whether Firebase has reported the sign-in state yet. Until then the last known account stays on events.
let authKnown = false;
// Events tracked while analytics waits to learn whether the automatic redirect took the visitor away.
let waiting = null;

// Remembers whether this browser was signed in last time, so the first events of a visit (page_view,
// daily_link_opened) carry the right account_status before Firebase has restored the session.
const ACCOUNT_KEY = 'treasurehunch.account';
function rememberedSignIn() {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(ACCOUNT_KEY) === '1'; } catch { return false; }
}
let signedIn = rememberedSignIn();

// Errors thrown by an in-app browser's own injected scripts, or hidden behind a cross-origin "Script error.".
// They are not ours to fix and were nine in ten of all reported exceptions.
export function isNoiseException(properties = {}) {
  const values = [
    ...(Array.isArray(properties.$exception_list) ? properties.$exception_list.map(item => item?.value) : []),
    ...(Array.isArray(properties.$exception_values) ? properties.$exception_values : []),
  ].filter(value => typeof value === 'string');
  return values.length > 0 && values.every(value => /Java object is gone|^Script error\.?$/.test(value));
}

// PostHog-only properties on every event: how the game is running and which in-app browser it is in.
export function contextProperties(ua = '', displayMode = 'browser') {
  const inApp = inAppBrowser(ua);
  return { display_mode: displayMode, ...(inApp ? { in_app: inApp } : {}) };
}

export function initializeTracking(app, { enabled = !import.meta.env?.DEV } = {}) {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  if (!enabled) return;
  // Read now, before other URL handling cleans the address bar.
  const internal = internalDevice();
  if (!escapeAttempt) { startTracking(app, internal, null); return; }
  // index.html tried to send this visit on to the real browser. If that worked, this page is left behind in
  // the background and must stay silent, or every redirected visitor would be counted twice.
  waiting = [];
  escapeOutcome().then(outcome => startTracking(app, internal, outcome));
}

function startTracking(app, internal, escaped) {
  // Same queue/bootstrap as Meta's supplied snippet, kept here to avoid duplicate setup.
  if (!window.fbq) {
    const fbq = function (...args) { fbq.callMethod ? fbq.callMethod(...args) : fbq.queue.push(args); };
    fbq.push = fbq; fbq.loaded = true; fbq.version = '2.0'; fbq.queue = [];
    window.fbq = fbq; window._fbq ||= fbq;
    const script = document.createElement('script'); script.async = true;
    script.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.append(script);
  }
  try { window.fbq('init', META_PIXEL_ID); } catch { /* Blocked Meta must not block Google. */ }

  const google = lazySink(), posthog = lazySink();
  tracker = createEventTracker({ version: APP_VERSION, meta: (...args) => window.fbq(...args), google: google.send, posthog: posthog.send });
  tracker.setSignedIn(signedIn);
  tracker.track(EVENTS.PAGE_VIEW, { display_mode: DISPLAY_MODE }, 'initial');
  if (escaped) {
    const attempt = { source: 'landing', step: 'auto', method: escapeAttempt.method, in_app: escapeAttempt.app };
    tracker.track(EVENTS.OPEN_IN_BROWSER, { ...attempt, outcome: escaped });
    let played = false;
    markPlayed = () => { played = true; };
    if (escaped === 'stayed') watchLateEscape(() => played, () => tracker.track(EVENTS.OPEN_IN_BROWSER, { ...attempt, outcome: 'left' }));
  }
  for (const [name, parameters, onceKey] of waiting || []) tracker.track(name, parameters, onceKey);
  waiting = null;
  // Initialize once, queue early gameplay, and tolerate browsers without Analytics support.
  import('firebase/analytics').then(async ({ isSupported, initializeAnalytics, logEvent }) => {
    if (!await isSupported()) { google.drop(); return; }
    const analytics = initializeAnalytics(app, { config: { send_page_view: false } });
    google.ready((name, payload) => logEvent(analytics, name, payload));
  }).catch(error => { google.drop(); console.warn('Google Analytics unavailable:', error.code || error.name); });
  import('posthog-js').then(({ default: client }) => {
    // A handoff from an in-app browser carries that visit's anonymous id and session, so the funnel
    // continues as one person. Only a browser PostHog has never seen adopts them.
    const carried = arrival.fromInApp ? handoffIdentity() : null;
    let known = true;
    try { known = !!localStorage.getItem(`ph_${POSTHOG_KEY}_posthog`); } catch { /* Keep this browser's own id. */ }
    // Anonymous events only: users are never identified, so no person profiles are created.
    client.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST, defaults: '2026-05-30', person_profiles: 'identified_only',
      // The map is a WebGL canvas, which DOM replay can't see. Record it at a quality high enough to keep
      // thin borders and small country labels readable (the SDK default of 0.4 smears them away).
      // Needs the map's preserveDrawingBuffer, set in main.js, or frames read back blank.
      session_recording: { captureCanvas: { recordCanvas: true, canvasFps: 4, canvasQuality: '0.8' } },
      // Uncaught errors and promise rejections become $exception events for error tracking.
      capture_exceptions: true,
      before_send: event => (event?.event === '$exception' && isNoiseException(event.properties) ? null : event),
      ...(carried && !known ? { bootstrap: { distinctID: carried.distinctID, isIdentifiedID: false, ...(carried.sessionID ? { sessionID: carried.sessionID } : {}) } } : {}),
    });
    if (internal) client.register({ is_internal: true });
    // Also on PostHog's own events ($pageview, clicks, exceptions), which do not pass through the catalogue.
    const context = { ...contextProperties(navigator.userAgent, DISPLAY_MODE), app_version: APP_VERSION };
    client.register(context);
    if (!context.in_app) client.unregister('in_app');
    posthogClient = client;
    applyPosthogUser();
    posthog.ready((name, payload) => client.capture(name, payload));
  }).catch(error => { posthog.drop(); console.warn('PostHog unavailable:', error.name); });
}

// Replaced while an automatic redirect is being watched: a hunt started here means the visitor stayed to play.
let markPlayed = () => {};

// Team devices are marked once by opening the site with ?internal=1 (?internal=0 clears it), so their
// sessions can be filtered out in PostHog with is_internal. The flag lives in this browser only.
const INTERNAL_KEY = 'treasurehunch.internal';
function internalDevice() {
  try {
    const params = new URLSearchParams(location.search);
    const value = params.get('internal');
    if (value === '1') localStorage.setItem(INTERNAL_KEY, '1');
    if (value === '0') localStorage.removeItem(INTERNAL_KEY);
    if (value !== null) {
      params.delete('internal');
      const query = params.toString();
      history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    }
    return localStorage.getItem(INTERNAL_KEY) === '1';
  } catch {
    return false;
  }
}

// Queues early gameplay events until a lazily loaded provider is ready, then flushes them.
function lazySink() {
  let sink = null, dropped = false;
  const pending = [];
  return {
    send(name, payload) {
      if (sink) sink(name, payload);
      else if (!dropped && pending.length < 100) pending.push([name, payload]);
    },
    ready(next) {
      sink = next;
      for (const [name, payload] of pending.splice(0)) {
        try { sink(name, payload); } catch { /* Continue flushing other events. */ }
      }
    },
    drop() { dropped = true; pending.length = 0; },
  };
}

export function trackEvent(name, parameters, onceKey) {
  if (name === EVENTS.HUNT_STARTED) markPlayed();
  if (waiting) {
    if (waiting.length < 50) waiting.push([name, parameters, onceKey]);
    return true;
  }
  return tracker.track(name, parameters, onceKey);
}
export const setAnalyticsSignedIn = value => { signedIn = !!value; tracker.setSignedIn(signedIn); };

// The anonymous visitor and session ids, for a handoff link to carry into the real browser.
export function analyticsIds() {
  try {
    if (!posthogClient) return {};
    return { ph_did: posthogClient.get_distinct_id(), ph_sid: posthogClient.get_session_id() };
  } catch {
    return {};
  }
}

// PostHog-only global properties tie anonymous events to the signed-in account without identify().
export const posthogUserProperties = user => ({ user_id: user?.uid || null, username: user?.username || null });
export function setAnalyticsUser(user) {
  authKnown = true;
  analyticsUser = posthogUserProperties(user);
  setAnalyticsSignedIn(!!analyticsUser.user_id);
  try { if (analyticsUser.user_id) localStorage.setItem(ACCOUNT_KEY, '1'); else localStorage.removeItem(ACCOUNT_KEY); } catch { /* The next visit starts as a guest. */ }
  applyPosthogUser();
}
function applyPosthogUser() {
  // PostHog keeps registered properties between visits. Leaving them alone until the sign-in state is known
  // means a returning explorer's first events still carry their account.
  if (!posthogClient || !authKnown) return;
  try {
    for (const [key, value] of Object.entries(analyticsUser)) {
      if (value) posthogClient.register({ [key]: value });
      else posthogClient.unregister(key);
    }
  } catch { /* Analytics must never interrupt a hunt. */ }
}
export const soloEventParameters = (state, level, mode = 'solo') => ({
  mode, role: 'seeker', level, difficulty: state.puzzle?.difficulty,
  round_seconds: state.roundSeconds ?? 120,
  time_used: Math.max(0, (state.roundSeconds ?? 120) - state.remaining), time_remaining: state.remaining,
  clues_opened: state.cluesVisible, wrong_guesses: state.wrongGuesses, revealed: state.revealedCountry,
});
