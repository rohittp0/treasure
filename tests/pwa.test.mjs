import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { displayMode, installPath, shouldOfferInstall, pageIsStale, INSTALL_SNOOZE_MS } from '../src/pwa.js';

const UA = {
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  instagramAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S918B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 Instagram 352.0.0.38.100 Android',
  chromeDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

test('display mode tells the Play app, a home-screen app and a browser tab apart', () => {
  assert.equal(displayMode(), 'browser');
  assert.equal(displayMode({ standalone: true }), 'standalone');
  assert.equal(displayMode({ navigatorStandalone: true }), 'standalone');
  assert.equal(displayMode({ standalone: true, referrer: 'android-app://com.example.hunch/' }), 'twa');
  // The referrer is only there on the first page, so the session remembers it.
  assert.equal(displayMode({ standalone: true, remembered: 'twa' }), 'twa');
});

test('each browser gets the one install route that works there', () => {
  assert.equal(installPath({ ua: UA.chromeAndroid, canPrompt: true }), 'prompt');
  assert.equal(installPath({ ua: UA.chromeAndroid }), 'unavailable');
  assert.equal(installPath({ ua: UA.chromeDesktop, canPrompt: true }), 'prompt');
  assert.equal(installPath({ ua: UA.safariIos }), 'ios_steps');
  assert.equal(installPath({ ua: UA.instagramAndroid, canPrompt: true }), 'open_in_browser');
  assert.equal(installPath({ ua: UA.safariIos, mode: 'standalone' }), 'installed');
  assert.equal(installPath({ ua: UA.chromeAndroid, mode: 'twa', canPrompt: true }), 'installed');
});

test('the result card is offered only where a tap leads somewhere, and not within a week of "Not now"', () => {
  const now = Date.parse('2026-11-15T00:00:00Z');
  for (const path of ['prompt', 'ios_steps', 'open_in_browser']) assert.equal(shouldOfferInstall({ path, now }), true, path);
  for (const path of ['installed', 'unavailable', undefined]) assert.equal(shouldOfferInstall({ path, now }), false, String(path));
  assert.equal(shouldOfferInstall({ path: 'prompt', snoozedAt: now - 86400000, now }), false);
  assert.equal(shouldOfferInstall({ path: 'prompt', snoozedAt: now - INSTALL_SNOOZE_MS - 1, now }), true);
});

test('a page is stale once the active build no longer ships its script', () => {
  assert.equal(pageIsStale('/assets/index-old.js', ['/index.html', '/assets/index-new.js']), true);
  assert.equal(pageIsStale('/assets/index-new.js', ['/index.html', '/assets/index-new.js']), false);
  assert.equal(pageIsStale('', ['/index.html']), false);
  assert.equal(pageIsStale('/assets/index-old.js', undefined), false);
});

// ---- The service worker, run against a fake cache and network.
function workerHarness({ online = true, slow = false } = {}) {
  const precache = ['/index.html', '/assets/index-abc.js', '/countries.geojson', '/fonts/Open%20Sans%20Semibold/0-255.pbf'];
  const listeners = {};
  const stores = new Map();
  const fetched = [];
  const response = (body, ok = true) => ({ ok, body, clone() { return response(body, ok); } });
  const keyOf = request => (typeof request === 'string' ? request : request.url.replace('https://hunch.test', ''));
  const cacheFor = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      async addAll(requests) { for (const request of requests) { fetched.push(`precache ${keyOf(request)}`); entries.set(keyOf(request).split('?')[0], response(`cached ${keyOf(request)}`)); } },
      async match(request, options) { const key = keyOf(request); return entries.get(options?.ignoreSearch ? key.split('?')[0] : key); },
      async put(request, value) { entries.set(keyOf(request), value); },
    };
  };
  const state = { online, slow };
  const context = {
    URL, Set, Promise, Error, JSON,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)),
    Request: class { constructor(url, init = {}) { this.url = `https://hunch.test${url}`; this.cache = init.cache; this.method = 'GET'; } },
    caches: { open: async name => cacheFor(name), keys: async () => [...stores.keys()], delete: async name => stores.delete(name) },
    fetch: async request => {
      fetched.push(`network ${keyOf(request)}`);
      if (!state.online) throw new Error('offline');
      if (state.slow) await new Promise(resolve => setTimeout(resolve, 200));
      return response(`network ${keyOf(request)}`);
    },
    self: {
      __SW: { build: 'build-2', precache },
      location: { origin: 'https://hunch.test' },
      addEventListener: (type, listener) => { listeners[type] = listener; },
      skipWaiting: () => { context.skipped = true; },
      clients: { claim: async () => {}, matchAll: async () => context.pages },
    },
    pages: [],
    skipped: false,
  };
  vm.runInNewContext(readFileSync(new URL('../src/service-worker.js', import.meta.url), 'utf8'), context);
  const dispatch = async (type, event = {}) => {
    let waited; let answer;
    listeners[type]({ ...event, waitUntil: promise => { waited = promise; }, respondWith: promise => { answer = promise; } });
    await waited;
    return answer;
  };
  const request = (path, { mode = 'no-cors', method = 'GET', origin = 'https://hunch.test' } = {}) => ({ url: `${origin}${path}`, mode, method });
  return { context, stores, fetched, state, dispatch, request };
}

