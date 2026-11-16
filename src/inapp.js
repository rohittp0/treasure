// In-app browsers (Instagram, Facebook, WhatsApp…) can't finish Google's popup or redirect sign-in and keep
// their own storage. Detection and the links out of them live in escape.js, which index.html also runs inline.
export { inAppBrowser, platform, handoffUrl, chromeIntentUrl, manualHandoff, attributionParams } from './escape.js';

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
