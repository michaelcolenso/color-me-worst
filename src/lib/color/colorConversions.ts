/**
 * Deterministic colour-space conversions. Zero dependencies.
 *
 *   sRGB (8-bit / hex)  <->  linear-light sRGB  <->  CIE XYZ (D65)
 *   CIE XYZ (D65)       <->  CIELAB (D65)       <->  LCh(ab)
 *   CIE XYZ (D65)       <->  OKLab              <->  OKLCh
 *
 * Conventions
 * - XYZ is relative: Y = 1 for the reference white.
 * - The reference white is the D65 white of the sRGB specification
 *   (chromaticity x = 0.3127, y = 0.3290). Every matrix in this file is derived
 *   from that one white so sRGB white is exactly L* = 100, a* = b* = 0 and
 *   exactly OKLab L = 1, a = b = 0. This is the CSS Color 4 convention.
 * - Hue angles are degrees in [0, 360).
 * - Low-level functions are not clamped: out-of-gamut values pass through so
 *   round trips stay exact. Only the 8-bit / hex encoders clamp.
 */

import type { ColorCoordinates, ReadonlyVec3, Vec3 } from './types';

type Matrix3 = readonly [ReadonlyVec3, ReadonlyVec3, ReadonlyVec3];

// ---------------------------------------------------------------------------
// 3 x 3 helpers
// ---------------------------------------------------------------------------

