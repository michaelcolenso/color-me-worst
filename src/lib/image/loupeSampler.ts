/**
 * De-noised colour sampling.
 *
 * A single photo pixel is a poor estimate of a surface's colour: sensor noise,
 * JPEG artefacts, a speck of glare or a hairline shadow can each move it by
 * several ΔE. The sampler reads a small square around the chosen point,
 * throws out the pixels that do not belong, and reports the median of the
 * rest.
 *
 * Steps
 *   1. Collect the kernel's pixels, skipping transparent ones and any pixel
 *      with a channel at 0 or 255 (the sensor clipped; the true colour is unknown).
 *   2. Convert to CIELAB (after white balance, when a correction is supplied).
 *   3. Tukey fences: drop pixels outside [Q1 − 1.5·IQR, Q3 + 1.5·IQR] on L*,
 *      a* or b*. Specular highlights and shadows are lightness outliers;
 *      coloured reflections and edge bleed are outliers on the two colour axes.
 *   4. Return the component-wise median in CIELAB.
 */

import { colorFromLab, linearRgbToXyz, xyzToLab } from '../color/colorConversions';
import { deltaE2000Components } from '../color/deltaE2000';
import type { ColorCoordinates } from '../color/types';
import { SRGB8_TO_LINEAR, applyMatrix, assertPixelBuffer, type Matrix3, type PixelBuffer } from './pixelMath';

export interface LoupeOptions {
  /**
   * Side of the sampled square in pixels: a positive odd whole number.
   * 5 suits fine detail, 11 suits flat areas. Default 5.
   */
  kernel?: number;
  /** White-balance correction to apply to every pixel before measuring (see whiteBalance.ts). */
  whiteBalance?: Matrix3;
  /** Tukey fence multiplier. Default 1.5; larger keeps more pixels. */
  fence?: number;
  /** Pixels with alpha below this (0–255) are ignored. Default 128. */
  minAlpha?: number;
}

export interface LoupeSample {
  /** Median colour of the pixels that were kept. */
  color: ColorCoordinates;
  /** Pixels inside the kernel and inside the image. */
  pixelCount: number;
  /** Pixels that contributed to the result. */
  usedCount: number;
  /** Pixels discarded as transparent, clipped or outliers. */
  rejectedCount: number;
  /**
   * Mean ΔE00 between the kept pixels and the result. Near 0 for a flat,
   * clean area; above about 3 the kernel is straddling an edge or texture
   * and the sample deserves less trust.
   */
  spread: number;
}

/** Linear-interpolated quantile of an ascending-sorted array. */
function quantile(sorted: Float64Array, q: number): number {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  return lower === upper ? low : low + ((sorted[upper] as number) - low) * (position - lower);
}

function validateKernel(kernel: number): void {
  if (!Number.isInteger(kernel) || kernel < 1 || kernel % 2 === 0) {
    throw new RangeError(`kernel must be a positive odd whole number; received ${kernel}`);
  }
}

/**
 * Sample the colour at an image position.
 *
 * @param x Column in image pixels (0 is the left edge). Fractions are rounded.
 * @param y Row in image pixels (0 is the top edge).
 * @throws {RangeError} when the point is outside the image, the kernel is
 *   invalid, or every pixel under the kernel is transparent.
 */
