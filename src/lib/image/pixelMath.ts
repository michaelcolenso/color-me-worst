/**
 * Shared low-level helpers for the image pipeline: the pixel buffer shape,
 * fast sRGB transfer tables, 3 x 3 matrices and a seeded random generator.
 * No DOM access, so everything here runs in a Web Worker or in Node.
 */

import { LINEAR_SRGB_TO_XYZ, XYZ_TO_LINEAR_SRGB, linearChannelToSrgb, srgbChannelToLinear } from '../color/colorConversions';
import type { ReadonlyVec3, Vec3 } from '../color/types';

/**
 * RGBA pixels, 8 bits per channel, row-major, not premultiplied. This is the
 * shape of the DOM's `ImageData`, so one can be passed directly.
 */
export interface PixelBuffer {
  readonly data: Uint8ClampedArray | Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Row-major 3 x 3 matrix. */
export type Matrix3 = readonly [ReadonlyVec3, ReadonlyVec3, ReadonlyVec3];

export const IDENTITY_MATRIX: Matrix3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export const RGB_TO_XYZ: Matrix3 = LINEAR_SRGB_TO_XYZ;
export const XYZ_TO_RGB: Matrix3 = XYZ_TO_LINEAR_SRGB;

/** @throws {RangeError} when the buffer's size does not match its dimensions. */
export function assertPixelBuffer(image: PixelBuffer): void {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`Invalid image size ${width} x ${height}`);
  }
  if (data.length !== width * height * 4) {
    throw new RangeError(`Image data has ${data.length} bytes; expected ${width * height * 4} for ${width} x ${height} RGBA`);
  }
}

export function multiplyMatrices(a: Matrix3, b: Matrix3): Matrix3 {
  const row = (i: 0 | 1 | 2): Vec3 => [
    a[i][0] * b[0][0] + a[i][1] * b[1][0] + a[i][2] * b[2][0],
    a[i][0] * b[0][1] + a[i][1] * b[1][1] + a[i][2] * b[2][1],
    a[i][0] * b[0][2] + a[i][1] * b[1][2] + a[i][2] * b[2][2],
  ];
  return [row(0), row(1), row(2)];
}

export function applyMatrix(m: Matrix3, v: ReadonlyVec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** @throws {RangeError} when the matrix is singular. */
export function invertMatrix(m: Matrix3): Matrix3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new RangeError('Matrix is singular');
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

/** Linear-light value for each 8-bit sRGB code. */
export const SRGB8_TO_LINEAR: Float64Array = (() => {
  const table = new Float64Array(256);
  for (let code = 0; code < 256; code++) table[code] = srgbChannelToLinear(code / 255);
  return table;
})();

const ENCODE_STEPS = 4095;

/**
 * 8-bit sRGB code for a linear value, indexed by `round(sqrt(linear) * 4095)`.
 * Indexing by the square root spends the table's resolution where the sRGB
 * curve is steep (near black), so the lookup matches exact encoding to within
 * one code value everywhere and avoids a `pow` per channel per pixel.
 */
const LINEAR_TO_SRGB8: Uint8Array = (() => {
  const table = new Uint8Array(ENCODE_STEPS + 1);
  for (let index = 0; index <= ENCODE_STEPS; index++) {
    const linear = (index / ENCODE_STEPS) ** 2;
    table[index] = Math.round(linearChannelToSrgb(linear) * 255);
  }
  return table;
})();

/** Encode one linear-light channel to an 8-bit sRGB code, clamping to 0–255. */
export function linearToSrgb8(linear: number): number {
  if (!(linear > 0)) return 0; // also catches NaN
  if (linear >= 1) return 255;
  return LINEAR_TO_SRGB8[Math.round(Math.sqrt(linear) * ENCODE_STEPS)] as number;
}

/** Deterministic PRNG (mulberry32): the same seed always gives the same sequence. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
