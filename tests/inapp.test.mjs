import test from 'node:test';
import assert from 'node:assert/strict';
import { inAppBrowser, platform, handoffUrl, chromeIntentUrl, googleErrorReason } from '../src/inapp.js';

// Real user-agent strings, as sent by each app's in-app browser.
const UA = {
  instagramAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 Instagram 352.0.0.38.100 Android (34/14; 480dpi; 1080x2340; samsung; SM-S918B; dm3q; qcom; en_IN; 650783372)',
  instagramIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 352.0.0.21.106 (iPhone15,2; iOS 17_6_1; en_IN; en; scale=3.00; 1179x2556; 648542340)',
  facebookAndroid: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/481.0.0.48.109;]',
  facebookIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/478.0.0.39.108;FBBV/645370522;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5;FBRV/648123007]',
  messengerAndroid: 'Mozilla/5.0 (Linux; Android 12; SM-A525F Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/468.0.0.43.109;]',
  messengerIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/456.0.0.38.109;FBBV/598172341;FBDV/iPhone13,2;FBMD/iPhone;FBSN/iOS;FBSV/17.4;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/5]',
  whatsappAndroid: 'Mozilla/5.0 (Linux; Android 14; 2201116PI Build/UKQ1.230804.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36 WhatsApp/2.24.22.79 A',
  lineIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.1.0',
  androidWebView: 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  samsungInternet: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1',
  chromeDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  safariDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
};

test('in-app browsers are recognised by their app markers', () => {
  assert.equal(inAppBrowser(UA.instagramAndroid), 'instagram');
  assert.equal(inAppBrowser(UA.instagramIos), 'instagram');
  assert.equal(inAppBrowser(UA.facebookAndroid), 'facebook');
  assert.equal(inAppBrowser(UA.facebookIos), 'facebook');
  assert.equal(inAppBrowser(UA.messengerAndroid), 'messenger');
  assert.equal(inAppBrowser(UA.messengerIos), 'messenger');
  assert.equal(inAppBrowser(UA.whatsappAndroid), 'whatsapp');
  assert.equal(inAppBrowser(UA.lineIos), 'line');
  assert.equal(inAppBrowser(UA.androidWebView), 'other_webview');
});

test('real browsers are never flagged', () => {
  for (const name of ['chromeAndroid', 'samsungInternet', 'safariIos', 'chromeIos', 'chromeDesktop', 'safariDesktop'])
    assert.equal(inAppBrowser(UA[name]), '', name);
  for (const empty of ['', undefined, null]) assert.equal(inAppBrowser(empty), '');
});

test('platform splits Android, iOS and everything else', () => {
  for (const name of ['instagramAndroid', 'facebookAndroid', 'whatsappAndroid', 'chromeAndroid']) assert.equal(platform(UA[name]), 'android', name);
  for (const name of ['instagramIos', 'facebookIos', 'messengerIos', 'safariIos', 'chromeIos']) assert.equal(platform(UA[name]), 'ios', name);
  for (const name of ['chromeDesktop', 'safariDesktop']) assert.equal(platform(UA[name]), 'other', name);
  assert.equal(platform(''), 'other');
});

test('the handoff URL keeps the query and asks for Google sign-in', () => {
  const url = new URL(handoffUrl('https://hunch.rohittp.com/?utm_source=ig&utm_campaign=daily&hunt=ABC#leaderboard'));
  assert.equal(url.origin + url.pathname, 'https://hunch.rohittp.com/');
  assert.equal(url.searchParams.get('utm_source'), 'ig');
  assert.equal(url.searchParams.get('utm_campaign'), 'daily');
  assert.equal(url.searchParams.get('hunt'), 'ABC');
  assert.equal(url.searchParams.get('from'), 'inapp');
  assert.equal(url.searchParams.get('signin'), 'google');
  assert.equal(url.hash, '');
  // Tapping twice never stacks duplicate parameters.
  assert.equal(handoffUrl(url.href), url.href);
});

test('the Chrome intent opens the same page with the query and a browser fallback', () => {
  const intent = chromeIntentUrl('https://hunch.rohittp.com/?utm_source=fb&utm_medium=paid&fbclid=Iw%20AR#leaderboard');
  const query = '?utm_source=fb&utm_medium=paid&fbclid=Iw+AR&from=inapp&signin=google';
  assert.equal(intent, `intent://hunch.rohittp.com/${query}#Intent;scheme=https;package=com.android.chrome;`
    + `S.browser_fallback_url=${encodeURIComponent(`https://hunch.rohittp.com/${query}`)};end`);
  // The fallback is fully encoded, so its own ; and # can't end the intent early.
  const fallback = intent.match(/S\.browser_fallback_url=([^;]*);end$/)[1];
  assert.doesNotMatch(fallback, /[;#&?]/);
  assert.equal(decodeURIComponent(fallback), `https://hunch.rohittp.com/${query}`);
  assert.equal(chromeIntentUrl('https://hunch.rohittp.com/'), 'intent://hunch.rohittp.com/?from=inapp&signin=google#Intent;scheme=https;package=com.android.chrome;'
    + 'S.browser_fallback_url=https%3A%2F%2Fhunch.rohittp.com%2F%3Ffrom%3Dinapp%26signin%3Dgoogle;end');
});

test('Google failures map to a small fixed set of reasons', () => {
  assert.equal(googleErrorReason({ code: 'auth/popup-closed-by-user' }), 'popup_closed');
  assert.equal(googleErrorReason({ code: 'auth/popup-blocked' }), 'popup_blocked');
  assert.equal(googleErrorReason({ code: 'auth/cancelled-popup-request' }), 'cancelled');
  assert.equal(googleErrorReason({ code: 'auth/user-cancelled' }), 'cancelled');
  assert.equal(googleErrorReason({ code: 'auth/network-request-failed' }), 'network');
  assert.equal(googleErrorReason({ code: 'auth/firebase-app-check-token-is-invalid' }), 'app_check');
  assert.equal(googleErrorReason({ code: 'auth/operation-not-supported-in-this-environment' }), 'unsupported');
  assert.equal(googleErrorReason({ code: 'auth/missing-initial-state' }), 'unsupported');
  assert.equal(googleErrorReason({ code: 'auth/internal-error', message: 'secret details' }), 'other');
  assert.equal(googleErrorReason(new Error('boom')), 'other');
  assert.equal(googleErrorReason(undefined), 'other');
});
