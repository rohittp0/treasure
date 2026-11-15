import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { escapePlan, escapeNow, handoffUrl, attributionParams, manualHandoff, isAlertLink, iosMajor, looksLikeSafari,
  hasStoredProgress, ESCAPE_KEY } from '../src/escape.js';
import { handoffIdentity } from '../src/handoff.js';
import { inlineEscapeScript } from '../vite.config.js';

const UA = {
  instagramAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 Instagram 352.0.0.38.100 Android (34/14; 480dpi; 1080x2340; samsung; SM-S918B; dm3q; qcom; en_IN; 650783372)',
  instagramIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 352.0.0.21.106 (iPhone15,2; iOS 17_6_1; en_IN; en; scale=3.00; 1179x2556; 648542340)',
  facebookAndroid: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/481.0.0.48.109;]',
  facebookIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/478.0.0.39.108;FBBV/645370522;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5;FBRV/648123007]',
  androidWebView: 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  safariIos16: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1',
  chromeDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};
const AD = 'https://hunch.rohittp.com/?utm_source=ig&utm_medium=paid&utm_campaign=launch&fbclid=IwAR123';
const plan = (ua, href = AD, extra = {}) => escapePlan({ ua, href, ...extra });

test('a first visit in Instagram or Facebook on Android is sent to Chrome with its campaign tags', () => {
  const instagram = plan(UA.instagramAndroid);
  assert.deepEqual([instagram.app, instagram.method], ['instagram', 'intent']);
  assert.match(instagram.url, /^intent:\/\/hunch\.rohittp\.com\/\?utm_source=ig&utm_medium=paid&utm_campaign=launch&fbclid=IwAR123&from=inapp&iab=instagram#Intent;scheme=https;package=com\.android\.chrome;/);
  assert.equal(plan(UA.facebookAndroid).app, 'facebook');
});

test('Instagram on iOS uses its own external-browser link; the alert link on iOS 17 goes to Safari', () => {
  const instagram = plan(UA.instagramIos);
  assert.deepEqual([instagram.app, instagram.method], ['instagram', 'extbrowser']);
  assert.equal(instagram.url, `instagram://extbrowser/?url=${encodeURIComponent(`${AD}&from=inapp&iab=instagram`)}`);
  const alert = plan(UA.safariIos, 'https://hunch.rohittp.com/?daily=1');
  assert.deepEqual(alert, { app: 'whatsapp', method: 'safari', url: 'x-safari-https://hunch.rohittp.com/?daily=1&from=inapp&iab=whatsapp' });
  assert.equal(plan(UA.safariIos, 'https://hunch.rohittp.com/?whatsapp=stop').method, 'safari');
});

test('nothing is redirected where it could break, loop or lose progress', () => {
  // Real browsers, and web views of unknown apps, which may not understand an intent link.
  for (const name of ['chromeAndroid', 'chromeDesktop', 'chromeIos', 'androidWebView']) assert.equal(plan(UA[name]), null, name);
  // Safari itself on an ordinary link, the push link (it carries utm_source) and older iOS.
  assert.equal(plan(UA.safariIos), null);
  assert.equal(plan(UA.safariIos, 'https://hunch.rohittp.com/?daily=1&utm_source=push'), null);
  assert.equal(plan(UA.safariIos16, 'https://hunch.rohittp.com/?daily=1'), null);
  assert.equal(plan(UA.chromeIos, 'https://hunch.rohittp.com/?daily=1'), null);
  // Facebook on iOS has no link that works without a tap.
  assert.equal(plan(UA.facebookIos), null);
  // Already handed off (or the fallback loaded here again), asked to stay, installed, or with progress here.
  assert.equal(plan(UA.instagramAndroid, `${AD}&from=inapp&iab=instagram`), null);
  assert.equal(plan(UA.instagramAndroid, `${AD}&stay=1`), null);
  assert.equal(plan(UA.instagramAndroid, AD, { standalone: true }), null);
  assert.equal(plan(UA.instagramAndroid, AD, { hasProgress: true }), null);
  // Local development and previews without https.
  assert.equal(plan(UA.instagramAndroid, 'http://127.0.0.1:5173/?utm_source=ig'), null);
  // Two failed attempts pause the redirect for a week.
  const now = Date.parse('2026-11-15T00:00:00Z');
  assert.equal(plan(UA.instagramAndroid, AD, { record: { failed: 2, at: now - 3600000 }, now }), null);
  assert.equal(plan(UA.instagramAndroid, AD, { record: { failed: 1, at: now - 3600000 }, now }).method, 'intent');
  assert.equal(plan(UA.instagramAndroid, AD, { record: { failed: 2, at: now - 8 * 86400000 }, now }).method, 'intent');
});

test('a handoff restores attribution the address bar lost, without overwriting what is there', () => {
  const landing = attributionParams('?utm_source=ig&utm_medium=paid&fbclid=IwAR123&daily=1&email=a@b.c');
  assert.deepEqual(landing, { utm_source: 'ig', utm_medium: 'paid', fbclid: 'IwAR123' });
  const restored = new URL(handoffUrl('https://hunch.rohittp.com/?atlas=maya#leaderboard', 'instagram', landing, { install: '1', ph_did: 'abc', ph_sid: '' }));
  assert.equal(restored.search, '?atlas=maya&utm_source=ig&utm_medium=paid&fbclid=IwAR123&from=inapp&iab=instagram&install=1&ph_did=abc');
  const kept = new URL(handoffUrl('https://hunch.rohittp.com/?utm_source=push', 'instagram', landing));
  assert.equal(kept.searchParams.get('utm_source'), 'push');
  // Stale handoff parameters from an earlier hop are replaced, never stacked.
  const again = new URL(handoffUrl('https://hunch.rohittp.com/?from=inapp&iab=facebook&signin=google&ph_did=old', 'instagram', {}, { install: '1' }));
  assert.equal(again.search, '?from=inapp&iab=instagram&install=1');
});

test('a tapped link out picks the method each app honours', () => {
  const handoff = handoffUrl(AD, 'instagram', {}, { signin: 'google' });
  assert.equal(manualHandoff(UA.instagramAndroid, handoff).method, 'intent');
  assert.deepEqual(manualHandoff(UA.instagramIos, handoff), { method: 'extbrowser', url: `instagram://extbrowser/?url=${encodeURIComponent(handoff)}` });
  assert.equal(manualHandoff(UA.facebookIos, handoff).url, handoff.replace('https://', 'x-safari-https://'));
  assert.deepEqual(manualHandoff(UA.safariIos16, handoff), { method: 'copy', url: handoff });
});

test('small detectors', () => {
  assert.equal(isAlertLink('?daily=1'), true);
  assert.equal(isAlertLink('?daily=1&utm_source=push'), false);
  assert.equal(isAlertLink('?whatsapp=stop'), true);
  assert.equal(isAlertLink('?utm_source=ig'), false);
  assert.equal(iosMajor(UA.safariIos), 17);
  assert.equal(iosMajor(UA.chromeAndroid), 0);
  assert.equal(looksLikeSafari(UA.safariIos), true);
  assert.equal(looksLikeSafari(UA.chromeIos), false);
  assert.equal(looksLikeSafari(UA.instagramIos), false);
  const storage = keys => ({ length: keys.length, key: index => keys[index] });
  assert.equal(hasStoredProgress(storage(['treasurehunch:solo-wins'])), true);
  assert.equal(hasStoredProgress(storage(['treasurehunch.escape', 'treasurehunch.internal', 'ph_x_posthog'])), false);
  assert.equal(hasStoredProgress({ get length() { throw new Error('blocked'); } }), false);
});

test('a handoff carries the analytics visitor only when the ids look real', () => {
  const id = '0193a5b2-7c1e-7d3a-9f00-1a2b3c4d5e6f';
  assert.deepEqual(handoffIdentity(`?ph_did=${id}&ph_sid=${id}`), { distinctID: id, sessionID: id });
  assert.deepEqual(handoffIdentity(`?ph_did=${id}&ph_sid=nope`), { distinctID: id });
  assert.equal(handoffIdentity('?ph_did=<script>'), null);
  assert.equal(handoffIdentity(''), null);
});

function fakeWindow(ua, href, stored = {}) {
  const store = { ...stored };
  const win = {
    URL, URLSearchParams,
    navigator: { userAgent: ua },
    location: { href },
    localStorage: { get length() { return Object.keys(store).length; }, key: index => Object.keys(store)[index], getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = value; } },
    matchMedia: () => ({ matches: false }),
    document: { written: '', write(html) { this.written += html; } },
  };
  win.window = win;
  return { win, store };
}

