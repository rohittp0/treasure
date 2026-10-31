// Run with Playwright browser_run_code against the local Vite server.
// Provider adapters capture events locally; this sends no analytics traffic.
async page => {
  const origin = 'http://127.0.0.1:5173';
  const mock = await (await page.request.get(`${origin}/tests/fixtures/analytics-firebase.js`)).text();
  await page.unroute('**/src/firebase.js*');
  await page.route('**/src/main.js*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/src/firebase.js*', route => route.fulfill({ contentType: 'application/javascript', body: mock }));
  await page.route('**/fbevents.js', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/firebase_analytics.js*', route => route.fulfill({ contentType: 'application/javascript', body: `
    export const isSupported = async () => true;
    export const initializeAnalytics = (_, options) => { window.qaConfig = options; return {}; };
    export const logEvent = (_, name, params) => { (window.qaEvents ||= []).push({name,params}); };
  ` }));
  await page.goto(origin);
  const controllerSource = await (await page.request.get(`${origin}/src/friend-controller.js`)).text();
  const eventsModule = controllerSource.match(/from "([^"]*\/events\.js[^"]*)"/)[1];
  const result = await page.evaluate(async eventsModule => {
    const { initializeTracking, setAnalyticsSignedIn } = await import(eventsModule);
    setAnalyticsSignedIn(true); initializeTracking({}, { enabled: true });
    const { createFriendController } = await import('/src/friend-controller.js');
    const friend = createFriendController({ getUser: () => ({ uid: 's' }), getUsername: () => 'maya',
      getMap: () => ({ getLayer: () => false, resize: () => {} }), getCountries: () => null, showToast: () => {},
      playVictory: () => {}, clearVictory: () => {}, requestSignIn: () => {}, requestUsername: () => {},
      clearMapSelection: () => {}, setSheetCollapsed: () => {} });
    await friend.joinCode('ABCDEFGHJK');
    await friend.unlock(); await friend.unlock(); await friend.reveal();
    friend.mapCountry({ properties: { id: 'FRA', name: 'France' } });
    friend.cancelSelection();
    friend.mapCountry({ properties: { id: 'FRA', name: 'France' } }); await friend.guess();
    friend.mapCountry({ properties: { id: 'JPN', name: 'Japan' } }); await friend.guess();
    return true;
  }, eventsModule);
  await page.waitForFunction(() => window.qaEvents?.some(event => event.name === 'result_viewed'));
  const data = await page.evaluate(() => ({ events: window.qaEvents, meta: window.fbq.queue, config: window.qaConfig }));
  const names = data.events.map(e => e.name);
  const expected = ['page_view','clue_opened','clue_opened','country_revealed','country_selected','selection_cancelled','country_selected','guess_submitted','country_selected','guess_submitted','hunt_completed','result_viewed'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Unexpected action flow: ${names.join(' → ')}`);
  const guesses = data.events.filter(e => e.name === 'guess_submitted');
  if (guesses[0].params.outcome !== 'wrong' || guesses[1].params.outcome !== 'correct') throw new Error('Incorrect guess outcomes');
  if (data.events.some(e => e.params.account_status !== 'signed_in')) throw new Error('Authentication context lost');
  if (data.meta.filter(e => e[0] === 'track' || e[0] === 'trackCustom').length !== data.events.length) throw new Error('Provider event parity failed');
  if (data.config.config.send_page_view !== false) throw new Error('Automatic page views would duplicate manual tracking');
  return { result, flow: names, guesses: guesses.map(e => e.params.outcome), providersMatch: true };
}
