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
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
/** Items owned once the bulk-import steps have run: the six above, one from a pasted list, one from a photo. */
const OWNED_AFTER_IMPORT = STASH.length + 2;
const downloadDir = mkdtempSync(join(tmpdir(), 'color-me-worst-e2e-'));

/** True when a command-line tool is installed; PDF rendering checks are skipped without poppler. */
function hasTool(name) {
  try {
    execFileSync(name, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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

  // -- bulk import: pasted list (matched on the device, no server) -------------
  await page.getByLabel('Only what I own').uncheck();
  await page.getByText('Add many at once').click();
  await page.getByLabel('Paste a list of what you own').fill('Ivory\nUnicorn Tears\nMephiston Red, Mephiston Red');
  await page.getByRole('button', { name: 'Find these' }).click();
  await page.getByRole('heading', { name: 'Check what was found' }).waitFor();
  const review = page.locator('.import-review .stash-list li');
  assert.equal(await review.count(), 3, 'three distinct things were read from the list');
  assert.equal(await review.nth(0).locator('select option').count(), 2, 'an ambiguous name offers a choice');
  assert.equal(await review.nth(0).locator('input[type=checkbox]').isChecked(), true, 'a new match is ticked by default');
  assert.equal(await review.nth(1).locator('input[type=checkbox]').isDisabled(), true, 'an unrecognised line cannot be added');
  await assertVisible(review.nth(1).getByText('Not in the catalogue'), 'an unrecognised line is reported');
  await assertVisible(review.nth(2).getByText('Already owned'), 'an owned item is marked');
  assert.equal(await review.nth(2).locator('input[type=checkbox]').isDisabled(), true, 'an owned item is not added twice');
  await page.getByRole('button', { name: 'Add 1 to my stash' }).click();
  await assertVisible(page.getByText('Added 1 to your stash.'), 'the list import confirms');
  assert.equal(await page.locator('.tab .count').textContent(), String(STASH.length + 1), 'the list import adds one item');

  // -- bulk import: photo ---------------------------------------------------------
  // The preview server has no API, as on any static host: the app must say so plainly.
  const photoInput = page.locator('.import input[type=file]');
  await photoInput.setInputFiles(join(root, 'public/icon-512.png'));
  await assertVisible(page.getByText('Photo import isn’t switched on for this site yet'), 'a missing API is explained');

  // With an API present: check what the app sends, then answer as the server would.
  let sent = null;
  await page.route('**/api/ingest', async (route) => {
    sent = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        source: 'image',
        entries: [
          { label: 'DMC Black 310', match: { id: 'dmc:six-strand-cotton-floss:310' }, alternatives: [] },
          { label: 'Mystery Pot', match: null, alternatives: [] },
          { label: 'Ghost', match: { id: 'not:in:this-catalogue' }, alternatives: [] },
        ],
      }),
    });
  });
  await photoInput.setInputFiles(join(root, 'public/icon-512.png'));
  await page.getByRole('heading', { name: 'Check what was found' }).waitFor();
  assert.equal(sent?.image?.mediaType, 'image/jpeg', 'the photo is sent as a JPEG');
  const jpegHead = Buffer.from(sent.image.data, 'base64').subarray(0, 2);
  assert.deepEqual([...jpegHead], [0xff, 0xd8], 'the upload really is JPEG data, base64 encoded');
  assert.equal(sent.text, undefined, 'only the image is sent');
  assert.equal(await review.count(), 3, 'each label the server read is listed');
  await assertVisible(review.nth(0).getByText('DMC Black'), 'a matched label shows the catalogue item');
  assert.equal(await review.nth(2).locator('input[type=checkbox]').isDisabled(), true, 'an id this catalogue does not know is not added');
  await page.getByRole('button', { name: 'Add 1 to my stash' }).click();
  assert.equal(await page.locator('.tab .count').textContent(), String(OWNED_AFTER_IMPORT), 'the photo import adds one item');

  // A server-side refusal is shown in the server's own words.
  await page.unroute('**/api/ingest');
  await page.route('**/api/ingest', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'rate_limited', message: 'Too many photos from this connection. Try again in an hour.' } }),
    }),
  );
  await photoInput.setInputFiles(join(root, 'public/icon-512.png'));
  await assertVisible(page.getByText('Too many photos from this connection'), 'a rate limit is explained');
  await page.unroute('**/api/ingest');
  await shot('2b-import');

  // The stash survives a reload (IndexedDB).
  await page.reload();
  await page.getByRole('heading', { name: 'Match colours from a photo' }).waitFor();
  assert.equal(await page.locator('.tab .count').textContent(), String(OWNED_AFTER_IMPORT), 'stash persists across reload');

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

  // -- recipe card export ----------------------------------------------------------
  const cardTarget = await targetColor(page);
  const cardMatch = await page.locator('.match-card').first().getByTestId('swatch-match').evaluate((el) => getComputedStyle(el).backgroundColor);
  const save = async (name) => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name, exact: true }).click()]);
    const file = join(downloadDir, `${label}-${download.suggestedFilename()}`);
    await download.saveAs(file);
    return { file, name: download.suggestedFilename() };
  };

  const png = await save('PNG');
  assert.match(png.name, /^colour-recipe-\d{4}-\d{2}-\d{2}\.png$/, 'the PNG has a dated file name');
  const pngBytes = readFileSync(png.file);
  assert.deepEqual([...pngBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the file is a PNG');
  const pngWidth = pngBytes.readUInt32BE(16);
  const pngHeight = pngBytes.readUInt32BE(20);
  assert.equal(pngWidth, 2400, 'the card is 2400 pixels wide (1200 at 2x)');
  assert.ok(pngHeight > 2000, `the card is tall enough to hold the photo and a row, got ${pngHeight}`);

  // Read colours back out of the exported image. The positions follow the
  // layout constants in recipeCard.ts for the 900 x 600 sample photo:
  // photo drawn 1088 x 725 at (56, 168); first row starts at y = 929.
  const sampled = await page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { colorSpace: 'srgb' });
    context.drawImage(bitmap, 0, 0);
    const at = (x, y) => {
      const [r, g, b] = context.getImageData(x * 2, y * 2, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    };
    return {
      background: at(20, 20),
      swatchTarget: at(116 + 30, 947 + 34),
      swatchMatch: at(116 + 95 + 30, 947 + 34),
      surround: at(110, 943),
      // Where the cloak is in the photo; must not be the white page or the grey frame.
      photo: at(56 + Math.round((250 / 900) * 1088), 168 + Math.round((150 / 600) * 725)),
    };
  }, pngBytes.toString('base64'));
  assert.equal(sampled.background, 'rgb(255, 255, 255)', 'the card has a white page');
  assert.equal(sampled.surround, 'rgb(123, 123, 123)', 'the swatch sits on the neutral grey surround');
  assert.equal(sampled.swatchTarget, cardTarget, 'the exported target swatch is exactly the pin colour');
  assert.equal(sampled.swatchMatch, cardMatch, 'the exported match swatch is exactly the suggested colour');
  assert.ok(!['rgb(255, 255, 255)', 'rgb(123, 123, 123)'].includes(sampled.photo), 'the reference photo is drawn on the card');

  const pdf = await save('PDF');
  assert.match(pdf.name, /^colour-recipe-\d{4}-\d{2}-\d{2}\.pdf$/, 'the PDF has a dated file name');
  const pdfBytes = readFileSync(pdf.file);
  assert.equal(pdfBytes.subarray(0, 8).toString('latin1'), '%PDF-1.4', 'the file is a PDF');
  assert.ok(pdfBytes.subarray(-6).toString('latin1').includes('%%EOF'), 'the PDF is complete');
  if (hasTool('pdfinfo') && hasTool('pdftoppm')) {
    // An independent PDF reader must accept the file and render the card.
    const info = execFileSync('pdfinfo', [pdf.file], { encoding: 'utf8' });
    assert.match(info, /Pages:\s+1\b/, 'the PDF has one page');
    assert.match(info, /Title:\s+Colour recipe/, 'the PDF carries its title');
    const pageSize = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
    assert.ok(pageSize, 'the PDF reports a page size');
    assert.ok(Math.abs(Number(pageSize[1]) - 595.28) < 0.01, 'the PDF page is A4 width');
    assert.ok(Math.abs(Number(pageSize[2]) / Number(pageSize[1]) - pngHeight / pngWidth) < 0.002, 'the PDF page has the card\'s proportions');
    const rendered = join(downloadDir, `${label}-card`);
    execFileSync('pdftoppm', ['-r', '40', '-png', '-singlefile', pdf.file, rendered]);
    const renderedBytes = readFileSync(`${rendered}.png`);
    const check = await page.evaluate(async (base64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const colours = new Set();
      for (let offset = 0; offset < data.length; offset += 4 * 97) colours.add(`${data[offset] >> 4},${data[offset + 1] >> 4},${data[offset + 2] >> 4}`);
      return { width: bitmap.width, height: bitmap.height, distinct: colours.size };
    }, renderedBytes.toString('base64'));
    assert.ok(check.distinct > 20, `the rendered PDF page shows the card, not a blank page (${check.distinct} colours)`);
    renderedPdf = true;
  }
  assert.ok(statSync(pdf.file).size > 20_000, 'the PDF contains the card image');

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
  assert.equal(await page.locator('.tab .count').textContent(), String(OWNED_AFTER_IMPORT), 'the app and stash load with no network');
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
let renderedPdf = false;
try {
  await run('phone', { width: 390, height: 844 });
  await run('desktop', { width: 1280, height: 900 });
  console.log(`End-to-end test passed.${renderedPdf ? '' : ' (PDF rendering check skipped: poppler is not installed.)'}`);
} catch (error) {
  // A picture of the page at the moment of failure is usually the fastest diagnosis.
  if (shotDir && currentPage) await currentPage.screenshot({ path: join(shotDir, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.httpServer.close(done));
}
