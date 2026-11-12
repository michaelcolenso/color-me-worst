/**
 * CIEDE2000 colour difference (ΔE00). Zero dependencies.
 *
 * Implemented from Sharma, Wu & Dalal, "The CIEDE2000 Color-Difference Formula:
 * Implementation Notes, Supplementary Test Data, and Mathematical Observations",
 * Color Research & Application 30(1), 2005. Equation numbers in the comments
 * refer to that paper. The test suite checks all 34 reference pairs from its
 * Table 1 to four decimal places, in both argument orders.
 */

import type { ReadonlyVec3 } from './types';

/** Parametric weighting factors. All default to 1 (reference viewing conditions). */
export interface DeltaE2000Weights {
  /** Lightness weight. Textile practice often uses 2. */
  kL?: number;
  /** Chroma weight. */
  kC?: number;
  /** Hue weight. */
  kH?: number;
}

/** The weighted terms of a ΔE00 evaluation, for explaining *how* two colours differ. */
export interface DeltaE2000Breakdown {
  deltaE00: number;
  /** ΔL′ / (kL·SL). Positive when the second colour is lighter. */
  lightness: number;
  /** ΔC′ / (kC·SC). Positive when the second colour is more saturated. */
  chroma: number;
  /** ΔH′ / (kH·SH). Signed hue term. */
  hue: number;
  /** RT · chroma · hue: the blue-region rotation cross term. */
  rotation: number;
}

/**
 * Perceptual bands from the specification:
 *   below `exact`       — imperceptible / exact match
 *   below `close`       — close studio substitute
 *   below `noticeable`  — noticeable difference
 *   otherwise           — poor
 */
export const DELTA_E_THRESHOLDS = {
  exact: 1.5,
  close: 3.0,
  noticeable: 5.0,
} as const;

export type MatchQuality = 'exact' | 'close' | 'noticeable' | 'poor';

/** Map a ΔE00 value onto the specification's perceptual bands. */
export function classifyDeltaE(deltaE00: number): MatchQuality {
  if (deltaE00 < DELTA_E_THRESHOLDS.exact) return 'exact';
  if (deltaE00 < DELTA_E_THRESHOLDS.close) return 'close';
  if (deltaE00 < DELTA_E_THRESHOLDS.noticeable) return 'noticeable';
  return 'poor';
}

/**
 * Largest value the lightness weighting function SL can take (reached at
 * mean L* of 0 or 100). Because the chroma/hue part of ΔE00 is a positive
 * semi-definite quadratic form (|RT| <= 2), this gives a cheap exact bound:
 *
 *   ΔE00 >= |ΔL*| / (kL · MAX_LIGHTNESS_WEIGHT)
 *
 * Search code uses it to discard candidates without evaluating the formula.
 */
export const MAX_LIGHTNESS_WEIGHT = 1 + (0.015 * 2500) / Math.sqrt(20 + 2500);

const DEG = Math.PI / 180;
const POW_25_7 = 25 ** 7;
/** Largest value of sin(2Δθ): Δθ peaks at 30°. */
const MAX_ROTATION_SINE = Math.sin(60 * DEG);

function pow7(x: number): number {
  const x2 = x * x;
  return x2 * x2 * x2 * x;
}

/** Reused output slots so the hot path allocates nothing. */
let termLightness = 0;
let termChroma = 0;
let termHue = 0;
let termRotation = 0;

/**
 * Allocation-free ΔE00 on unpacked L*a*b* components.
 * Use this inside tight loops; use {@link deltaE2000} everywhere else.
 */