test('escapeNow redirects, records the attempt and tells the app what it tried', () => {
  const android = fakeWindow(UA.instagramAndroid, AD);
  assert.equal(escapeNow(android.win).method, 'intent');
  assert.match(android.win.location.href, /^intent:\/\//);
  assert.deepEqual([android.win.__treasureEscape.app, android.win.__treasureEscape.method], ['instagram', 'intent']);
  assert.equal(JSON.parse(android.store[ESCAPE_KEY]).failed, 1);

  const ios = fakeWindow(UA.instagramIos, AD);
  escapeNow(ios.win);
  assert.equal(ios.win.location.href, AD, 'Instagram on iOS is left by a written redirect, not a scripted one');
  assert.match(ios.win.document.written, /^<meta http-equiv="refresh" content="0;url=instagram:\/\/extbrowser\/\?url=https%3A%2F%2Fhunch/);
  assert.doesNotMatch(ios.win.document.written.slice(40, -2), /[";]/);

  const returning = fakeWindow(UA.instagramAndroid, AD, { 'treasurehunch:solo-wins': '4' });
  assert.equal(escapeNow(returning.win), null);
  assert.equal(returning.win.location.href, AD);
  assert.equal(returning.win.__treasureEscape, undefined);

  // A browser that blocks storage or lacks an API must load the game as usual.
  assert.equal(escapeNow({ navigator: {}, location: {} }), null);
});

test('the script inlined into index.html is the same code and runs by itself', () => {
  const script = inlineEscapeScript(readFileSync(new URL('../src/escape.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(script, /^export /m);
  assert.doesNotMatch(script, /<\/script/i);
  const { win } = fakeWindow(UA.facebookAndroid, AD);
  vm.runInNewContext(script, win);
  assert.match(win.location.href, /^intent:\/\/hunch\.rohittp\.com\/.*iab=facebook/);
  const chrome = fakeWindow(UA.chromeAndroid, AD);
  vm.runInNewContext(script, chrome.win);
  assert.equal(chrome.win.location.href, AD);
});
