// The event catalogue, payload policy and every analytics provider live here.
export const META_PIXEL_ID = '1540952161129164';
export const POSTHOG_KEY = 'phc_mMjEnzpqWruQeWnybSbFzbFZkDRG5Ct5HcesQzZJEUPa';
export const POSTHOG_HOST = 'https://us.i.posthog.com';
export const EVENTS = Object.freeze({
  PAGE_VIEW: 'page_view', LOGIN: 'login', SIGN_UP: 'sign_up', LOGOUT: 'logout',
  HUNT_STARTED: 'hunt_started', HUNT_COMPLETED: 'hunt_completed', HUNT_ABANDONED: 'hunt_abandoned',
  COUNTRY_SELECTED: 'country_selected', SELECTION_CANCELLED: 'selection_cancelled',
  CLUE_OPENED: 'clue_opened', COUNTRY_REVEALED: 'country_revealed', GUESS_SUBMITTED: 'guess_submitted',
  MULTIPLAYER_OPENED: 'multiplayer_opened', CHALLENGE_SETUP: 'challenge_setup_opened',
  CHALLENGE_CREATED: 'challenge_created', CHALLENGE_ACCEPTED: 'challenge_accepted',
  INVITE_SHARED: 'invite_shared', RESULT_VIEWED: 'result_viewed', REMATCH_STARTED: 'rematch_started',
  POSTER_EXPORTED: 'poster_exported', LOGS_OPENED: 'logs_opened', HISTORY_OPENED: 'history_result_opened',
  LEADERBOARD_VIEWED: 'leaderboard_viewed', NOTIFICATIONS_PERMISSION: 'notifications_permission',
});
const eventNames = new Set(Object.values(EVENTS));
const allowedParameters = new Set(['mode', 'role', 'level', 'difficulty', 'round_seconds', 'time_used',
  'time_remaining', 'clues_opened', 'wrong_guesses', 'outcome', 'winner_role', 'personal_win', 'source',
  'method', 'targeted', 'revealed', 'clue_number', 'cost_seconds', 'permission', 'account_status']);
const metaStandardEvents = { page_view: 'PageView', sign_up: 'CompleteRegistration' };

export function cleanEventParameters(parameters = {}) {
  return Object.fromEntries(Object.entries(parameters).filter(([key, value]) =>
    allowedParameters.has(key) && (typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 80))));
}

// Injected sinks keep tracking testable and prevent a failed provider from affecting gameplay.
export function createEventTracker({ enabled = true, meta = () => {}, google = () => {}, posthog = () => {} } = {}) {
  const seen = new Set();
  let accountStatus = 'guest';
  return {
    setSignedIn(signedIn) { accountStatus = signedIn ? 'signed_in' : 'guest'; },
    track(name, parameters = {}, onceKey = '') {
      if (!enabled || !eventNames.has(name) || (onceKey && seen.has(`${name}:${onceKey}`))) return false;
      if (onceKey) seen.add(`${name}:${onceKey}`);
      const payload = cleanEventParameters({ ...parameters, account_status: accountStatus });
      try { google(name, payload); } catch { /* Analytics must never interrupt a hunt. */ }
      try { meta(metaStandardEvents[name] ? 'track' : 'trackCustom', metaStandardEvents[name] || name, payload); } catch { /* The other providers still receive their event. */ }
      try { posthog(name, payload); } catch { /* The other providers still receive their event. */ }
      return true;
    },
  };
}

let tracker = createEventTracker({ enabled: false });
let initialized = false;
let signedIn = false;
let posthogClient = null;
let analyticsUser = { user_id: null, username: null };

export function initializeTracking(app, { enabled = !import.meta.env?.DEV } = {}) {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  if (!enabled) return;

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
  tracker = createEventTracker({ meta: (...args) => window.fbq(...args), google: google.send, posthog: posthog.send });
  tracker.setSignedIn(signedIn);
  tracker.track(EVENTS.PAGE_VIEW, {}, 'initial');
  // Initialize once, queue early gameplay, and tolerate browsers without Analytics support.
  import('firebase/analytics').then(async ({ isSupported, initializeAnalytics, logEvent }) => {
    if (!await isSupported()) { google.drop(); return; }
    const analytics = initializeAnalytics(app, { config: { send_page_view: false } });
    google.ready((name, payload) => logEvent(analytics, name, payload));
  }).catch(error => { google.drop(); console.warn('Google Analytics unavailable:', error.code || error.name); });
  import('posthog-js').then(({ default: client }) => {
    // Anonymous events only: users are never identified, so no person profiles are created.
    client.init(POSTHOG_KEY, { api_host: POSTHOG_HOST, defaults: '2026-05-30', person_profiles: 'identified_only' });
    posthogClient = client;
    applyPosthogUser();
    posthog.ready((name, payload) => client.capture(name, payload));
  }).catch(error => { posthog.drop(); console.warn('PostHog unavailable:', error.name); });
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

export const trackEvent = (name, parameters, onceKey) => tracker.track(name, parameters, onceKey);
export const setAnalyticsSignedIn = value => { signedIn = !!value; tracker.setSignedIn(signedIn); };

// PostHog-only global properties tie anonymous events to the signed-in account without identify().
export const posthogUserProperties = user => ({ user_id: user?.uid || null, username: user?.username || null });
export function setAnalyticsUser(user) {
  analyticsUser = posthogUserProperties(user);
  setAnalyticsSignedIn(!!analyticsUser.user_id);
  applyPosthogUser();
}
function applyPosthogUser() {
  if (!posthogClient) return;
  try {
    for (const [key, value] of Object.entries(analyticsUser)) {
      if (value) posthogClient.register({ [key]: value });
      else posthogClient.unregister(key);
    }
  } catch { /* Analytics must never interrupt a hunt. */ }
}
export const soloEventParameters = (state, level) => ({
  mode: 'solo', role: 'seeker', level, difficulty: state.puzzle?.difficulty,
  round_seconds: state.roundSeconds ?? 120,
  time_used: Math.max(0, (state.roundSeconds ?? 120) - state.remaining), time_remaining: state.remaining,
  clues_opened: state.cluesVisible, wrong_guesses: state.wrongGuesses, revealed: state.revealedCountry,
});
