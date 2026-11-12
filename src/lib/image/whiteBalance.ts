/**
 * White balance for reference photos.
 *
 * A photo taken under a warm lamp or cool window records every colour with
 * that light's cast. Matching paint to those pixels would match the cast, not
 * the object. White balance removes it by chromatic adaptation: estimate the
 * colour of the light, then transform every colour to what it would look like
 * under D65, the white that sRGB and the rest of the engine assume.
 *
 * The transform is a von Kries adaptation: convert to a cone-like space,
 * scale the three channels independently so the light becomes neutral, and
 * convert back. Three variants are offered:
 *   - `bradford` (default): sharpened Bradford primaries. The standard model
 *     of how surface colours shift when the light changes.
 *   - `von_kries`: the classic Hunt-Pointer-Estevez cone primaries.
 *   - `channel_gain`: scales linear red, green and blue directly. This is
 *     what a camera's own white balance does, so it is the exact inverse when
 *     the cast came from the camera choosing the wrong setting rather than
 *     from the light itself.
 * A real photo's cast is usually a mixture of both causes, so neither model
 * is exact; with a grey reference all three make the reference neutral and
 * differ only in how they treat saturated colours.
 *
 * Two ways to estimate the light:
 *   - from a reference: the user clicks something known to be neutral (a grey
 *     card, white paper, primer). This is the accurate route.
 *   - automatically: from image statistics. Useful with no neutral in shot,
 *     but it is a guess and fails on scenes dominated by one colour.
 *
 * A correction is a 3 x 3 matrix on linear-light sRGB. Apply it to the whole
 * image with {@link applyWhiteBalance}, or pass it to the loupe sampler and
 * palette extractor, which correct on the fly without rewriting the image.
 */

import { D65_WHITE, labToXyz, xyzToLab, xyzToLinearRgb } from '../color/colorConversions';
import type { ReadonlyVec3, Vec3 } from '../color/types';
import { sampleLoupe } from './loupeSampler';
import {
  RGB_TO_XYZ,
  SRGB8_TO_LINEAR,
  XYZ_TO_RGB,
  applyMatrix,
  assertPixelBuffer,
  createRandom,
  invertMatrix,
  linearToSrgb8,
  multiplyMatrices,
  type Matrix3,
  type PixelBuffer,
} from './pixelMath';

/** Cone spaces available for a von Kries chromatic adaptation. */
export type ConeSpace = 'bradford' | 'von_kries';

export type AdaptationMethod = ConeSpace | 'channel_gain';

/**
 * XYZ -> cone-response matrices, as published in the colour-science project
 * (colour/adaptation/datasets/cat.py), which reproduces the original sources.
 */
const CONE_MATRICES: Readonly<Record<ConeSpace, Matrix3>> = {
  bradford: [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
  ],
  von_kries: [
    [0.40024, 0.7076, -0.08081],
    [-0.2263, 1.16532, 0.0457],
    [0, 0, 0.91822],
  ],
};

/**
 * Matrix that adapts XYZ colours seen under `sourceWhite` to their appearance
 * under `targetWhite`. Both whites are XYZ; only their chromaticity matters.
 * @throws {RangeError} when a white has a zero or negative cone response.
 */
export function chromaticAdaptationMatrix(
  sourceWhite: ReadonlyVec3,
  targetWhite: ReadonlyVec3,
  method: ConeSpace = 'bradford',
): Matrix3 {
  const cone = CONE_MATRICES[method];
  const source = applyMatrix(cone, sourceWhite);
  const target = applyMatrix(cone, targetWhite);
  if (source.some((value) => !(value > 0)) || target.some((value) => !(value > 0))) {
    throw new RangeError('White point is not a physically plausible light');
  }
  const scale: Matrix3 = [
    [target[0] / source[0], 0, 0],
    [0, target[1] / source[1], 0],
    [0, 0, target[2] / source[2]],
  ];
  return multiplyMatrices(invertMatrix(cone), multiplyMatrices(scale, cone));
}

