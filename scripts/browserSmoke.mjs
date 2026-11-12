#!/usr/bin/env node
/**
 * Browser smoke test for the image pipeline: `npm run test:browser`.
 *
 * Unit tests cover the pixel maths in Node, but three things only exist in a
 * browser: decoding an image file to pixels, the sRGB canvas, and a real Web
 * Worker. This script serves tests/browser/smoke.html with Vite, opens it in
 * headless Chromium and checks what the page reports.
 *
 * Requires Playwright with a Chromium build to be installed on the machine.
 * It is deliberately not a project dependency: it is large, and the unit
 * suite does not need it.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed; skipping the browser smoke test.');
  process.exit(2);
}

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/tests/browser/smoke.html`;

const browser = await chromium.launch();
let outcome;
try {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__smoke !== undefined, undefined, { timeout: 30_000 });
  outcome = await page.evaluate(() => window.__smoke);
  assert.deepEqual(problems, [], 'the page logged errors');
} finally {
  await browser.close();
  await server.close();
}

assert.equal(outcome.ok, true, `page failed: ${outcome.error}`);
const r = outcome.result;
console.log(JSON.stringify(r, null, 2));

const chroma = (lab) => Math.hypot(lab[1], lab[2]);

assert.deepEqual(r.fullSize, [600, 400], 'full-size decode keeps the original dimensions');
assert.deepEqual(r.smallSize, [300, 200], 'maxDimension scales the long side down, keeping aspect ratio');
assert.equal(r.colorSpace, 'srgb', 'decoded pixels are sRGB');
assert.ok(chroma(r.greyBefore) > 10, 'the test photo has a visible cast on the grey card');
assert.ok(chroma(r.greyAfter) < 1, 'white balance makes the grey card neutral');
assert.ok(r.castChroma > 10, 'the cast strength is reported');
assert.equal(r.workerMatchesMainThread, true, 'the worker returns exactly what the main thread computes');
assert.equal(r.workerPalette.length, 4, 'three bands and the grey card are found');
assert.ok(Math.abs(r.workerPalette.reduce((sum, swatch) => sum + swatch.population, 0) - 1) < 1e-9);
assert.equal(r.callerStillOwnsImage, true, 'sending an image to the worker does not detach the caller\'s copy');
assert.equal(r.correctedMatchesLocal, true, 'the worker\'s corrected image matches the main thread\'s');
assert.equal(r.correctedIsImageData, true, 'a pixel buffer converts back to ImageData');
assert.match(r.workerError, /^RangeError: count must be/, 'errors cross the worker boundary with their type');

console.log(`\nBrowser smoke test passed (palette in worker: ${r.workerMs.toFixed(0)} ms).`);
