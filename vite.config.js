import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dirname;

// index.html runs src/escape.js before anything else loads, so a first visit inside Instagram's or
// Facebook's browser is sent on to Chrome or Safari without waiting for the app's bundle.
// The module's exports are stripped so it can run as a plain inline script.
export function inlineEscapeScript(source) {
  return `(function(){${source.replace(/^export /gm, '')}\nescapeNow(window);})();`;
}

function escapeScript() {
  return {
    name: 'treasurehunch-escape-script',
    transformIndexHtml() {
      const source = readFileSync(join(root, 'src/escape.js'), 'utf8');
      return [{ tag: 'script', children: inlineEscapeScript(source), injectTo: 'head-prepend' }];
    },
  };
}

function publicFiles(directory, prefix = '') {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? publicFiles(path, `${prefix}/${name}`) : [`${prefix}/${name}`];
  });
}

// Emits /sw.js: src/service-worker.js with this build's file list and a build id in front.
// The id covers every precached file's name or content, so any change produces a new worker.
function serviceWorker() {
  return {
    name: 'treasurehunch-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const built = Object.keys(bundle)
        // The push worker registers itself; source maps and the HTML entry are handled separately.
        .filter(file => !file.includes('firebase-messaging-sw') && !file.endsWith('.map') && !file.endsWith('.html'))
        .map(file => `/${file}`);
      // Small public files the game needs offline. Illustrations and the social preview are fetched on demand.
      const statics = publicFiles(join(root, 'public')).filter(file =>
        /^\/(?:countries\.geojson|favicon\.svg|manifest\.webmanifest)$/.test(file) || /^\/fonts\//.test(file) || file === '/icons/icon-192.png');
      const precache = [...new Set(['/index.html', ...built, ...statics])].sort().map(encodeURI);
      const hash = createHash('sha256').update(precache.join('\n'));
      for (const file of statics) hash.update(readFileSync(join(root, 'public', file)));
      const html = Object.values(bundle).find(chunk => chunk.fileName === 'index.html');
      if (html) hash.update(String(html.source));
      const worker = readFileSync(join(root, 'src/service-worker.js'), 'utf8');
      hash.update(worker);
      const build = hash.digest('hex').slice(0, 12);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `self.__SW = ${JSON.stringify({ build, precache })};\n${worker}`,
      });
    },
  };
}

// The version in package.json is stamped on every analytics event (see APP_VERSION in src/events.js).
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [escapeScript(), serviceWorker()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173 },
});
