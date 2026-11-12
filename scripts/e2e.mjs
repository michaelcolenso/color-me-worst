#!/usr/bin/env node
/**
 * End-to-end check of the built app: `npm run test:e2e`.
 *
 * Builds the production bundle, serves it with `vite preview`, and drives it
 * in headless Chromium at phone and desktop sizes: building a stash, placing
 * and dragging pins, correcting the lighting, switching match mode,
 * extracting a palette, translating a recipe, and reloading offline.
 *
 * Pass a directory as the first argument to save screenshots there.
 *
 * Requires Playwright with a Chromium build on the machine (not a project
 * dependency; see scripts/browserSmoke.mjs).
 */

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, preview } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const shotDir = process.argv[2] ? resolve(process.argv[2]) : null;
if (shotDir) mkdirSync(shotDir, { recursive: true });

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed; skipping the end-to-end test.');
  process.exit(2);
}

await build({ root, logLevel: 'error' });
const server = await preview({ root, logLevel: 'error', preview: { port: 0, host: '127.0.0.1' } });
const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();

const STASH = ['Mephiston Red', 'White Scar', 'Abaddon Black', 'Averland Sunset', 'Macragge Blue', 'Rhinox Hide'];

/** Click a point given in image pixels, whatever size the canvas is drawn at. */
async function clickImage(page, x, y) {
  await page.locator('.stage-canvas').scrollIntoViewIfNeeded();
  const box = await page.locator('.stage-canvas').boundingBox();
  const size = await page.locator('.stage-canvas').evaluate((canvas) => [canvas.width, canvas.height]);
  await page.mouse.click(box.x + ((x + 0.5) / size[0]) * box.width, box.y + ((y + 0.5) / size[1]) * box.height);
}

const targetColor = (page, card = 0) =>
  page.locator('.match-card').nth(card).getByTestId('swatch-target').evaluate((el) => getComputedStyle(el).backgroundColor);

