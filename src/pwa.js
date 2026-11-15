// The installed app: how TreasureHunch is running, how it can be installed here, and what an installed
// copy can do (offline shell, updates, keeping the screen awake, the icon badge).
// Nothing here imports analytics; callers pass a `track` function, so the helpers stay testable.
import { inAppBrowser, platform } from './escape.js';

const SNOOZE_KEY = 'treasurehunch.install-snoozed';
const OFFERED_KEY = 'treasurehunch.install-offered';
export const INSTALL_SNOOZE_MS = 7 * 86400000;

// 'twa' (the Play Store app), 'standalone' (added to the home screen) or 'browser'.
// A Trusted Web Activity announces itself with an android-app:// referrer on its first page.
export function displayMode({ standalone = false, navigatorStandalone = false, referrer = '', remembered = '' } = {}) {
  if (String(referrer).startsWith('android-app://') || remembered === 'twa') return 'twa';
  return standalone || navigatorStandalone ? 'standalone' : 'browser';
}

// How this browser can install the app:
//   'installed'        already running as the installed app
//   'open_in_browser'  an in-app browser, which cannot install: the real browser has to be opened first
//   'prompt'           the browser handed over an install prompt (Chrome, Edge, Samsung Internet)
//   'ios_steps'        iPhone and iPad: only the Share menu can add to the Home Screen
//   'unavailable'      nothing to offer here (yet)
export function installPath({ ua = '', mode = 'browser', canPrompt = false } = {}) {
  if (mode !== 'browser') return 'installed';
  if (inAppBrowser(ua)) return 'open_in_browser';
  if (canPrompt) return 'prompt';
  if (platform(ua) === 'ios') return 'ios_steps';
  return 'unavailable';
}

// The result card is only offered where a tap leads somewhere, and not within a week of "Not now".
export function shouldOfferInstall({ path, snoozedAt = 0, now = Date.now() } = {}) {
  if (!['prompt', 'ios_steps', 'open_in_browser'].includes(path)) return false;
  return !(snoozedAt > 0 && now - snoozedAt < INSTALL_SNOOZE_MS);
}

// The install sheet opens by itself only once per device, and never within a week of "Not now".
export function shouldAutoOfferInstall({ path, offeredAt = 0, snoozedAt = 0, now = Date.now() } = {}) {
  return !(offeredAt > 0) && shouldOfferInstall({ path, snoozedAt, now });
}

// True when a newly activated worker's file list no longer contains the script this page is running.
export function pageIsStale(entryPath, assets) {
  return !!entryPath && Array.isArray(assets) && !assets.includes(entryPath);
}

const inBrowser = typeof window !== 'undefined';

function currentMode() {
  if (!inBrowser) return 'browser';
  let remembered = '';
  try { remembered = sessionStorage.getItem('treasurehunch.display-mode') || ''; } catch { /* Checked again next load. */ }
  const mode = displayMode({
    standalone: window.matchMedia?.('(display-mode: standalone)').matches || window.matchMedia?.('(display-mode: minimal-ui)').matches,
    navigatorStandalone: navigator.standalone === true,
    referrer: document.referrer,
    remembered,
  });
  // The android-app:// referrer is only present on the first page of a session.
  if (mode === 'twa') { try { sessionStorage.setItem('treasurehunch.display-mode', 'twa'); } catch { /* Best effort. */ } }
  return mode;
}
export const DISPLAY_MODE = currentMode();

