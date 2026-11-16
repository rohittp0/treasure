// Browser-side glue for moving a visit from an in-app browser to the real one without losing where it came
// from. The decisions themselves are pure functions in escape.js; this file touches the page.
import { ATTRIBUTION_PARAMS, HANDOFF_PARAMS, ESCAPE_KEY, attributionParams, handoffUrl, inAppBrowser, manualHandoff, readEscapeRecord, writeEscapeRecord } from './escape.js';

const inBrowser = typeof window !== 'undefined';
// Tells index.html's redirect script that the game's code arrived and is running (see escapeNow).
if (inBrowser) window.__treasureBooted = true;
const LANDING_KEY = 'treasurehunch.landing';
// How long a page waits to see whether the automatic redirect took the visitor away.
const ESCAPE_SETTLE_MS = 1500;
// After that, leaving this soon without playing still counts as the redirect working (Instagram asks first).
const ESCAPE_LATE_MS = 30000;

// Read once at load, before anything tidies the address bar.
const initialSearch = inBrowser ? location.search : '';
const initialParams = new URLSearchParams(initialSearch);

// Campaign tags and click ids this tab arrived with. Kept for the tab's lifetime so a later handoff can
// restore them even if the address has changed since.
function readLanding() {
  const fresh = attributionParams(initialSearch);
  if (!inBrowser) return fresh;
  try {
    if (Object.keys(fresh).length) sessionStorage.setItem(LANDING_KEY, JSON.stringify(fresh));
    else return JSON.parse(sessionStorage.getItem(LANDING_KEY) || '{}') || {};
  } catch { /* Without storage the address bar is the only copy. */ }
  return fresh;
}
export const landingAttribution = readLanding();

// What a handoff link told this page: where it came from and why. All null on an ordinary visit.
export const arrival = Object.freeze({
  fromInApp: initialParams.get('from') === 'inapp',
  inApp: /^[a-z_]{1,20}$/.test(initialParams.get('iab') || '') ? initialParams.get('iab') : '',
  signIn: initialParams.get('signin') === 'google',
  install: initialParams.get('install') === '1',
});

// The analytics visitor and session a handoff carried over, if both look like PostHog ids.
export function handoffIdentity(search = initialSearch) {
  const params = new URLSearchParams(search);
  const valid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
  const distinctID = params.get('ph_did');
  if (!valid(distinctID)) return null;
  const sessionID = params.get('ph_sid');
  return { distinctID, ...(valid(sessionID) ? { sessionID } : {}) };
}

// Removes only the named query parameters, keeping campaign tags and everything else in place.
export function removeUrlParams(names) {
  if (!inBrowser) return;
  const params = new URLSearchParams(location.search);
  let changed = false;
  for (const name of names) { if (params.has(name)) { params.delete(name); changed = true; } }
  if (!changed) return;
  const query = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

// Sets (or, with an empty value, removes) one query parameter and leaves the rest alone.
export function setUrlParam(name, value) {
  if (!inBrowser) return;
  const params = new URLSearchParams(location.search);
  if (value) params.set(name, value); else params.delete(name);
  const query = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

export const clearHandoffParams = () => removeUrlParams(HANDOFF_PARAMS);

// The link (and how to follow it) for a tapped "Open in browser". `reason` is { signin: 'google' } or
// { install: '1' }; `ids` are the analytics visitor and session so the visit continues as the same person.
// Returns { app, method, url, address }: `url` is what to navigate to, `address` the plain https page to copy.
export function outboundHandoff(reason = {}, ids = {}) {
  const app = inAppBrowser(navigator.userAgent);
  const address = handoffUrl(location.href, app, landingAttribution, { ...reason, ...ids });
  return { app, address, ...manualHandoff(navigator.userAgent, address) };
}

// ---- The automatic redirect that index.html attempted before this bundle loaded (see escape.js).
const attempt = inBrowser ? window.__treasureEscape || null : null;
export const escapeAttempt = attempt ? { app: attempt.app, method: attempt.method } : null;

function clearEscapeFailure() {
  try {
    const record = readEscapeRecord(localStorage);
    if (record.failed) writeEscapeRecord(localStorage, { ...record, failed: Math.max(0, record.failed - 1) });
  } catch { /* The next visit simply tries again. */ }
}

// Resolves once it is clear what happened to the automatic redirect:
//   null       there was no attempt
//   'stayed'   the page is still in front after the wait, so the visitor is playing here
//   'returned' the page went to the background (the redirect worked) and the visitor later came back to it
// Analytics waits for this, so a page left behind by a working redirect is never counted as a second visitor.
export function escapeOutcome() {
  if (!attempt) return Promise.resolve(null);
  return new Promise(resolve => {
    let left = document.visibilityState === 'hidden';
    if (left) clearEscapeFailure();
    const timer = setTimeout(() => { if (!left) finish('stayed'); }, Math.max(0, ESCAPE_SETTLE_MS - (Date.now() - attempt.at)));
    function onChange() {
      if (document.visibilityState === 'hidden') {
        if (!left) clearEscapeFailure();
        left = true;
      } else if (left) finish('returned');
    }
    function finish(outcome) {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onChange);
      resolve(outcome);
    }
    document.addEventListener('visibilitychange', onChange);
  });
}

// Instagram on iOS asks before leaving, so a visitor can go a few seconds after 'stayed' was recorded.
// Calls back once if this page is hidden soon after loading and no hunt has started here.
export function watchLateEscape(hasPlayed, onLeft) {
  if (!attempt) return;
  const onChange = () => {
    if (document.visibilityState !== 'hidden') return;
    document.removeEventListener('visibilitychange', onChange);
    if (Date.now() - attempt.at > ESCAPE_LATE_MS || hasPlayed()) return;
    clearEscapeFailure();
    onLeft();
  };
  document.addEventListener('visibilitychange', onChange);
  setTimeout(() => document.removeEventListener('visibilitychange', onChange), ESCAPE_LATE_MS);
}

export { ATTRIBUTION_PARAMS, ESCAPE_KEY };
