#!/usr/bin/env node
/**
 * Derives the spectral tables used by the Kubelka-Munk mixer and writes
 * `src/lib/color/spectralData.ts`.
 *
 * Zero dependencies. Deterministic: the same input table always produces the
 * same output file. Re-run with `npm run derive:basis`.
 *
 * INPUT
 *   scripts/data/cie1931-2deg-d65-10nm.json
 *     CIE 1931 2-degree standard observer colour-matching functions and the
 *     CIE standard illuminant D65 relative spectral power distribution,
 *     sampled every 10 nm from 380 nm to 730 nm (36 samples). Values were
 *     taken from the tables published in the colour-science/colour project
 *     (colour/colorimetry/datasets), which reproduce the CIE standard tables.
 *
 *     Adjacent samples are summed in pairs, giving 18 bands of 20 nm. The
 *     reflectance curves this model produces are smooth, so 20 nm loses
 *     nothing visible, and halving the band count halves the cost of the
 *     mix search, which is what keeps it inside its 50 ms budget.
 *
 * OUTPUT
 *   1. SPECTRAL_TO_XYZ — a 3 x N matrix mapping a reflectance spectrum to CIE
 *      XYZ under D65. Rows are rescaled so a perfect reflector (all ones) maps
 *      to exactly the D65 white implied by the sRGB specification
 *      (x = 0.3127, y = 0.3290), which keeps the spectral path consistent with
 *      the matrix path in colorConversions.ts.
 *   2. BASIS_R / BASIS_G / BASIS_B — three reflectance spectra such that
 *        reflectance(λ) = r·BASIS_R(λ) + g·BASIS_G(λ) + b·BASIS_B(λ)
 *      for linear-light sRGB (r, g, b) in [0, 1] satisfies:
 *        a. every band lies in [0, 1]              (physically valid)
 *        b. BASIS_R + BASIS_G + BASIS_B = 1         (white is a flat reflector)
 *        c. SPECTRAL_TO_RGB · BASIS_k = unit vector (exact colour round trip)
 *      Among all spectra satisfying (a)–(c) the script picks the smoothest
 *      (minimum sum of squared first differences), because real pigment
 *      reflectance curves are smooth. This is a convex quadratic programme,
 *      solved here with ADMM (the OSQP splitting).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cie = JSON.parse(readFileSync(resolve(here, 'data/cie1931-2deg-d65-10nm.json'), 'utf8'));

/** Number of adjacent 10 nm samples summed into one band. */
const SAMPLES_PER_BAND = 2;
if (cie.wavelengths.length % SAMPLES_PER_BAND !== 0) throw new Error('sample count must divide evenly into bands');
const N = cie.wavelengths.length / SAMPLES_PER_BAND;
const binSum = (values) =>
  Array.from({ length: N }, (_, band) => {
    let sum = 0;
    for (let k = 0; k < SAMPLES_PER_BAND; k++) sum += values[band * SAMPLES_PER_BAND + k];
    return sum;
  });
const bandCentres = binSum(cie.wavelengths).map((sum) => sum / SAMPLES_PER_BAND);

// ---------------------------------------------------------------------------
// Small dense linear algebra helpers
// ---------------------------------------------------------------------------

const zeros = (r, c) => Array.from({ length: r }, () => new Float64Array(c));

function matMul(a, b) {
  const out = zeros(a.length, b[0].length);
  for (let i = 0; i < a.length; i++)
    for (let k = 0; k < b.length; k++) {
      const aik = a[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < b[0].length; j++) out[i][j] += aik * b[k][j];
    }
  return out;
}

function invert(m) {
  const n = m.length;
  const a = m.map((row, i) => {
    const r = new Float64Array(2 * n);
    r.set(row);
    r[n + i] = 1;
    return r;
  });
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-14) throw new Error('singular matrix');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const p = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

// ---------------------------------------------------------------------------
// sRGB <-> XYZ matrices derived from the sRGB chromaticities (same derivation
// as colorConversions.ts, so the two files cannot drift apart)
// ---------------------------------------------------------------------------

