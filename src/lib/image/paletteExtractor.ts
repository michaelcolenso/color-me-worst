/**
 * Dominant palette extraction: K-means++ clustering in CIELAB.
 *
 * Clustering runs in CIELAB rather than RGB because distances there track
 * what the eye sees, so clusters form around colours a person would call
 * distinct instead of around whatever happens to be far apart numerically.
 *
 * Steps
 *   1. Sample the image on a regular grid, up to `maxSamples` pixels, skipping
 *      transparent ones. White balance is applied here when supplied.
 *   2. Seed `count` centres with k-means++ (each new centre is drawn with
 *      probability proportional to squared distance from the nearest existing
 *      one), which avoids the poor starts plain random seeding gives.
 *   3. Lloyd iterations until assignments stop changing.
 *   4. Merge centres that ended up visually indistinguishable, so a nearly
 *      flat image does not return eight versions of one colour.
 *
 * The result is deterministic: the random draws come from a seeded generator,
 * so the same image and options always give the same palette.
 *
 * No DOM access; intended to run in a Web Worker (see imageWorker.ts).
 */

import { colorFromLab, linearRgbToXyz, xyzToLab } from '../color/colorConversions';
import { deltaE2000Components } from '../color/deltaE2000';
import type { ColorCoordinates } from '../color/types';
import { SRGB8_TO_LINEAR, applyMatrix, assertPixelBuffer, createRandom, type Matrix3, type PixelBuffer } from './pixelMath';

/** Smallest and largest palette sizes accepted. The product uses 5 to 12. */
export const MIN_PALETTE_SIZE = 1;
export const MAX_PALETTE_SIZE = 16;

export interface PaletteOptions {
  /** Colours to look for, {@link MIN_PALETTE_SIZE}–{@link MAX_PALETTE_SIZE}. Default 8. */
  count?: number;
  /** Upper limit on pixels clustered. Default 20 000; more adds time, not visible accuracy. */
  maxSamples?: number;
  /** Seed for the random draws. Default 1. */
  seed?: number;
  /** White-balance correction applied to every sampled pixel. */
  whiteBalance?: Matrix3;
  /** Safety limit on Lloyd iterations. Default 40. */
  maxIterations?: number;
  /**
   * Merge clusters closer than this ΔE00. Default 2.5 (below a "close
   * substitute"); 0 disables merging.
   */
  mergeDeltaE?: number;
  /** Pixels with alpha below this (0–255) are ignored. Default 128. */
  minAlpha?: number;
}

export interface PaletteSwatch {
  color: ColorCoordinates;
  /** Share of the sampled pixels in this cluster, 0–1. Swatches sum to 1. */
  population: number;
}

export interface PaletteResult {
  /**
   * Most common first. May hold fewer than `count` entries when the image
   * has fewer distinct colours than were asked for.
   */
  swatches: PaletteSwatch[];
  /** Pixels that were clustered. */
  sampleCount: number;
  /** Lloyd iterations run. */
  iterations: number;
}

/**
 * Extract the dominant colours of an image.
 * @throws {RangeError} on an invalid `count`, or when every pixel is transparent.
 */