test('service worker: installs the whole shell and opens the game offline', async () => {
  const worker = workerHarness();
  await worker.dispatch('install');
  assert.deepEqual([...worker.stores.keys()], ['shell-build-2']);
  assert.equal(worker.stores.get('shell-build-2').size, 4);

  // Online, a page load comes from the network so a deploy shows at once.
  const online = await (await worker.dispatch('fetch', { request: worker.request('/?daily=1', { mode: 'navigate' }) }));
  assert.equal(online.body, 'network /?daily=1');
  // Offline, any route gets the stored shell.
  worker.state.online = false;
  const offline = await (await worker.dispatch('fetch', { request: worker.request('/?hunt=ABC', { mode: 'navigate' }) }));
  assert.equal(offline.body, 'cached /index.html');
  // A connection that hangs falls back too, instead of leaving a blank screen.
  worker.state.online = true; worker.state.slow = true;
  const slow = await (await worker.dispatch('fetch', { request: worker.request('/', { mode: 'navigate' }) }));
  assert.equal(slow.body, 'cached /index.html');
});

test('service worker: its own files come from the device, other origins and writes are left alone', async () => {
  const worker = workerHarness();
  await worker.dispatch('install');
  worker.fetched.length = 0;
  const script = await (await worker.dispatch('fetch', { request: worker.request('/assets/index-abc.js') }));
  assert.equal(script.body, 'cached /assets/index-abc.js');
  const glyphs = await (await worker.dispatch('fetch', { request: worker.request('/fonts/Open%20Sans%20Semibold/0-255.pbf') }));
  assert.equal(glyphs.body, 'cached /fonts/Open%20Sans%20Semibold/0-255.pbf');
  assert.deepEqual(worker.fetched, [], 'precached files never touch the network');

  // A newer build's asset is fetched once, then answered from the device.
  const first = await (await worker.dispatch('fetch', { request: worker.request('/assets/index-new.js') }));
  assert.equal(first.body, 'network /assets/index-new.js');
  const second = await (await worker.dispatch('fetch', { request: worker.request('/assets/index-new.js') }));
  assert.equal(second.body, 'network /assets/index-new.js');
  assert.equal(worker.stores.get('runtime').size, 1);

  assert.equal(await worker.dispatch('fetch', { request: worker.request('/v1/projects/x', { origin: 'https://firestore.googleapis.com' }) }), undefined);
  assert.equal(await worker.dispatch('fetch', { request: worker.request('/assets/index-abc.js', { method: 'POST' }) }), undefined);
  assert.equal(await worker.dispatch('fetch', { request: worker.request('/social-preview.png') }), undefined);
});

test('service worker: a new build waits to be asked, then clears old caches and tells open pages', async () => {
  const worker = workerHarness();
  worker.stores.set('shell-build-1', new Map());
  worker.stores.set('runtime', new Map([['/assets/old.js', {}]]));
  await worker.dispatch('install');
  assert.equal(worker.context.skipped, false, 'it never takes over by itself');
  await worker.dispatch('message', { data: { type: 'something-else' } });
  assert.equal(worker.context.skipped, false);
  await worker.dispatch('message', { data: { type: 'skip-waiting' } });
  assert.equal(worker.context.skipped, true);

  const messages = [];
  worker.context.pages = [{ postMessage: message => messages.push(message) }];
  await worker.dispatch('activate');
  assert.deepEqual([...worker.stores.keys()], ['shell-build-2']);
  assert.equal(messages[0].type, 'sw-activated');
  assert.equal(messages[0].build, 'build-2');
  assert.ok(messages[0].assets.includes('/assets/index-abc.js'));
});