const xyToXyz = (x, y) => [x / y, 1, (1 - x - y) / y];
const WHITE = xyToXyz(0.3127, 0.329);
const prim = [xyToXyz(0.64, 0.33), xyToXyz(0.3, 0.6), xyToXyz(0.15, 0.06)];
const primCols = [0, 1, 2].map((i) => Float64Array.from(prim.map((p) => p[i])));
const primInv = invert(primCols);
const scale = primInv.map((row) => row[0] * WHITE[0] + row[1] * WHITE[1] + row[2] * WHITE[2]);
const RGB_TO_XYZ = primCols.map((row) => Float64Array.from(row.map((v, j) => v * scale[j])));
const XYZ_TO_RGB = invert(RGB_TO_XYZ);

// ---------------------------------------------------------------------------
// Reflectance -> XYZ under D65
// ---------------------------------------------------------------------------

const rawRows = [cie.xbar, cie.ybar, cie.zbar].map((bar) => binSum(bar.map((v, i) => v * cie.d65[i])));
const rawWhite = rawRows.map((row) => row.reduce((s, v) => s + v, 0));
const rawWhiteNormalised = rawWhite.map((v) => v / rawWhite[1]);
const SPECTRAL_TO_XYZ = rawRows.map((row, i) => Float64Array.from(row.map((v) => (v / rawWhite[i]) * WHITE[i])));
const SPECTRAL_TO_RGB = matMul(XYZ_TO_RGB, SPECTRAL_TO_XYZ);

console.log('summation white (before rescale)     :', rawWhiteNormalised.map((v) => v.toFixed(5)).join(', '));
console.log('sRGB-implied D65 white               :', WHITE.map((v) => v.toFixed(5)).join(', '));

// ---------------------------------------------------------------------------
// Quadratic programme
//   variables x = [bR (N), bG (N)],  bB = 1 - bR - bG
//   minimise  |D bR|^2 + |D bG|^2 + |D bB|^2
//   subject to T bR = e_R, T bG = e_G, 0 <= bR, 0 <= bG, bR + bG <= 1
// ---------------------------------------------------------------------------

const n = 2 * N;
const lap = zeros(N, N); // D^T D for the first-difference operator
for (let i = 0; i < N - 1; i++) {
  lap[i][i] += 1;
  lap[i + 1][i + 1] += 1;
  lap[i][i + 1] -= 1;
  lap[i + 1][i] -= 1;
}
const P = zeros(n, n);
for (let i = 0; i < N; i++)
  for (let j = 0; j < N; j++) {
    P[i][j] = 4 * lap[i][j];
    P[N + i][N + j] = 4 * lap[i][j];
    P[i][N + j] = 2 * lap[i][j];
    P[N + i][j] = 2 * lap[i][j];
  }

const A = [];
const lower = [];
const upper = [];
const isEquality = [];
const pushRow = (row, lo, hi) => {
  A.push(row);
  lower.push(lo);
  upper.push(hi);
  isEquality.push(lo === hi);
};
for (let basis = 0; basis < 2; basis++)
  for (let ch = 0; ch < 3; ch++) {
    const row = new Float64Array(n);
    for (let i = 0; i < N; i++) row[basis * N + i] = SPECTRAL_TO_RGB[ch][i];
    const target = ch === basis ? 1 : 0;
    pushRow(row, target, target);
  }
for (let i = 0; i < n; i++) {
  const row = new Float64Array(n);
  row[i] = 1;
  pushRow(row, 0, 1);
}
for (let i = 0; i < N; i++) {
  const row = new Float64Array(n);
  row[i] = 1;
  row[N + i] = 1;
  pushRow(row, 0, 1);
}
const m = A.length;

const SIGMA = 1e-9;
const rho = isEquality.map((eq) => (eq ? 1e3 : 1));
const K = zeros(n, n);
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) K[i][j] = P[i][j];
  K[i][i] += SIGMA;
}
for (let r = 0; r < m; r++)
  for (let i = 0; i < n; i++) {
    const ari = A[r][i];
    if (ari === 0) continue;
    for (let j = 0; j < n; j++) K[i][j] += rho[r] * ari * A[r][j];
  }
const Kinv = invert(K);

let x = new Float64Array(n).fill(1 / 3);
let z = new Float64Array(m);
const y = new Float64Array(m);
for (let r = 0; r < m; r++) {
  let s = 0;
  for (let i = 0; i < n; i++) s += A[r][i] * x[i];
  z[r] = Math.min(upper[r], Math.max(lower[r], s));
}

