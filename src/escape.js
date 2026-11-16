// Leaving in-app browsers. Instagram, Facebook and WhatsApp open links in their own browser, whose storage
// is cut off from Chrome and Safari: an explorer who signs up there is a guest again everywhere else, and
// nothing can be installed from it. So the first visit in such a browser is sent on to the real one.
//
// This file has no imports and only top-level `export function` / `export const` declarations, because
// vite.config.js also inlines it into index.html (with the exports stripped) so the redirect runs before
// the app's bundle is even requested. Everything except escapeNow() is pure and takes its inputs as arguments.

export const ESCAPE_KEY = 'treasurehunch.escape';
// Campaign tags and ad click ids that must survive every handoff and every address-bar clean-up.
export const ATTRIBUTION_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'msclkid', 'ttclid'];
// Added by a handoff and removed again once the page has read them.
export const HANDOFF_PARAMS = ['from', 'iab', 'signin', 'install', 'ph_did', 'ph_sid'];
const ESCAPE_APPS = ['instagram', 'facebook', 'messenger'];
const RETRY_AFTER_MS = 7 * 86400000;

// The app whose in-app browser this is, or '' for a real browser. Conservative: only known markers count,
// so Chrome, Safari and the other real browsers are never flagged.
export function inAppBrowser(ua) {
  const agent = String(ua || '');
  if (/\bInstagram\b/.test(agent)) return 'instagram';
  // Messenger carries the Facebook markers too (FBAN/MessengerForiOS, FB_IAB/Orca-Android), so it goes first.
  if (/\bMessenger\b|FBAN\/Messenger|FB_IAB\/Orca/.test(agent)) return 'messenger';
  if (/FBAN\/|FBAV\/|FB_IAB\/|FBIOS/.test(agent)) return 'facebook';
  if (/\bWhatsApp\b/i.test(agent)) return 'whatsapp';
  if (/\bLine\//.test(agent)) return 'line';
  // Android System WebView marks itself with "; wv)". iOS web views are left alone: home-screen apps look the same.
  if (/Android/.test(agent) && /; wv\)/.test(agent)) return 'other_webview';
  return '';
}

export function platform(ua) {
  const agent = String(ua || '');
  if (/Android/i.test(agent)) return 'android';
  if (/iPhone|iPad|iPod/.test(agent)) return 'ios';
  return 'other';
}

// The iOS major version, or 0 when the user agent does not say.
export function iosMajor(ua) {
  const match = /OS (\d+)[._]\d+/.exec(String(ua || ''));
  return match && platform(ua) === 'ios' ? Number(match[1]) : 0;
}

// Safari itself, or the Safari view other iOS apps (WhatsApp) open links in. The two cannot be told apart.
export function looksLikeSafari(ua) {
  const agent = String(ua || '');
  return platform(agent) === 'ios' && /Version\/\d/.test(agent) && /Safari\//.test(agent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(agent);
}

// The WhatsApp alert's two buttons: "Play today's quest" (?daily=1, no utm_source) and "Stop these alerts".
export function isAlertLink(search) {
  const params = new URLSearchParams(search || '');
  return (params.has('daily') && !params.get('utm_source')) || params.get('whatsapp') === 'stop';
}

// The campaign tags and click ids present on a URL, as a plain object.
export function attributionParams(search) {
  const params = new URLSearchParams(search || '');
  const found = {};
  for (const key of ATTRIBUTION_PARAMS) {
    const value = params.get(key);
    if (value && value.length <= 500) found[key] = value;
  }
  return found;
}

// The page to open in the real browser: the same address without its fragment, marked as a handoff.
// `carry` restores attribution the address bar has lost since landing; it never overwrites what is there.
// `app` is the in-app browser being left; `extra` adds the reason (signin=google, install=1) and analytics ids.
export function handoffUrl(href, app, carry, extra) {
  const url = new URL(href);
  for (const key of HANDOFF_PARAMS) url.searchParams.delete(key);
  const restored = carry || {};
  for (const key of ATTRIBUTION_PARAMS) {
    if (restored[key] && !url.searchParams.has(key)) url.searchParams.set(key, restored[key]);
  }
  url.searchParams.set('from', 'inapp');
  if (app) url.searchParams.set('iab', app);
  const added = extra || {};
  for (const key of Object.keys(added)) {
    if (added[key]) url.searchParams.set(key, added[key]);
  }
  url.hash = '';
  return url.href;
}

// An Android intent link that opens a handoff URL in Chrome. If Chrome is missing, Android opens the fallback URL.
export function chromeIntentUrl(handoff) {
  const url = new URL(handoff);
  const scheme = url.protocol.replace(/:$/, '');
  return 'intent://' + url.host + url.pathname + url.search + '#Intent;scheme=' + scheme + ';package=com.android.chrome;'
    + 'S.browser_fallback_url=' + encodeURIComponent(url.href) + ';end';
}

// Instagram's own "open in external browser" link. On iOS it is the only handoff Instagram still honours.
export function instagramExternalUrl(handoff) {
  return 'instagram://extbrowser/?url=' + encodeURIComponent(handoff);
}