export function deltaE2000Components(
  L1: number,
  a1: number,
  b1: number,
  L2: number,
  a2: number,
  b2: number,
  kL = 1,
  kC = 1,
  kH = 1,
): number {
  // Eq. 2–4: chroma-dependent rescaling of a*, which fixes the near-neutral region.
  const meanC = (Math.sqrt(a1 * a1 + b1 * b1) + Math.sqrt(a2 * a2 + b2 * b2)) / 2;
  const meanC7 = pow7(meanC);
  const G = 0.5 * (1 - Math.sqrt(meanC7 / (meanC7 + POW_25_7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;

  // Eq. 6–7: modified chroma and hue angle (degrees, 0–360, 0 when achromatic).
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);
  let h1p = C1p === 0 ? 0 : Math.atan2(b1, a1p) / DEG;
  if (h1p < 0) h1p += 360;
  let h2p = C2p === 0 ? 0 : Math.atan2(b2, a2p) / DEG;
  if (h2p < 0) h2p += 360;

  // Eq. 8–11: differences.
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const bothChromatic = C1p * C2p !== 0;
  let dhp = 0;
  if (bothChromatic) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG);

  // Eq. 12–14: means. The hue mean must take the short way round the circle.
  const meanLp = (L1 + L2) / 2;
  const meanCp = (C1p + C2p) / 2;
  let meanHp = h1p + h2p;
  if (bothChromatic) {
    if (Math.abs(h1p - h2p) <= 180) meanHp /= 2;
    else if (meanHp < 360) meanHp = (meanHp + 360) / 2;
    else meanHp = (meanHp - 360) / 2;
  }

  // Eq. 15–21: weighting functions and the rotation term.
  const T =
    1 -
    0.17 * Math.cos((meanHp - 30) * DEG) +
    0.24 * Math.cos(2 * meanHp * DEG) +
    0.32 * Math.cos((3 * meanHp + 6) * DEG) -
    0.2 * Math.cos((4 * meanHp - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((meanHp - 275) / 25) ** 2));
  const meanCp7 = pow7(meanCp);
  const RC = 2 * Math.sqrt(meanCp7 / (meanCp7 + POW_25_7));
  const lightnessOffset = (meanLp - 50) ** 2;
  const SL = 1 + (0.015 * lightnessOffset) / Math.sqrt(20 + lightnessOffset);
  const SC = 1 + 0.045 * meanCp;
  const SH = 1 + 0.015 * meanCp * T;
  const RT = -Math.sin(2 * dTheta * DEG) * RC;

  // Eq. 22.
  termLightness = dLp / (kL * SL);
  termChroma = dCp / (kC * SC);
  termHue = dHp / (kH * SH);
  termRotation = RT * termChroma * termHue;
  const sumOfSquares = termLightness * termLightness + termChroma * termChroma + termHue * termHue + termRotation;
  // The form is non-negative in exact arithmetic; guard against −1e-17 round-off.
  return sumOfSquares > 0 ? Math.sqrt(sumOfSquares) : 0;
}

/**
 * A cheap, mathematically guaranteed lower bound on ΔE00: the true value is
 * never smaller than what this returns. It needs three square roots and no
 * trigonometry, so search loops call it first and evaluate the full formula
 * only for candidates the bound cannot rule out.
 *
 * Derivation, in the notation of the paper:
 * - lightness term: |ΔL′| / (kL·SL) >= |ΔL′| / (kL·{@link MAX_LIGHTNESS_WEIGHT});
 * - ΔC′² + ΔH′² equals the squared chord (Δa′)² + (Δb)², and a′ = (1 + G)·a
 *   with G known exactly from the two chromas;
 * - SC and SH are both at most 1 + 0.045·C̄′, and C̄′ <= (1 + G)·C̄;
 * - the cross term RT·x·y is at least −|RT|·(x² + y²)/2, and
 *   |RT| <= sin 60° · RC(C̄′), with RC increasing in C̄′.
 */
export function deltaE2000LowerBound(
  L1: number,
  a1: number,
  b1: number,
  L2: number,
  a2: number,
  b2: number,
  kL = 1,
  kC = 1,
  kH = 1,
): number {
  const meanC = (Math.sqrt(a1 * a1 + b1 * b1) + Math.sqrt(a2 * a2 + b2 * b2)) / 2;
  const meanC7 = pow7(meanC);
  const scale = 1.5 - 0.5 * Math.sqrt(meanC7 / (meanC7 + POW_25_7)); // 1 + G
  const maxMeanCp = scale * meanC;
  const maxMeanCp7 = pow7(maxMeanCp);
  const maxRT = MAX_ROTATION_SINE * 2 * Math.sqrt(maxMeanCp7 / (maxMeanCp7 + POW_25_7));
  const weight = (kC > kH ? kC : kH) * (1 + 0.045 * maxMeanCp);
  const dL = (L2 - L1) / (kL * MAX_LIGHTNESS_WEIGHT);
  const da = scale * (a2 - a1);
  const db = b2 - b1;
  return Math.sqrt(dL * dL + ((1 - maxRT / 2) * (da * da + db * db)) / (weight * weight));
}

/**
 * CIEDE2000 colour difference between two CIELAB colours.
 *
 * @param lab1 Reference colour [L*, a*, b*].
 * @param lab2 Sample colour [L*, a*, b*].
 * @param weights Optional parametric factors kL, kC, kH (default 1 each).
 * @returns ΔE00, always >= 0. Symmetric in its two colour arguments.
 */
export function deltaE2000(lab1: ReadonlyVec3, lab2: ReadonlyVec3, weights: DeltaE2000Weights = {}): number {
  return deltaE2000Components(
    lab1[0],
    lab1[1],
    lab1[2],
    lab2[0],
    lab2[1],
    lab2[2],
    weights.kL ?? 1,
    weights.kC ?? 1,
    weights.kH ?? 1,
  );
}

/**
 * ΔE00 together with its weighted lightness, chroma and hue terms, so a UI can
 * say "slightly darker and less saturated" instead of showing a bare number.
 */
export function deltaE2000Breakdown(
  lab1: ReadonlyVec3,
  lab2: ReadonlyVec3,
  weights: DeltaE2000Weights = {},
): DeltaE2000Breakdown {
  const deltaE00 = deltaE2000(lab1, lab2, weights);
  return {
    deltaE00,
    lightness: termLightness,
    chroma: termChroma,
    hue: termHue,
    rotation: termRotation,
  };
}

/** CIE76 colour difference: plain Euclidean distance in CIELAB. Kept for comparison and tests. */
export function deltaE76(lab1: ReadonlyVec3, lab2: ReadonlyVec3): number {
  return Math.hypot(lab1[0] - lab2[0], lab1[1] - lab2[1], lab1[2] - lab2[2]);
}
