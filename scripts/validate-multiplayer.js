// Run with Playwright's browser_run_code filename against the local Vite server.
// Uses the real UI/controllers with a local Firebase adapter; no production writes.
async (page) => {
  const root = 'output/multiplayer';
  const origin = 'http://127.0.0.1:5173';
  const mock = await (await page.request.get(`${origin}/tests/fixtures/multiplayer-firebase.js`)).text();
  await page.unroute('**/src/firebase.js*');
  await page.route('**/src/firebase.js*', route => route.fulfill({ contentType: 'application/javascript', body: mock }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', {value:()=>false, configurable:true});
    for (const uid of ['h','s','spectator']) sessionStorage.setItem(`treasurehunch:notify-asked:${uid}`, '1');
  });
  const checks = [];
  function check(ok, message) { if (!ok) throw new Error(message); checks.push(message); }
  async function open(role, outcome, extra = '') {
    await page.goto(`${origin}/?hunt=ABCDEFGHJK&role=${role}&outcome=${outcome}${extra}`);
    await page.locator('#friend-result .result-story').waitFor();
    if (role !== 'spectator') await page.locator('#friend-poster-button:enabled').waitFor();
    await page.locator('.friend-illustration').evaluate(image => image.decode());
  }
  for (const role of ['hider', 'seeker']) for (const outcome of ['won', 'lost']) {
    await page.setViewportSize({width:390,height:844});
    await open(role, outcome);
    const win = role === (outcome === 'won' ? 'seeker' : 'hider');
    check(await page.locator('#friend-result').getAttribute('data-outcome') === (win ? 'win' : 'loss'), `${role}/${outcome}: personal outcome`);
    check(await page.locator('#friend-poster-button').isVisible(), `${role}/${outcome}: participant poster access`);
    await page.screenshot({path:`${root}/${role}-${outcome}-mobile.png`});
    if (win) {
      const pending = page.waitForEvent('download'); await page.locator('#friend-poster-button').click();
      await (await pending).saveAs(`${root}/poster-${role}.png`);
    }
    if (role === 'seeker') {
      check(await page.locator('#friend-challenge-back-button').textContent() === (win ? 'Challenge back' : 'Plot your revenge'), `${outcome}: rematch label`);
      await page.locator('#friend-challenge-back-button').click();
      check(await page.locator('#friend-target-username').inputValue() === 'rohit', `${outcome}: original hider preselected`);
    }
  }
  await page.setViewportSize({width:1280,height:1000}); await open('seeker','won');
  await page.screenshot({path:`${root}/victory-desktop.png`});
  await page.setViewportSize({width:320,height:740}); await open('seeker','won','&long&legacy&missing');
  check((await page.locator('#friend-result').innerText()).includes('120s hunt'), 'legacy duration displayed');
  check((await page.locator('#friend-result').innerText()).includes('Location unavailable'), 'missing country graceful');
  check(await page.locator('#friend-result').evaluate(el => el.scrollWidth <= el.clientWidth), 'long names fit narrow result');
  await page.screenshot({path:`${root}/long-names-mobile.png`});
  const longPending = page.waitForEvent('download'); await page.locator('#friend-poster-button').click();
  await (await longPending).saveAs(`${root}/poster-long-names.png`);
  await open('spectator','lost');
  check(await page.locator('#friend-poster-button').isHidden(), 'spectator cannot export');
  check(!(await page.locator('#friend-result').innerText()).includes('Japan'), 'spectator country remains private');
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${origin}/?role=hider&outcome=lost&retry`);
  await page.locator('#account-button').filter({hasText:'My logs'}).waitFor(); await page.locator('#account-button').click();
  await page.locator('#multiplayer-log-retry:not(.hidden)').waitFor();
  await page.locator('#multiplayer-log-retry').click();
  await page.locator('.multiplayer-log-entry').first().waitFor();
  check((await page.locator('#multiplayer-log').innerText()).includes('Not yet accepted'), 'sent challenge acceptance state');
  check((await page.locator('#multiplayer-log').innerText()).includes('In progress'), 'active challenge state');
  await page.screenshot({path:`${root}/multiplayer-logs-mobile.png`});
  await page.locator('[data-hunt="ABCDEFGHJK"]').click();
  await page.locator('#friend-poster-button:enabled').waitFor();
  check(await page.locator('#account-dialog').isHidden(), 'historical result opens from log');
  check((await page.locator('#friend-result').innerText()).includes('Your secret. Your victory.'), 'historical hider win rendered');
  await page.goto(`${origin}/?role=hider&empty`);
  await page.locator('#account-button').filter({hasText:'My logs'}).waitFor(); await page.locator('#account-button').click();
  await page.getByText('No friend hunts yet.', {exact:false}).waitFor();
  check(true, 'history empty state');
  return checks;
}