// Opens an https page in Safari from another iOS app's browser (iOS 17 and later).
export function safariUrl(handoff) {
  const url = new URL(handoff);
  return 'x-safari-https://' + url.host + url.pathname + url.search;
}

// What a tap on "Open in browser" should do here: { method, url }. `copy` means no link can do it,
// so the page copies the address and explains the app's own menu instead.
export function manualHandoff(ua, handoff) {
  const app = inAppBrowser(ua);
  const os = platform(ua);
  if (os === 'android') return { method: 'intent', url: chromeIntentUrl(handoff) };
  if (os === 'ios' && app === 'instagram') return { method: 'extbrowser', url: instagramExternalUrl(handoff) };
  if (os === 'ios' && iosMajor(ua) >= 17) return { method: 'safari', url: safariUrl(handoff) };
  return { method: 'copy', url: handoff };
}

// Whether to send this page load on to the real browser by itself, and how: { app, method, url } or null.
// Only a first visit goes: anyone with progress stored here stays, so nothing they have is left behind.
// `record` is what earlier attempts left in storage: { failed, at }.
export function escapePlan(env) {
  const ua = env.ua;
  const url = new URL(env.href);
  const params = url.searchParams;
  if (url.protocol !== 'https:' || env.standalone || env.hasProgress) return null;
  // Already handed off once, or the link asks to stay (?stay=1, for comparing the two in an ad test).
  if (params.has('from') || params.get('stay') === '1') return null;
  const record = env.record || {};
  if (record.failed >= 2 && (env.now || Date.now()) - (record.at || 0) < RETRY_AFTER_MS) return null;
  const app = inAppBrowser(ua);
  const os = platform(ua);
  if (os === 'android' && ESCAPE_APPS.indexOf(app) >= 0)
    return { app: app, method: 'intent', url: chromeIntentUrl(handoffUrl(env.href, app)) };
  if (os === 'ios' && app === 'instagram')
    return { app: app, method: 'extbrowser', url: instagramExternalUrl(handoffUrl(env.href, app)) };
  // The alert link on iOS opens in WhatsApp's Safari view, which looks exactly like Safari.
  if (os === 'ios' && !app && looksLikeSafari(ua) && iosMajor(ua) >= 17 && isAlertLink(url.search))
    return { app: 'whatsapp', method: 'safari', url: safariUrl(handoffUrl(env.href, 'whatsapp')) };
  return null;
}

// Progress worth keeping lives under "treasurehunch:" keys; "treasurehunch." keys are flags and preferences.
export function hasStoredProgress(storage) {
  try {
    for (let index = 0; index < storage.length; index += 1) {
      if (String(storage.key(index)).indexOf('treasurehunch:') === 0) return true;
    }
  } catch (error) { /* Storage is blocked: nothing can be kept here anyway. */ }
  return false;
}

export function readEscapeRecord(storage) {
  try {
    const record = JSON.parse(storage.getItem(ESCAPE_KEY) || 'null');
    return record && typeof record === 'object' ? record : {};
  } catch (error) {
    return {};
  }
}

export function writeEscapeRecord(storage, record) {
  try { storage.setItem(ESCAPE_KEY, JSON.stringify(record)); } catch (error) { /* The attempt still runs once. */ }
}

// Runs while index.html is still being parsed. Leaves `window.__treasureEscape` for the app to report on.
export function escapeNow(win) {
  try {
    const storage = win.localStorage;
    const record = readEscapeRecord(storage);
    const plan = escapePlan({
      ua: win.navigator.userAgent,
      href: win.location.href,
      standalone: win.navigator.standalone === true || (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches),
      hasProgress: hasStoredProgress(storage),
      record: record,
      now: Date.now(),
    });
    if (!plan) return null;
    // Counted as failed until the page is seen to go into the background (src/handoff.js clears it then).
    writeEscapeRecord(storage, { failed: (record.failed || 0) + 1, at: Date.now() });
    win.__treasureEscape = { app: plan.app, method: plan.method, at: Date.now() };
    // A browser that cannot follow the link may stop reading this page altogether, leaving it blank: the
    // document then reports itself complete although the game never started (src/handoff.js sets
    // __treasureBooted, and a healthy page only completes after that). Reload it marked as already
    // handed off, which loads it normally and is counted as a redirect that did not get out.
    const recover = function () {
      if (win.__treasureBooted || win.document.readyState !== 'complete') return;
      if (win.document.visibilityState === 'hidden') {
        win.document.addEventListener('visibilitychange', recover, { once: true });
        return;
      }
      // A moment later, so the refused navigation has finished being cancelled.
      win.setTimeout(function () { win.location.replace(handoffUrl(win.location.href, plan.app)); }, 50);
    };
    if (win.document.addEventListener) win.document.addEventListener('readystatechange', recover);
    if (plan.method === 'extbrowser') {
      // Instagram on iOS drops a scripted redirect but follows one written into the page as it loads.
      win.document.write('<meta http-equiv="refresh" content="0;url=' + plan.url.replace(/"/g, '%22') + '">');
    } else {
      win.location.href = plan.url;
    }
    return plan;
  } catch (error) {
    return null;
  }
}