async function run(label, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, hasTouch: label === 'phone' });
  const page = await context.newPage();
  currentPage = page;
  const problems = [];
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const shot = async (name) => {
    if (shotDir) await page.screenshot({ path: join(shotDir, `${label}-${name}.png`), fullPage: true });
  };

  await page.goto(url);
  await page.getByRole('heading', { name: 'Match colours from a photo' }).waitFor();
  await assertVisible(page.getByText('Your stash is empty'), 'empty-stash prompt is shown');
  await shot('1-empty');

  // -- stash ------------------------------------------------------------------
  await page.getByRole('button', { name: 'Stash', exact: false }).first().click();
  for (const name of STASH) {
    await page.getByLabel('Search').fill(name);
    await page.getByRole('button', { name: new RegExp(`^Add Citadel ${name} to my stash$`) }).click();
  }
  await page.getByLabel('Search').fill('');
  await assertVisible(page.getByText(`${STASH.length} of 111`), 'owned count updates');
  await page.getByLabel('Only what I own').check();
  assert.equal(await page.locator('.stash-list li').count(), STASH.length, 'owned filter lists exactly the stash');
  await shot('2-stash');

  // The stash survives a reload (IndexedDB).
  await page.reload();
  await page.getByRole('heading', { name: 'Match colours from a photo' }).waitFor();
  assert.equal(await page.locator('.tab .count').textContent(), String(STASH.length), 'stash persists across reload');

  // -- photo workspace ----------------------------------------------------------
  await page.getByRole('button', { name: 'Try the sample photo' }).click();
  await page.locator('.stage-canvas').waitFor();
  await clickImage(page, 250, 300); // dark part of the cloak
  await page.locator('.pin').first().waitFor();
  assert.equal(await page.locator('.match-card').count(), 1, 'a pin produces one result card');
  const castColor = await targetColor(page);

  // Split swatch: the two halves must touch with nothing between them.
  const halves = await page.locator('.match-card').first().locator('.split-swatch.large .split-swatch-half').evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, border: style.borderWidth, radius: style.borderRadius, shadow: style.boxShadow };
    }),
  );
  assert.equal(halves.length, 2, 'target and match halves are both drawn');
  assert.ok(Math.abs(halves[0].right - halves[1].left) < 0.01, 'the halves share an edge with no gap');
  assert.ok(Math.abs(halves[0].top - halves[1].top) < 0.01 && Math.abs(halves[0].bottom - halves[1].bottom) < 0.01, 'the halves are the same height');
  for (const half of halves) {
    assert.equal(half.border, '0px', 'no border on a swatch half');
    assert.equal(half.radius, '0px', 'no rounding between the halves');
    assert.equal(half.shadow, 'none', 'no shadow on a swatch half');
  }

  // Lighting correction from the grey card changes what the pin reads.
  await page.getByRole('button', { name: 'Pick neutral' }).click();
  await clickImage(page, 115, 520);
  await assertVisible(page.getByText('Lighting cast removed'), 'white balance confirms');
  const balancedColor = await targetColor(page);
  assert.notEqual(balancedColor, castColor, 'the pin reads a different colour after correction');
  // The cloak was drawn as #8f1d21 = rgb(143, 29, 33) before the warm cast and noise.
  const [r, g, b] = balancedColor.match(/\d+/g).map(Number);
  // Not exact: the sample photo's tint is a canvas "multiply" on gamma-encoded
  // values, which no physical white-balance model inverts perfectly.
  assert.ok(Math.abs(r - 143) <= 12 && Math.abs(g - 29) <= 12 && Math.abs(b - 33) <= 12, `corrected pin is close to the true cloak colour, got ${balancedColor}`);
  await assertVisible(page.locator('.match-card').first().getByText(/Mephiston Red/), 'the owned red is used for the cloak, alone or in a mix');
  await shot('3-pin');

  // Drag the pin onto the shield: the reading and the match change.
  const pin = page.locator('.pin').first();
  await page.locator('.stage-canvas').scrollIntoViewIfNeeded();
  const from = await pin.boundingBox();
  const canvasBox = await page.locator('.stage-canvas').boundingBox();
  const to = { x: canvasBox.x + (690 / 900) * canvasBox.width, y: canvasBox.y + (370 / 600) * canvasBox.height };
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await assertVisible(page.locator('.loupe'), 'the magnifier shows while dragging');
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await shot('4-dragging');
  await page.mouse.up();
  const shieldColor = await targetColor(page);
  assert.notEqual(shieldColor, balancedColor, 'dragging the pin changes its reading');
  const [sr, sg, sb] = shieldColor.match(/\d+/g).map(Number);
  assert.ok(sr > 170 && sg > 130 && sb < 110, `pin now reads the gold shield, got ${shieldColor}`);

  // Mode toggle: purchase suggestions appear only in full-catalogue mode.
  await clickImage(page, 385, 95); // skin
  assert.equal(await page.locator('.match-card').count(), 2, 'a second pin adds a second card');
  assert.ok((await page.locator('.to-buy').count()) > 0, 'full catalogue mode suggests something to buy');
  await page.getByRole('button', { name: 'My stash only' }).click();
  assert.equal(await page.locator('.to-buy').count(), 0, 'strict stash mode never suggests buying');
  await page.getByRole('button', { name: 'Full catalogue' }).click();

  // Keyboard: nudge and delete a pin.
  await page.locator('.pin').nth(1).focus();
  const beforeNudge = await page.locator('.pin').nth(1).boundingBox();
  await page.keyboard.press('Shift+ArrowRight');
  const afterNudge = await page.locator('.pin').nth(1).boundingBox();
  assert.ok(afterNudge.x > beforeNudge.x, 'arrow keys move a pin');
  await page.keyboard.press('Delete');
  assert.equal(await page.locator('.pin').count(), 1, 'Delete removes the focused pin');

  // Palette extraction runs in the worker and adds result cards.
  await page.getByRole('button', { name: 'Extract palette' }).click();
  await page.getByRole('heading', { name: 'Main colours in this photo' }).waitFor();
  assert.ok((await page.locator('.match-card').count()) >= 4, 'the palette adds several colours');
  await shot('5-palette');

  // A palette is tied to the lighting it was extracted under: changing the light discards it.
  await page.getByRole('button', { name: 'Reset light' }).click();
  await assertGone(page.getByRole('heading', { name: 'Main colours in this photo' }), 'resetting the light clears the palette');
  await page.getByRole('button', { name: 'Extract palette' }).click();
  await page.getByRole('heading', { name: 'Main colours in this photo' }).waitFor();
  await page.getByRole('button', { name: 'Auto balance' }).click();
  await assertVisible(page.getByText('Automatic correction applied'), 'automatic balance confirms');
  await assertGone(page.getByRole('heading', { name: 'Main colours in this photo' }), 'changing the light clears the palette');

  // The photo and pins survive a visit to another tab.
  await page.getByRole('button', { name: 'Recipe' }).click();

  // -- recipe translator --------------------------------------------------------
  await page.getByRole('button', { name: 'Use an example' }).click();
  await page.locator('.recipe-table tbody tr').first().waitFor();
  const statuses = await page.locator('.recipe-table tbody tr').evaluateAll((rows) =>
    rows.map((row) => [row.querySelector('th strong')?.textContent ?? row.querySelector('th')?.textContent, row.dataset.status]),
  );
  const status = Object.fromEntries(statuses);
  assert.equal(statuses.length, 9, 'every example line becomes a row');
  assert.equal(status['Citadel Mephiston Red'], 'You own it');
  assert.equal(status['Citadel Rhinox Hide'], 'You own it');
  assert.equal(status['Citadel Nuln Oil'], 'Not in your stash', 'a wash is not replaced by an opaque paint');
  assert.equal(status['Citadel Retributor Armour'], 'Not in your stash', 'a metallic is not replaced by a matte paint');
  assert.ok(
    ['Exact match', 'Close substitute', 'Mix from your stash', 'Nearest you own'].includes(status['Vallejo Black']),
    `another brand's black is covered from the stash, got ${status['Vallejo Black']}`,
  );
  const shopping = await page.locator('.shopping-list li').allTextContents();
  assert.ok(shopping.includes('Citadel Nuln Oil') && shopping.includes('Citadel Retributor Armour'), 'true gaps are on the shopping list');
  assert.ok(!shopping.includes('Citadel Mephiston Red'), 'owned items are not on the shopping list');
  await assertVisible(page.getByRole('button', { name: 'Copy list' }), 'the shopping list can be copied');
  await shot('6-recipe');

  await page.getByRole('button', { name: 'Photo' }).click();
  assert.equal(await page.locator('.pin').count(), 1, 'pins are still there after switching tabs');

  // -- offline ------------------------------------------------------------------
  // No extra online reload here: the service worker must have downloaded
  // everything the app needs by the time it reports itself active.
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (worker && worker.state !== 'activated') {
      await new Promise((done) => worker.addEventListener('statechange', () => worker.state === 'activated' && done(undefined)));
    }
  });
  // Prove the files are in Cache Storage itself, not merely in the browser's HTTP cache.
  const precache = await page.evaluate(async () => {
    const source = await (await fetch('/sw.js')).text();
    const files = JSON.parse(/const PRECACHE = (\[.*?\]);/.exec(source)[1]);
    const missing = [];
    for (const file of files) if (!(await caches.match(file))) missing.push(file);
    const stored = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        stored.push(`${name} ${new URL(request.url).pathname} origin=${request.headers.get('origin')} vary=${response?.headers.get('vary')}`);
      }
    }
    return { files, missing, stored };
  });
  assert.ok(precache.files.some((file) => /\/assets\/index-.*\.js$/.test(file)), 'the app bundle is in the precache list');
  assert.ok(precache.files.some((file) => /\/assets\/imageWorker-.*\.js$/.test(file)), 'the image worker is in the precache list');
  assert.deepEqual(precache.missing, [], `every listed file was cached at install; cache holds:\n${precache.stored.join('\n')}`);
  // The page has reloaded under the worker's control by now. Its script and
  // style requests carry an Origin header; they must have been answered from
  // the install-time copies rather than re-downloaded and stored again.
  const refetched = precache.stored.filter((entry) => !entry.includes('origin=null'));
  assert.deepEqual(refetched, [], 'page requests were served from the precache');
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('heading', { name: 'Match colours from a photo' }).waitFor();
  assert.equal(await page.locator('.tab .count').textContent(), String(STASH.length), 'the app and stash load with no network');
  await page.getByRole('button', { name: 'Try the sample photo' }).click();
  await clickImage(page, 250, 300);
  await page.locator('.match-card').first().waitFor();
  await page.getByRole('button', { name: 'Extract palette' }).click();
  await page.getByRole('heading', { name: 'Main colours in this photo' }).waitFor();
  await context.setOffline(false);

  // Nothing may overflow sideways at this width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal page scroll (overflow ${overflow}px)`);

  // Offline reloads log a failed navigation fetch from the service worker's
  // network-first attempt; that is expected and not an application error.
  const real = problems.filter((text) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(text));
  assert.deepEqual(real, [], `${label}: the page logged errors`);
  await context.close();
  console.log(`  ${label} (${viewport.width} x ${viewport.height}): passed`);
}

async function assertGone(locator, message) {
  try {
    await locator.first().waitFor({ state: 'detached', timeout: 5000 });
  } catch {
    assert.fail(`expected to disappear: ${message}`);
  }
}

async function assertVisible(locator, message) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    assert.fail(`expected to see: ${message}`);
  }
}

let currentPage = null;
try {
  await run('phone', { width: 390, height: 844 });
  await run('desktop', { width: 1280, height: 900 });
  console.log('End-to-end test passed.');
} catch (error) {
  // A picture of the page at the moment of failure is usually the fastest diagnosis.
  if (shotDir && currentPage) await currentPage.screenshot({ path: join(shotDir, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.httpServer.close(done));
}
