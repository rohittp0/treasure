// App Links (Android) and Universal Links (iOS) association files, and the Hosting config that serves them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ASSETLINKS = 'public/.well-known/assetlinks.json';
const AASA = 'public/.well-known/apple-app-site-association';
const DEBUG_SHA256 = '5E:CE:32:BC:C7:E6:2A:80:6E:80:13:C0:C1:06:7A:C1:F1:38:37:D3:FB:76:E3:F2:98:6B:62:EB:59:D3:08:D0';
const TEAM_ID = 'ZG6QASWQ43';
const SERVED = ['/.well-known/assetlinks.json', '/.well-known/apple-app-site-association'];
const hosting = JSON.parse(read('firebase.json')).hosting;

test('assetlinks.json lets the debug Android app open the site links', () => {
  const statements = JSON.parse(read(ASSETLINKS));
  const debug = statements.find(statement => statement.target?.package_name === 'com.lascade.hunch.debug');
  assert.ok(debug, 'com.lascade.hunch.debug is listed');
  assert.deepEqual(debug.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(debug.target.namespace, 'android_app');
  assert.deepEqual(debug.target.sha256_cert_fingerprints, [DEBUG_SHA256]);
  // The release app's Play app-signing fingerprint is added after the first Play upload (README).
  for (const statement of statements)
    for (const fingerprint of statement.target.sha256_cert_fingerprints)
      assert.match(fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('the apple-app-site-association lists both iOS apps and only the game links', () => {
  const aasa = JSON.parse(read(AASA));
  const [details] = aasa.applinks.details;
  assert.deepEqual(details.appIDs, [`${TEAM_ID}.com.lascade.hunch`, `${TEAM_ID}.com.lascade.hunch.debug`]);
  assert.deepEqual(details.components.map(component => [component['/'], Object.keys(component['?'])]),
    ['daily', 'hunt', 'atlas', 'whatsapp', 'account'].map(name => ['/', [name]]));
});

test('neither file holds a placeholder', () => {
  for (const path of [ASSETLINKS, AASA]) {
    const text = read(path);
    assert.doesNotMatch(text, /APPLE_TEAM_ID|PLACEHOLDER|TODO|XX:XX|REPLACE/i, path);
  }
});

test('firebase.json deploys .well-known, never rewrites it, and serves both files as JSON', () => {
  // Hosting matches the ignore globs against paths relative to the public folder. A pattern that matches
  // the folder itself (like the old "**/.*") can drop everything in it, depending on the glob version.
  for (const path of ['/.well-known', ...SERVED]) {
    const relative = path.slice(1);
    assert.deepEqual(hosting.ignore.filter(pattern => matchesGlob(relative, pattern)), [], `${path} is ignored`);
  }
  // Other dotfiles stay out of the deploy.
  assert.ok(hosting.ignore.some(pattern => matchesGlob('.DS_Store', pattern)));
  assert.ok(hosting.ignore.some(pattern => matchesGlob('.git/config', pattern)));

  const rewrites = (path, source) => source.startsWith('!') ? !matchesGlob(path, source.slice(1)) : matchesGlob(path, source);
  for (const path of SERVED) {
    assert.deepEqual(hosting.rewrites.filter(rule => rewrites(path, rule.source)), [], `${path} is rewritten`);
    assert.deepEqual((hosting.redirects || []).filter(rule => rewrites(path, rule.source)), [], `${path} is redirected`);
    const header = hosting.headers.find(rule => rule.source === path);
    assert.deepEqual(header?.headers.find(entry => entry.key === 'Content-Type'), { key: 'Content-Type', value: 'application/json' }, path);
  }
});