export function extractPalette(image: PixelBuffer, options: PaletteOptions = {}): PaletteResult {
  assertPixelBuffer(image);
  const requested = options.count ?? 8;
  if (!Number.isInteger(requested) || requested < MIN_PALETTE_SIZE || requested > MAX_PALETTE_SIZE) {
    throw new RangeError(`count must be a whole number from ${MIN_PALETTE_SIZE} to ${MAX_PALETTE_SIZE}`);
  }
  const maxSamples = Math.max(1, Math.floor(options.maxSamples ?? 20_000));
  const maxIterations = Math.max(1, Math.floor(options.maxIterations ?? 40));
  const mergeDeltaE = options.mergeDeltaE ?? 2.5;
  const minAlpha = options.minAlpha ?? 128;
  const random = createRandom(options.seed ?? 1);
  const { data, width, height } = image;

  // -- 1. sample --------------------------------------------------------------
  const stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / maxSamples)));
  const capacity = Math.ceil(width / stride) * Math.ceil(height / stride);
  const L = new Float64Array(capacity);
  const A = new Float64Array(capacity);
  const B = new Float64Array(capacity);
  let n = 0;
  // Start half a stride in, so samples sit in cell centres rather than on the top-left edge.
  const start = Math.floor(stride / 2);
  for (let y = Math.min(start, height - 1); y < height; y += stride) {
    for (let x = Math.min(start, width - 1); x < width; x += stride) {
      const offset = (y * width + x) * 4;
      if ((data[offset + 3] as number) < minAlpha) continue;
      let linear: [number, number, number] = [
        SRGB8_TO_LINEAR[data[offset] as number] as number,
        SRGB8_TO_LINEAR[data[offset + 1] as number] as number,
        SRGB8_TO_LINEAR[data[offset + 2] as number] as number,
      ];
      if (options.whiteBalance !== undefined) linear = applyMatrix(options.whiteBalance, linear);
      const lab = xyzToLab(linearRgbToXyz(linear));
      L[n] = lab[0];
      A[n] = lab[1];
      B[n] = lab[2];
      n += 1;
    }
  }
  if (n === 0) throw new RangeError('The image has no opaque pixels to build a palette from');

  // -- 2. k-means++ seeding ---------------------------------------------------
  const centreL: number[] = [];
  const centreA: number[] = [];
  const centreB: number[] = [];
  const nearest = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const addCentre = (index: number): number => {
    const cl = L[index] as number;
    const ca = A[index] as number;
    const cb = B[index] as number;
    centreL.push(cl);
    centreA.push(ca);
    centreB.push(cb);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dl = (L[i] as number) - cl;
      const da = (A[i] as number) - ca;
      const db = (B[i] as number) - cb;
      const distance = dl * dl + da * da + db * db;
      if (distance < (nearest[i] as number)) nearest[i] = distance;
      total += nearest[i] as number;
    }
    return total;
  };
  let total = addCentre(Math.floor(random() * n));
  // Stop early when every sample already coincides with a centre.
  while (centreL.length < requested && total > 1e-9) {
    let target = random() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      target -= nearest[i] as number;
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    total = addCentre(chosen);
  }

  // -- 3. Lloyd iterations ----------------------------------------------------
  let k = centreL.length;
  const assignment = new Int32Array(n).fill(-1);
  let counts = new Float64Array(k);
  let iterations = 0;
  for (; iterations < maxIterations; ) {
    iterations += 1;
    let changed = 0;
    const sumL = new Float64Array(k);
    const sumA = new Float64Array(k);
    const sumB = new Float64Array(k);
    counts = new Float64Array(k);
    for (let i = 0; i < n; i++) {
      const l = L[i] as number;
      const a = A[i] as number;
      const b = B[i] as number;
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let c = 0; c < k; c++) {
        const dl = l - (centreL[c] as number);
        const da = a - (centreA[c] as number);
        const db = b - (centreB[c] as number);
        const distance = dl * dl + da * da + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = c;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        changed += 1;
      }
      sumL[best] = (sumL[best] as number) + l;
      sumA[best] = (sumA[best] as number) + a;
      sumB[best] = (sumB[best] as number) + b;
      counts[best] = (counts[best] as number) + 1;
    }
    for (let c = 0; c < k; c++) {
      const count = counts[c] as number;
      if (count === 0) continue; // an emptied cluster keeps its place and is dropped at the end
      centreL[c] = (sumL[c] as number) / count;
      centreA[c] = (sumA[c] as number) / count;
      centreB[c] = (sumB[c] as number) / count;
    }
    if (changed === 0) break;
  }

  // -- 4. drop empties, merge near-duplicates ---------------------------------
  let clusters: Array<{ l: number; a: number; b: number; count: number }> = [];
  for (let c = 0; c < k; c++) {
    const count = counts[c] as number;
    if (count > 0) clusters.push({ l: centreL[c] as number, a: centreA[c] as number, b: centreB[c] as number, count });
  }
  if (mergeDeltaE > 0) {
    for (;;) {
      let bestI = -1;
      let bestJ = -1;
      let bestDistance = mergeDeltaE;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const p = clusters[i] as (typeof clusters)[number];
          const q = clusters[j] as (typeof clusters)[number];
          const distance = deltaE2000Components(p.l, p.a, p.b, q.l, q.a, q.b);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestI = i;
            bestJ = j;
          }
        }
      }
      if (bestI < 0) break;
      const p = clusters[bestI] as (typeof clusters)[number];
      const q = clusters[bestJ] as (typeof clusters)[number];
      const count = p.count + q.count;
      clusters[bestI] = {
        l: (p.l * p.count + q.l * q.count) / count,
        a: (p.a * p.count + q.a * q.count) / count,
        b: (p.b * p.count + q.b * q.count) / count,
        count,
      };
      clusters = clusters.filter((_, index) => index !== bestJ);
    }
  }
  k = clusters.length;

  clusters.sort((p, q) => q.count - p.count || q.l - p.l);
  return {
    swatches: clusters.map((cluster) => ({
      color: colorFromLab([cluster.l, cluster.a, cluster.b]),
      population: cluster.count / n,
    })),
    sampleCount: n,
    iterations,
  };
}