export interface WhiteBalance {
  /** Correction for linear-light sRGB: corrected = matrix · original. */
  matrix: Matrix3;
  /** Estimated colour of the scene's light as XYZ with Y = 1. */
  sourceWhite: Vec3;
  /** Exposure gain folded into the matrix. 1 unless a reference lightness was requested. */
  gain: number;
  /**
   * CIELAB chroma of the reference before correction: how strong the cast
   * was. A lamp-lit photo is typically 5–30. Above about 40 the "neutral"
   * was probably a coloured object, and the correction should be questioned.
   */
  castChroma: number;
  method: AdaptationMethod;
}

export interface WhiteBalanceOptions {
  /** Default `bradford`. */
  method?: AdaptationMethod;
  /**
   * Also correct exposure so the reference ends up at this CIELAB L*
   * (0–100). Use it when the reference's true lightness is known, e.g. about
   * 50 for an 18 % grey card or about 95 for white paper. Omit to leave
   * exposure untouched.
   */
  referenceLightness?: number;
}

/** A correction that changes nothing. */
export const NO_WHITE_BALANCE: WhiteBalance = {
  matrix: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  sourceWhite: [D65_WHITE[0], D65_WHITE[1], D65_WHITE[2]],
  gain: 1,
  castChroma: 0,
  method: 'bradford',
};

/**
 * Build the correction that makes a given colour neutral.
 *
 * @param neutralLinearRgb Linear-light sRGB of something that should be grey
 *   or white, as recorded in the photo.
 * @throws {RangeError} when the reference is too dark to measure reliably, is
 *   overexposed, or has a channel at or below zero.
 */
export function whiteBalanceFromNeutral(
  neutralLinearRgb: ReadonlyVec3,
  options: WhiteBalanceOptions = {},
): WhiteBalance {
  const method = options.method ?? 'bradford';
  if (neutralLinearRgb.some((channel) => !(channel > 0))) {
    throw new RangeError('The neutral reference has a channel at zero; pick a lighter point');
  }
  if (Math.max(...neutralLinearRgb) >= 0.98) {
    throw new RangeError('The neutral reference is overexposed; pick a point that is not blown out');
  }
  const xyz = applyMatrix(RGB_TO_XYZ, neutralLinearRgb);
  const luminance = xyz[1];
  if (luminance < 0.01) {
    throw new RangeError('The neutral reference is too dark to measure reliably; pick a lighter point');
  }
  const sourceWhite: Vec3 = [xyz[0] / luminance, 1, xyz[2] / luminance];

  let gain = 1;
  if (options.referenceLightness !== undefined) {
    const target = options.referenceLightness;
    if (!(target > 0 && target <= 100)) throw new RangeError('referenceLightness must be above 0 and at most 100');
    gain = labToXyz([target, 0, 0])[1] / luminance;
  }

  // Either way the reference maps to equal red, green and blue at its
  // original luminance.
  const rgbMatrix: Matrix3 =
    method === 'channel_gain'
      ? [
          [luminance / neutralLinearRgb[0], 0, 0],
          [0, luminance / neutralLinearRgb[1], 0],
          [0, 0, luminance / neutralLinearRgb[2]],
        ]
      : multiplyMatrices(
          XYZ_TO_RGB,
          multiplyMatrices(chromaticAdaptationMatrix(sourceWhite, D65_WHITE, method), RGB_TO_XYZ),
        );
  const matrix = rgbMatrix.map((row) => row.map((value) => value * gain)) as unknown as Matrix3;
  const lab = xyzToLab(xyz);
  return { matrix, sourceWhite, gain, castChroma: Math.hypot(lab[1], lab[2]), method };
}

export interface PointWhiteBalanceOptions extends WhiteBalanceOptions {
  /** Side of the square sampled around the clicked point, odd. Default 11. */
  kernel?: number;
}

