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
    // Run after Vite has emitted index.html, so its bytes are part of the version.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((file) => !file.endsWith('.map') && file !== 'index.html');
      const publicDir = resolve(import.meta.dirname, 'public');
      const copied = readdirSync(publicDir);
      const files = ['/', ...[...built, ...copied].sort().map((file) => `/${file}`)];
      // Version from the bytes of every file, not just the names: the page
      // and the files in public/ keep their names between releases, so a
      // change to them alone would otherwise never reach installed copies.
      const hash = createHash('sha256').update(JSON.stringify(files));
      for (const name of Object.keys(bundle).sort()) {
        if (name.endsWith('.map')) continue;
        const output = bundle[name];
        if (output === undefined) continue;
        hash.update(name).update(output.type === 'chunk' ? output.code : output.source);
      }
      for (const name of [...copied].sort()) hash.update(name).update(readFileSync(resolve(publicDir, name)));
      const version = hash.digest('hex').slice(0, 12);
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