function multiplyMatrixVector(m: Matrix3, v: ReadonlyVec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function invertMatrix(m: Matrix3): Matrix3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('Matrix is singular');
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

function chromaticityToXyz(x: number, y: number): Vec3 {
  return [x / y, 1, (1 - x - y) / y];
}

// ---------------------------------------------------------------------------
// Reference white and the sRGB <-> XYZ matrices
// ---------------------------------------------------------------------------

/** D65 white point as XYZ with Y = 1, from the sRGB chromaticity (0.3127, 0.3290). */
export const D65_WHITE: ReadonlyVec3 = chromaticityToXyz(0.3127, 0.329);

/**
 * Linear sRGB -> XYZ, derived from the sRGB primaries rather than typed in as
 * rounded decimals, so the forward and inverse matrices agree to machine
 * precision. Primaries (IEC 61966-2-1): R (0.64, 0.33), G (0.30, 0.60),
 * B (0.15, 0.06).
 */
export const LINEAR_SRGB_TO_XYZ: Matrix3 = (() => {
  const r = chromaticityToXyz(0.64, 0.33);
  const g = chromaticityToXyz(0.3, 0.6);
  const b = chromaticityToXyz(0.15, 0.06);
  const primaries: Matrix3 = [
    [r[0], g[0], b[0]],
    [r[1], g[1], b[1]],
    [r[2], g[2], b[2]],
  ];
  const s = multiplyMatrixVector(invertMatrix(primaries), D65_WHITE);
  return [
    [r[0] * s[0], g[0] * s[1], b[0] * s[2]],
    [r[1] * s[0], g[1] * s[1], b[1] * s[2]],
    [r[2] * s[0], g[2] * s[1], b[2] * s[2]],
  ];
})();

export const XYZ_TO_LINEAR_SRGB: Matrix3 = invertMatrix(LINEAR_SRGB_TO_XYZ);

// ---------------------------------------------------------------------------
// sRGB transfer function
// ---------------------------------------------------------------------------

/**
 * Decode one gamma-encoded sRGB channel (0–1) to linear light.
 * Extended to negative inputs by odd symmetry.
 */
export function srgbChannelToLinear(encoded: number): number {
  const magnitude = Math.abs(encoded);
  const linear = magnitude <= 0.04045 ? magnitude / 12.92 : Math.pow((magnitude + 0.055) / 1.055, 2.4);
  return encoded < 0 ? -linear : linear;
}

/**
 * Encode one linear-light channel (0–1) to gamma-encoded sRGB.
 * Extended to negative inputs by odd symmetry.
 */
export function linearChannelToSrgb(linear: number): number {
  const magnitude = Math.abs(linear);
  const encoded = magnitude <= 0.0031308 ? magnitude * 12.92 : 1.055 * Math.pow(magnitude, 1 / 2.4) - 0.055;
  return linear < 0 ? -encoded : encoded;
}

/** 8-bit sRGB (0–255 per channel) -> linear-light sRGB (0–1 per channel). */
export function rgb8ToLinearRgb(rgb: ReadonlyVec3): Vec3 {
  return [srgbChannelToLinear(rgb[0] / 255), srgbChannelToLinear(rgb[1] / 255), srgbChannelToLinear(rgb[2] / 255)];
}

function encodeChannel8(linear: number): number {
  const encoded = linearChannelToSrgb(linear) * 255;
  if (!(encoded > 0)) return 0; // also catches NaN
  return encoded >= 255 ? 255 : Math.round(encoded);
}

/** Linear-light sRGB -> 8-bit sRGB. Out-of-gamut channels are clamped to 0–255. */
export function linearRgbToRgb8(linear: ReadonlyVec3): Vec3 {
  return [encodeChannel8(linear[0]), encodeChannel8(linear[1]), encodeChannel8(linear[2])];
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

const HEX_PATTERN = /^#?(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i;

/** True for `#rgb`, `#rrggbb`, and the same without the leading `#`. */
export function isValidHex(hex: string): boolean {
  return HEX_PATTERN.test(hex.trim());
}

/**
 * Parse `#rgb` or `#rrggbb` (the `#` is optional, case-insensitive) into 8-bit sRGB.
 * @throws {RangeError} when the string is not a valid hex colour.
 */
export function hexToRgb8(hex: string): Vec3 {
  const match = HEX_PATTERN.exec(hex.trim());
  if (!match) throw new RangeError(`Invalid hex colour: "${hex}"`);
  const short = match[1];
  const digits = short !== undefined ? short.replace(/./g, '$&$&') : (match[2] as string);
  const value = Number.parseInt(digits, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** 8-bit sRGB -> lower-case `#rrggbb`. Channels are rounded and clamped to 0–255. */
export function rgb8ToHex(rgb: ReadonlyVec3): string {
  let out = '#';
  for (const channel of rgb) {
    const clamped = Math.min(255, Math.max(0, Math.round(channel)));
    out += (clamped < 16 ? '0' : '') + clamped.toString(16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Linear sRGB <-> XYZ
// ---------------------------------------------------------------------------

export function linearRgbToXyz(linear: ReadonlyVec3): Vec3 {
  return multiplyMatrixVector(LINEAR_SRGB_TO_XYZ, linear);
}

export function xyzToLinearRgb(xyz: ReadonlyVec3): Vec3 {
  return multiplyMatrixVector(XYZ_TO_LINEAR_SRGB, xyz);
}

// ---------------------------------------------------------------------------
// XYZ <-> CIELAB
// ---------------------------------------------------------------------------

/** CIE standard constants as exact rationals (avoids the 0.008856 / 903.3 discontinuity). */
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

function labForward(t: number): number {
  return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

function labInverse(f: number): number {
  const cubed = f * f * f;
  return cubed > LAB_EPSILON ? cubed : (116 * f - 16) / LAB_KAPPA;
}

/** XYZ (D65, Y = 1 for white) -> CIELAB. */
export function xyzToLab(xyz: ReadonlyVec3): Vec3 {
  const fx = labForward(xyz[0] / D65_WHITE[0]);
  const fy = labForward(xyz[1] / D65_WHITE[1]);
  const fz = labForward(xyz[2] / D65_WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIELAB -> XYZ (D65, Y = 1 for white). */
export function labToXyz(lab: ReadonlyVec3): Vec3 {
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  return [labInverse(fx) * D65_WHITE[0], labInverse(fy) * D65_WHITE[1], labInverse(fz) * D65_WHITE[2]];
}

// ---------------------------------------------------------------------------
// Rectangular <-> polar (shared by LCh(ab) and OKLCh)
// ---------------------------------------------------------------------------

function toPolar(rect: ReadonlyVec3, achromaticChroma: number): Vec3 {
  const chroma = Math.hypot(rect[1], rect[2]);
  if (chroma < achromaticChroma) return [rect[0], chroma, 0];
  const hue = (Math.atan2(rect[2], rect[1]) * 180) / Math.PI;
  return [rect[0], chroma, hue < 0 ? hue + 360 : hue];
}

function toRectangular(polar: ReadonlyVec3): Vec3 {
  const radians = (polar[2] * Math.PI) / 180;
  return [polar[0], polar[1] * Math.cos(radians), polar[1] * Math.sin(radians)];
}

/** CIELAB -> LCh(ab). Hue is reported as 0 when chroma is below 0.001. */
export function labToLch(lab: ReadonlyVec3): Vec3 {
  return toPolar(lab, 1e-3);
}

export function lchToLab(lch: ReadonlyVec3): Vec3 {
  return toRectangular(lch);
}

// ---------------------------------------------------------------------------
// XYZ <-> OKLab <-> OKLCh
// ---------------------------------------------------------------------------

/**
 * OKLab matrices (Björn Ottosson, 2020) in the form recomputed for the exact
 * sRGB D65 white, as adopted by CSS Color 4 and published in color.js
 * (`src/spaces/oklab.js`).
 */
const XYZ_TO_LMS: Matrix3 = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
];
const LMS_TO_XYZ: Matrix3 = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
];
const LMS_TO_OKLAB: Matrix3 = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.42859224204858, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const OKLAB_TO_LMS: Matrix3 = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
];

/** XYZ (D65) -> OKLab. */
export function xyzToOklab(xyz: ReadonlyVec3): Vec3 {
  const lms = multiplyMatrixVector(XYZ_TO_LMS, xyz);
  return multiplyMatrixVector(LMS_TO_OKLAB, [Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2])]);
}

/** OKLab -> XYZ (D65). */
export function oklabToXyz(oklab: ReadonlyVec3): Vec3 {
  const root = multiplyMatrixVector(OKLAB_TO_LMS, oklab);
  return multiplyMatrixVector(LMS_TO_XYZ, [root[0] ** 3, root[1] ** 3, root[2] ** 3]);
}

/** OKLab -> OKLCh. Hue is reported as 0 when chroma is below 0.0001. */
export function oklabToOklch(oklab: ReadonlyVec3): Vec3 {
  return toPolar(oklab, 1e-4);
}

export function oklchToOklab(oklch: ReadonlyVec3): Vec3 {
  return toRectangular(oklch);
}

// ---------------------------------------------------------------------------
// Convenience chains
// ---------------------------------------------------------------------------

/** 8-bit sRGB -> CIELAB. */
export function rgb8ToLab(rgb: ReadonlyVec3): Vec3 {
  return xyzToLab(linearRgbToXyz(rgb8ToLinearRgb(rgb)));
}

/** Hex -> CIELAB. */
export function hexToLab(hex: string): Vec3 {
  return rgb8ToLab(hexToRgb8(hex));
}

/** CIELAB -> 8-bit sRGB, clamped to the display gamut. */
export function labToRgb8(lab: ReadonlyVec3): Vec3 {
  return linearRgbToRgb8(xyzToLinearRgb(labToXyz(lab)));
}

/** CIELAB -> hex, clamped to the display gamut. */
export function labToHex(lab: ReadonlyVec3): string {
  return rgb8ToHex(labToRgb8(lab));
}

/** 8-bit sRGB -> OKLCh. */
export function rgb8ToOklch(rgb: ReadonlyVec3): Vec3 {
  return oklabToOklch(xyzToOklab(linearRgbToXyz(rgb8ToLinearRgb(rgb))));
}

// ---------------------------------------------------------------------------
// Gamut
// ---------------------------------------------------------------------------

/**
 * True when every linear sRGB channel lies in [0, 1] within `tolerance`.
 * The default tolerance is about a quarter of one 8-bit step near black.
 */
export function isLinearRgbInGamut(linear: ReadonlyVec3, tolerance = 1e-4): boolean {
  return linear.every((channel) => channel >= -tolerance && channel <= 1 + tolerance);
}

/** True when an XYZ colour can be shown on an sRGB display without clipping. */
export function isXyzInSrgbGamut(xyz: ReadonlyVec3, tolerance = 1e-4): boolean {
  return isLinearRgbInGamut(xyzToLinearRgb(xyz), tolerance);
}

/** True when a CIELAB colour can be shown on an sRGB display without clipping. */
export function isLabInSrgbGamut(lab: ReadonlyVec3, tolerance = 1e-4): boolean {
  return isXyzInSrgbGamut(labToXyz(lab), tolerance);
}

// ---------------------------------------------------------------------------
// ColorCoordinates builders
// ---------------------------------------------------------------------------

/** Build the full coordinate record from 8-bit sRGB. Channels are rounded and clamped. */
export function colorFromRgb8(rgb: ReadonlyVec3): ColorCoordinates {
  const clean: Vec3 = [
    Math.min(255, Math.max(0, Math.round(rgb[0]))),
    Math.min(255, Math.max(0, Math.round(rgb[1]))),
    Math.min(255, Math.max(0, Math.round(rgb[2]))),
  ];
  const xyz = linearRgbToXyz(rgb8ToLinearRgb(clean));
  return {
    hex: rgb8ToHex(clean),
    rgb: clean,
    lab: xyzToLab(xyz),
    oklch: oklabToOklch(xyzToOklab(xyz)),
  };
}

/**
 * Build the full coordinate record from a hex string.
 * @throws {RangeError} when the string is not a valid hex colour.
 */
export function colorFromHex(hex: string): ColorCoordinates {
  return colorFromRgb8(hexToRgb8(hex));
}

/**
 * Build a coordinate record from XYZ (D65). `lab` and `oklch` describe the XYZ
 * colour exactly; `hex` and `rgb` are clamped to what an sRGB display can show.
 */
export function colorFromXyz(xyz: ReadonlyVec3): ColorCoordinates {
  const rgb = linearRgbToRgb8(xyzToLinearRgb(xyz));
  return {
    hex: rgb8ToHex(rgb),
    rgb,
    lab: xyzToLab(xyz),
    oklch: oklabToOklch(xyzToOklab(xyz)),
  };
}

/**
 * Build a coordinate record from CIELAB, e.g. a spectrophotometer reading.
 * `lab` is kept as given; `hex` and `rgb` are clamped to the display gamut.
 */
export function colorFromLab(lab: ReadonlyVec3): ColorCoordinates {
  const xyz = labToXyz(lab);
  const rgb = linearRgbToRgb8(xyzToLinearRgb(xyz));
  return {
    hex: rgb8ToHex(rgb),
    rgb,
    lab: [lab[0], lab[1], lab[2]],
    oklch: oklabToOklch(xyzToOklab(xyz)),
  };
}