export function sampleLoupe(image: PixelBuffer, x: number, y: number, options: LoupeOptions = {}): LoupeSample {
  assertPixelBuffer(image);
  const kernel = options.kernel ?? 5;
  validateKernel(kernel);
  const fence = options.fence ?? 1.5;
  const minAlpha = options.minAlpha ?? 128;
  const { data, width, height } = image;
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (!(cx >= 0 && cx < width && cy >= 0 && cy < height)) {
    throw new RangeError(`Sample point (${x}, ${y}) is outside the ${width} x ${height} image`);
  }

  const half = (kernel - 1) / 2;
  const x0 = Math.max(0, cx - half);
  const x1 = Math.min(width - 1, cx + half);
  const y0 = Math.max(0, cy - half);
  const y1 = Math.min(height - 1, cy + half);
  const pixelCount = (x1 - x0 + 1) * (y1 - y0 + 1);

  const labL = new Float64Array(pixelCount);
  const labA = new Float64Array(pixelCount);
  const labB = new Float64Array(pixelCount);
  /** 0 = usable, 1 = clipped (kept only as a fallback), 2 = transparent. */
  const status = new Uint8Array(pixelCount);
  let opaque = 0;
  let unclipped = 0;
  let index = 0;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++, index++) {
      const offset = (py * width + px) * 4;
      if ((data[offset + 3] as number) < minAlpha) {
        status[index] = 2;
        continue;
      }
      opaque += 1;
      const r8 = data[offset] as number;
      const g8 = data[offset + 1] as number;
      const b8 = data[offset + 2] as number;
      const clipped = r8 === 0 || g8 === 0 || b8 === 0 || r8 === 255 || g8 === 255 || b8 === 255;
      if (clipped) status[index] = 1;
      else unclipped += 1;
      let linear: [number, number, number] = [
        SRGB8_TO_LINEAR[r8] as number,
        SRGB8_TO_LINEAR[g8] as number,
        SRGB8_TO_LINEAR[b8] as number,
      ];
      if (options.whiteBalance !== undefined) linear = applyMatrix(options.whiteBalance, linear);
      const lab = xyzToLab(linearRgbToXyz(linear));
      labL[index] = lab[0];
      labA[index] = lab[1];
      labB[index] = lab[2];
    }
  }
  if (opaque === 0) throw new RangeError(`Every pixel under the loupe at (${x}, ${y}) is transparent`);

  // Genuinely black or white areas are all "clipped"; fall back to them
  // rather than failing, since there is nothing better to measure.
  const acceptStatus = unclipped > 0 ? 0 : 1;
  let candidates: number[] = [];
  for (let i = 0; i < pixelCount; i++) if (status[i] === acceptStatus) candidates.push(i);

  // Tukey fences need a few points to mean anything.
  if (candidates.length >= 4 && fence >= 0) {
    const fences = [labL, labA, labB].map((channel) => {
      const sorted = Float64Array.from(candidates, (i) => channel[i] as number).sort();
      const q1 = quantile(sorted, 0.25);
      const q3 = quantile(sorted, 0.75);
      // A floor on the range keeps a perfectly flat patch from rejecting
      // pixels that differ by one code value.
      const reach = fence * Math.max(q3 - q1, 0.5);
      return [q1 - reach, q3 + reach] as const;
    });
    const kept = candidates.filter((i) =>
      [labL, labA, labB].every((channel, c) => {
        const value = channel[i] as number;
        const [low, high] = fences[c] as readonly [number, number];
        return value >= low && value <= high;
      }),
    );
    if (kept.length > 0) candidates = kept;
  }

  const median = [labL, labA, labB].map((channel) =>
    quantile(Float64Array.from(candidates, (i) => channel[i] as number).sort(), 0.5),
  ) as [number, number, number];

  let spreadSum = 0;
  for (const i of candidates) {
    spreadSum += deltaE2000Components(
      median[0],
      median[1],
      median[2],
      labL[i] as number,
      labA[i] as number,
      labB[i] as number,
    );
  }

  return {
    color: colorFromLab(median),
    pixelCount,
    usedCount: candidates.length,
    rejectedCount: pixelCount - candidates.length,
    spread: spreadSum / candidates.length,
  };
}

/**
 * Copy the square of pixels under the loupe, for drawing a magnified preview.
 * Positions outside the image are returned fully transparent, so the result
 * is always `kernel` x `kernel` with the chosen point at its centre.
 */
export function extractLoupePatch(image: PixelBuffer, x: number, y: number, kernel: number): PixelBuffer {
  assertPixelBuffer(image);
  validateKernel(kernel);
  const { data, width, height } = image;
  const half = (kernel - 1) / 2;
  const cx = Math.round(x);
  const cy = Math.round(y);
  const out = new Uint8ClampedArray(kernel * kernel * 4);
  for (let row = 0; row < kernel; row++) {
    const py = cy - half + row;
    if (py < 0 || py >= height) continue;
    for (let col = 0; col < kernel; col++) {
      const px = cx - half + col;
      if (px < 0 || px >= width) continue;
      const from = (py * width + px) * 4;
      const to = (row * kernel + col) * 4;
      out[to] = data[from] as number;
      out[to + 1] = data[from + 1] as number;
      out[to + 2] = data[from + 2] as number;
      out[to + 3] = data[from + 3] as number;
    }
  }
  return { data: out, width: kernel, height: kernel };
}