/**
 * Build a correction from a point the user clicked on something neutral.
 * The point is read with the de-noised loupe sampler, so a little texture or
 * a dust speck on the grey card does not throw the result off.
 *
 * @throws {RangeError} when the point is outside the image, or the reference
 *   is too dark or overexposed.
 */
export function whiteBalanceFromPoint(
  image: PixelBuffer,
  x: number,
  y: number,
  options: PointWhiteBalanceOptions = {},
): WhiteBalance {
  const sample = sampleLoupe(image, x, y, { kernel: options.kernel ?? 11 });
  const linear = xyzToLinearRgb(labToXyz(sample.color.lab));
  return whiteBalanceFromNeutral(linear, options);
}

/**
 * - `shades_of_gray`: Minkowski-norm average (Finlayson & Trezzi). A
 *   compromise between the two below, and the default.
 * - `gray_world`: assumes the scene averages to grey.
 * - `white_patch`: assumes the brightest areas are white.
 */
export type IlluminantEstimator = 'shades_of_gray' | 'gray_world' | 'white_patch';

export interface AutoWhiteBalanceOptions {
  /** Default `shades_of_gray`. */
  estimator?: IlluminantEstimator;
  /** Minkowski norm for `shades_of_gray`. Default 6. */
  norm?: number;
  /** Upper limit on pixels examined; larger images are sampled on a jittered grid. Default 250 000. */
  maxSamples?: number;
  /** Default `bradford`. */
  method?: AdaptationMethod;
}

/**
 * Estimate the colour of the scene's light from image statistics.
 * Transparent pixels and pixels with any channel clipped at 255 are ignored.
 *
 * @returns Linear-light sRGB of the estimated light, scaled so its largest channel is 1.
 * @throws {RangeError} when no usable pixels remain.
 */
export function estimateIlluminant(image: PixelBuffer, options: AutoWhiteBalanceOptions = {}): Vec3 {
  assertPixelBuffer(image);
  const estimator = options.estimator ?? 'shades_of_gray';
  const { data, width, height } = image;
  const maxSamples = Math.max(1, options.maxSamples ?? 250_000);
  const stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / maxSamples)));
  // One pixel at a seeded random position per grid cell, so a repeating
  // texture cannot line up with the sampling grid. Deterministic.
  const random = createRandom(1);
  const jitter = stride === 1 ? () => 0 : () => Math.floor(random() * stride);

  let estimate: Vec3;
  if (estimator === 'white_patch') {
    // 99th percentile per channel: robust to a few stray bright pixels.
    const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)] as const;
    let count = 0;
    for (let cellY = 0; cellY < height; cellY += stride) {
      for (let cellX = 0; cellX < width; cellX += stride) {
        const x = Math.min(width - 1, cellX + jitter());
        const y = Math.min(height - 1, cellY + jitter());
        const offset = (y * width + x) * 4;
        if ((data[offset + 3] as number) < 128) continue;
        const r = data[offset] as number;
        const g = data[offset + 1] as number;
        const b = data[offset + 2] as number;
        if (r === 255 || g === 255 || b === 255) continue;
        histograms[0][r] = (histograms[0][r] as number) + 1;
        histograms[1][g] = (histograms[1][g] as number) + 1;
        histograms[2][b] = (histograms[2][b] as number) + 1;
        count += 1;
      }
    }
    if (count === 0) throw new RangeError('No usable pixels to estimate the light from');
    const percentile = (histogram: Uint32Array): number => {
      let remaining = Math.max(1, Math.round(count * 0.01));
      for (let code = 255; code >= 0; code--) {
        remaining -= histogram[code] as number;
        if (remaining <= 0) return SRGB8_TO_LINEAR[code] as number;
      }
      return 0;
    };
    estimate = [percentile(histograms[0]), percentile(histograms[1]), percentile(histograms[2])];
  } else {
    const norm = estimator === 'gray_world' ? 1 : (options.norm ?? 6);
    if (!(norm >= 1)) throw new RangeError('norm must be at least 1');
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;
    for (let cellY = 0; cellY < height; cellY += stride) {
      for (let cellX = 0; cellX < width; cellX += stride) {
        const x = Math.min(width - 1, cellX + jitter());
        const y = Math.min(height - 1, cellY + jitter());
        const offset = (y * width + x) * 4;
        if ((data[offset + 3] as number) < 128) continue;
        const r = data[offset] as number;
        const g = data[offset + 1] as number;
        const b = data[offset + 2] as number;
        if (r === 255 || g === 255 || b === 255) continue;
        sumR += Math.pow(SRGB8_TO_LINEAR[r] as number, norm);
        sumG += Math.pow(SRGB8_TO_LINEAR[g] as number, norm);
        sumB += Math.pow(SRGB8_TO_LINEAR[b] as number, norm);
        count += 1;
      }
    }
    if (count === 0) throw new RangeError('No usable pixels to estimate the light from');
    estimate = [
      Math.pow(sumR / count, 1 / norm),
      Math.pow(sumG / count, 1 / norm),
      Math.pow(sumB / count, 1 / norm),
    ];
  }

  const peak = Math.max(...estimate);
  if (!(peak > 0) || estimate.some((channel) => !(channel > 0))) {
    throw new RangeError('The image is too dark, or lacks a colour channel entirely, to estimate the light');
  }
  return [estimate[0] / peak, estimate[1] / peak, estimate[2] / peak];
}

