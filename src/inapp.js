// In-app browsers (Instagram, Facebook, WhatsApp…) can't finish Google's popup or redirect sign-in.
// Pure helpers: each takes the user-agent string or URL, so they test without a browser.

// The app whose in-app browser this is, or '' for a real browser. Conservative: only known markers count,
// so Chrome, Safari and the other real browsers are never flagged.
export function inAppBrowser(ua = '') {
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

export function platform(ua = '') {
  const agent = String(ua || '');
  if (/Android/i.test(agent)) return 'android';
  if (/iPhone|iPad|iPod/.test(agent)) return 'ios';
  return 'other';
}

// The same page with from=inapp&signin=google added (other params such as utm_* are kept), without the fragment.
export function handoffUrl(href) {
  const url = new URL(href);
  url.searchParams.set('from', 'inapp');
  url.searchParams.set('signin', 'google');
  url.hash = '';
  return url.href;
}

// An Android intent link that opens the handoff URL in Chrome. If Chrome is missing, Android opens the fallback URL.
export function chromeIntentUrl(href) {
  const url = new URL(handoffUrl(href));
  const scheme = url.protocol.replace(/:$/, '');
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${scheme};package=com.android.chrome;`
    + `S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
}

// A short analytics reason for a failed Google sign-in. Never the error's message.
export function googleErrorReason(error) {
  const code = String(error?.code || '');
  if (code === 'auth/popup-closed-by-user') return 'popup_closed';
  if (code === 'auth/popup-blocked') return 'popup_blocked';
  if (code === 'auth/cancelled-popup-request' || code === 'auth/user-cancelled') return 'cancelled';
  if (code === 'auth/network-request-failed' || code === 'auth/timeout') return 'network';
  if (code.includes('app-check')) return 'app_check';
  // Storage-partitioned or popup-less web views: what in-app browsers usually hit.
  if (['auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported', 'auth/missing-initial-state'].includes(code)) return 'unsupported';
  return 'other';
}
