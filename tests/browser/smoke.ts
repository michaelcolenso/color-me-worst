/**
 * Runs the browser-only parts of the image pipeline in a real browser:
 * decoding a file, and palette extraction inside an actual Web Worker.
 * Driven by scripts/browserSmoke.mjs, which reads `window.__smoke`.
 */

import { decodeImage, toImageData } from '../../src/lib/image/canvasIo';
import {
  applyWhiteBalance,
  createImageWorkerClient,
  extractPalette,
  sampleLoupe,
  whiteBalanceFromPoint,
  type WorkerLike,
} from '../../src/lib/image';

declare global {
  interface Window {
    __smoke?: unknown;
  }
}

/** A 600 x 400 PNG: three colour bands and a grey card, all tinted warm. */
async function makeTestPhoto(): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 400;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');
  const bands = ['#3a5f9a', '#9a3a3a', '#4f8a4f'];
  bands.forEach((colour, index) => {
    context.fillStyle = colour;
    context.fillRect(index * 200, 0, 200, 300);
  });
  context.fillStyle = '#808080';
  context.fillRect(0, 300, 600, 100);
  // Warm cast: multiply blend scales each channel, like a tinted light.
  context.globalCompositeOperation = 'multiply';
  context.fillStyle = 'rgb(255, 214, 170)';
  context.fillRect(0, 0, 600, 400);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

async function run() {
  const photo = await makeTestPhoto();

  const full = await decodeImage(photo);
  const small = await decodeImage(photo, { maxDimension: 300 });

  const greyBefore = sampleLoupe(full, 300, 350, { kernel: 11 });
  const balance = whiteBalanceFromPoint(full, 300, 350);
  const greyAfter = sampleLoupe(full, 300, 350, { kernel: 11, whiteBalance: balance.matrix });

  const worker = new Worker(new URL('../../src/lib/image/imageWorker.ts', import.meta.url), { type: 'module' });
  const client = createImageWorkerClient(worker as unknown as WorkerLike);
  const started = performance.now();
  const fromWorker = await client.extractPalette(full, { count: 6, whiteBalance: balance.matrix });
  const workerMs = performance.now() - started;
  const corrected = await client.applyWhiteBalance(full, balance.matrix);
  let workerError = '';
  try {
    await client.extractPalette(full, { count: 0 });
  } catch (error) {
    workerError = `${(error as Error).name}: ${(error as Error).message}`;
  }
  client.terminate();

  const onMainThread = extractPalette(full, { count: 6, whiteBalance: balance.matrix });
  const correctedLocal = applyWhiteBalance(full, balance.matrix);
  const imageData = toImageData(corrected);

  return {
    fullSize: [full.width, full.height],
    smallSize: [small.width, small.height],
    colorSpace: full.colorSpace,
    greyBefore: greyBefore.color.lab,
    greyAfter: greyAfter.color.lab,
    castChroma: balance.castChroma,
    workerPalette: fromWorker.swatches.map((swatch) => ({ hex: swatch.color.hex, population: swatch.population })),
    workerMatchesMainThread: JSON.stringify(fromWorker) === JSON.stringify(onMainThread),
    workerMs,
    callerStillOwnsImage: full.data.length === 600 * 400 * 4,
    correctedMatchesLocal:
      corrected.data.length === correctedLocal.data.length &&
      corrected.data.every((value, index) => value === correctedLocal.data[index]),
    correctedIsImageData: imageData instanceof ImageData && imageData.width === 600,
    workerError,
  };
}

run().then(
  (result) => {
    window.__smoke = { ok: true, result };
  },
  (error: unknown) => {
    window.__smoke = { ok: false, error: String(error instanceof Error ? (error.stack ?? error.message) : error) };
  },
);