/**
 * Build a correction from image statistics, with no reference point.
 * Exposure is left unchanged. See {@link IlluminantEstimator} for the
 * assumptions each method makes; all of them are wrong for some photos.
 */
export function autoWhiteBalance(image: PixelBuffer, options: AutoWhiteBalanceOptions = {}): WhiteBalance {
  const light = estimateIlluminant(image, options);
  // Scale below the overexposure guard; only the chromaticity is used.
  const scaled: Vec3 = [light[0] * 0.5, light[1] * 0.5, light[2] * 0.5];
  return whiteBalanceFromNeutral(scaled, options.method !== undefined ? { method: options.method } : {});
}

function matrixOf(correction: WhiteBalance | Matrix3): Matrix3 {
  return Array.isArray(correction) ? (correction as Matrix3) : (correction as WhiteBalance).matrix;
}

/** Correct one linear-light sRGB colour. The result may fall outside [0, 1]. */
export function correctLinearRgb(linear: ReadonlyVec3, correction: WhiteBalance | Matrix3): Vec3 {
  return applyMatrix(matrixOf(correction), linear);
}

/**
 * Return a corrected copy of an image. The input is not modified. Colours
 * pushed outside the display range are clipped; alpha is copied unchanged.
 */
export function applyWhiteBalance(image: PixelBuffer, correction: WhiteBalance | Matrix3): PixelBuffer {
  assertPixelBuffer(image);
  const [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]] = matrixOf(correction);
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(data.length);
  // Local aliases: see the note on hot-loop constants in pigmentMixer.ts.
  const decode = SRGB8_TO_LINEAR;
  const linearToSrgb8Local = linearToSrgb8;
  for (let offset = 0; offset < data.length; offset += 4) {
    const r = decode[data[offset] as number] as number;
    const g = decode[data[offset + 1] as number] as number;
    const b = decode[data[offset + 2] as number] as number;
    out[offset] = linearToSrgb8Local(m00 * r + m01 * g + m02 * b);
    out[offset + 1] = linearToSrgb8Local(m10 * r + m11 * g + m12 * b);
    out[offset + 2] = linearToSrgb8Local(m20 * r + m21 * g + m22 * b);
    out[offset + 3] = data[offset + 3] as number;
  }
  return { data: out, width, height };
}