// Holds the browser's install prompt until the explorer asks for it, and reports installs.
export function createInstaller({ track = () => {} } = {}) {
  let deferred = null;
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener(); };
  if (inBrowser) {
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      deferred = event;
      notify();
    });
    window.addEventListener('appinstalled', () => {
      deferred = null;
      track('installed');
      notify();
    });
  }
  return {
    path: () => installPath({ ua: inBrowser ? navigator.userAgent : '', mode: DISPLAY_MODE, canPrompt: !!deferred }),
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    // Shows the browser's own install dialog. Resolves to 'accepted', 'dismissed' or 'unavailable'.
    async prompt() {
      if (!deferred) return 'unavailable';
      const event = deferred;
      deferred = null;
      try {
        await event.prompt();
        const choice = await event.userChoice;
        notify();
        return choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
      } catch {
        notify();
        return 'unavailable';
      }
    },
    snoozedAt() {
      try { return Number(localStorage.getItem(SNOOZE_KEY)) || 0; } catch { return 0; }
    },
    snooze() {
      try { localStorage.setItem(SNOOZE_KEY, String(Date.now())); } catch { /* Asked again next time. */ }
    },
    // When the install sheet last opened by itself on this device (0 if never).
    offeredAt() {
      try { return Number(localStorage.getItem(OFFERED_KEY)) || 0; } catch { return 0; }
    },
    markOffered() {
      try { localStorage.setItem(OFFERED_KEY, String(Date.now())); } catch { /* It may open once more. */ }
    },
  };
}

// Registers /sw.js (production builds only) and keeps a long-open app current.
// A new build waits until `isIdle()` says no hunt or dialog is open; then it takes over, and a page still
// running the previous build reloads itself. Returns { check } to call when the app becomes idle.
export function startServiceWorker({ isIdle = () => true } = {}) {
  const noop = { check() {} };
  if (!inBrowser || !('serviceWorker' in navigator) || !import.meta.env?.PROD) return noop;
  const entry = (() => {
    try { return new URL(document.querySelector('script[type="module"][src]').src).pathname; } catch { return ''; }
  })();
  let registration = null;
  let reloadWanted = false;
  let lastUpdateCheck = Date.now();

  function reloadIfIdle() {
    if (!reloadWanted || !isIdle()) return;
    // At most one automatic reload every ten minutes, so a broken deploy can never loop.
    try {
      const last = Number(sessionStorage.getItem('treasurehunch.reloaded')) || 0;
      if (Date.now() - last < 600000) return;
      sessionStorage.setItem('treasurehunch.reloaded', String(Date.now()));
    } catch { return; }
    reloadWanted = false;
    location.reload();
  }
  function promote() {
    if (registration?.waiting && isIdle()) registration.waiting.postMessage({ type: 'skip-waiting' });
  }
  function check() {
    promote();
    reloadIfIdle();
  }

  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'sw-activated' && pageIsStale(entry, event.data.assets)) {
      reloadWanted = true;
      reloadIfIdle();
    }
  });
  // A lazily loaded chunk that no longer exists means this page outlived its build.
  window.addEventListener('vite:preloadError', () => { reloadWanted = true; reloadIfIdle(); });

  const register = async () => {
    try {
      registration = await navigator.serviceWorker.register('/sw.js');
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => { if (worker.state === 'installed') promote(); });
      });
      promote();
    } catch (error) {
      console.warn('Offline support is unavailable:', error);
    }
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    check();
    if (registration && Date.now() - lastUpdateCheck > 1800000) {
      lastUpdateCheck = Date.now();
      registration.update().catch(() => {});
    }
  });
  return { check };
}

// Keeps the screen on while a hunt's clock is running. Browsers drop the lock whenever the page is
// hidden, so it is taken again when the page comes back.
export function createWakeLock() {
  let wanted = false;
  let lock = null;
  async function acquire() {
    if (!wanted || lock || !inBrowser || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
      if (!wanted) release();
    } catch { /* Low battery or an unsupported browser: the hunt plays on without it. */ }
  }
  function release() {
    const held = lock;
    lock = null;
    held?.release().catch(() => {});
  }
  if (inBrowser) document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') acquire(); });
  return {
    on() { wanted = true; acquire(); },
    off() { wanted = false; release(); },
  };
}

// The count on the installed app's icon (iOS and desktop; Android ignores it).
export function setAppBadge(count) {
  if (!inBrowser || !navigator.setAppBadge) return;
  try {
    if (count > 0) navigator.setAppBadge(count).catch(() => {});
    else navigator.clearAppBadge?.().catch(() => {});
  } catch { /* Badges are decoration. */ }
}