const MAX_ITERATIONS = 400000;
const TOLERANCE = 1e-11;
let iterations = 0;
let primalResidual = Infinity;
let stepSize = Infinity;
for (; iterations < MAX_ITERATIONS; iterations++) {
  const rhs = new Float64Array(n);
  for (let i = 0; i < n; i++) rhs[i] = SIGMA * x[i];
  for (let r = 0; r < m; r++) {
    const w = rho[r] * z[r] - y[r];
    if (w === 0) continue;
    for (let i = 0; i < n; i++) rhs[i] += A[r][i] * w;
  }
  const xNext = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += Kinv[i][j] * rhs[j];
    xNext[i] = s;
  }
  primalResidual = 0;
  for (let r = 0; r < m; r++) {
    let ax = 0;
    for (let i = 0; i < n; i++) ax += A[r][i] * xNext[i];
    const zr = Math.min(upper[r], Math.max(lower[r], ax + y[r] / rho[r]));
    y[r] += rho[r] * (ax - zr);
    z[r] = zr;
    primalResidual = Math.max(primalResidual, Math.abs(ax - zr));
  }
  stepSize = 0;
  for (let i = 0; i < n; i++) stepSize = Math.max(stepSize, Math.abs(xNext[i] - x[i]));
  x = xNext;
  if (primalResidual < TOLERANCE && stepSize < TOLERANCE) break;
}
console.log(`ADMM: ${iterations} iterations, primal residual ${primalResidual.toExponential(2)}, step ${stepSize.toExponential(2)}`);
if (primalResidual > 1e-8) throw new Error('ADMM did not converge');

// ---------------------------------------------------------------------------
// Post-process: clamp numerical dust, round, verify, write
// ---------------------------------------------------------------------------

const DECIMALS = 8;
const round = (v) => Number(v.toFixed(DECIMALS));
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const basisR = Array.from(x.subarray(0, N), (v) => round(clamp01(v)));
const basisG = Array.from(x.subarray(N, n), (v) => round(clamp01(v)));
const basisB = basisR.map((r, i) => round(clamp01(1 - r - basisG[i])));

let worstRoundTrip = 0;
[basisR, basisG, basisB].forEach((basis, k) => {
  for (let ch = 0; ch < 3; ch++) {
    let s = 0;
    for (let i = 0; i < N; i++) s += SPECTRAL_TO_RGB[ch][i] * basis[i];
    worstRoundTrip = Math.max(worstRoundTrip, Math.abs(s - (ch === k ? 1 : 0)));
  }
});
console.log('worst |T·B − I| after rounding:', worstRoundTrip.toExponential(2));
if (worstRoundTrip > 1e-6) throw new Error('basis does not round-trip');

const fmtRow = (row, digits) => `[\n    ${Array.from(row, (v) => Number(v.toPrecision(digits))).join(', ')},\n  ]`;
const fmtBasis = (row) => `[\n  ${row.join(', ')},\n]`;

const file = `/**
 * GENERATED FILE — do not edit by hand.
 * Produced by scripts/deriveSpectralBasis.mjs (run \`npm run derive:basis\`).
 *
 * Source data: CIE 1931 2-degree standard observer and CIE standard illuminant
 * D65 at 10 nm from ${cie.wavelengths[0]} nm to ${cie.wavelengths[cie.wavelengths.length - 1]} nm, summed into ${N} bands
 * of ${SAMPLES_PER_BAND * 10} nm.
 */

/** Number of spectral bands. */
export const BAND_COUNT = ${N};

/** Band centre wavelengths in nanometres. */
export const WAVELENGTHS_NM: readonly number[] = [${bandCentres.join(', ')}];

/**
 * Rows X, Y, Z. Multiplying by a reflectance spectrum gives CIE XYZ under D65
 * with Y = 1 for a perfect reflector.
 */
export const SPECTRAL_TO_XYZ: readonly (readonly number[])[] = [
  ${SPECTRAL_TO_XYZ.map((row) => fmtRow(row, 10)).join(',\n  ')},
];

/**
 * Smoothest reflectance spectra that reproduce the linear sRGB primaries.
 * They sum to 1 in every band, so reflectance = r·R + g·G + b·B stays in [0, 1]
 * for any in-gamut linear sRGB colour and reproduces that colour exactly.
 */
export const BASIS_R: readonly number[] = ${fmtBasis(basisR)};

export const BASIS_G: readonly number[] = ${fmtBasis(basisG)};

export const BASIS_B: readonly number[] = ${fmtBasis(basisB)};
`;

const outPath = resolve(here, '../src/lib/color/spectralData.ts');
writeFileSync(outPath, file);
console.log('wrote', outPath);
