import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Writes /sw.js from src/app/serviceWorker.js, filling in the list of files
 * the build produced so the service worker can download all of them when it
 * installs. Without that list the first visit would cache almost nothing and
 * the app could not start offline.
 */
function serviceWorker(): Plugin {
  return {
    name: 'color-me-worst:service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((file) => !file.endsWith('.map') && file !== 'index.html');
      const copied = readdirSync(resolve(import.meta.dirname, 'public'));
      const files = ['/', ...[...built, ...copied].sort().map((file) => `/${file}`)];
      const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12);
      const template = readFileSync(resolve(import.meta.dirname, 'src/app/serviceWorker.js'), 'utf8');
      const source = template
        .replace('self.__PRECACHE_MANIFEST__', JSON.stringify(files))
        .replace('self.__PRECACHE_VERSION__', JSON.stringify(version));
      if (source === template) this.error('serviceWorker.js is missing its placeholders');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
});
