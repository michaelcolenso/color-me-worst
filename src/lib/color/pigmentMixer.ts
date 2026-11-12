/**
 * Subtractive two-part pigment mixing with a Kubelka-Munk reflectance model.
 * Zero dependencies.
 *
 * HOW IT WORKS
 * 1. Spectral upsampling. Each colour is expanded from linear sRGB into a
 *    18-band reflectance spectrum (20 nm bands spanning the visible range,
 *    centred 385–725 nm) as a weighted sum of three
 *    smooth basis spectra (see spectralData.ts). The expansion is exact: the
 *    spectrum integrates back to the colour it came from.
 * 2. Kubelka-Munk. For an opaque film, reflectance R and the ratio of
 *    absorption K to scattering S are linked by K/S = (1 − R)² / 2R. K and S
 *    add linearly by concentration, so the mixture's K/S in every band is a
 *    weighted mean of the components' K/S, which is then converted back to
 *    reflectance and integrated to XYZ under D65.
 * 3. Search. Every compatible pair in the stash is evaluated at each allowed
 *    ratio and ranked by CIEDE2000 against the target. The search is exact:
 *    pairs are skipped only when a mathematical bound proves they cannot win.
 *
 * WHAT IT IS NOT
 * A hex code does not determine a pigment's real spectrum or tinting strength.
 * Two paints with the same hex can mix differently, and strong tinters such as
 * phthalo blue or carbon black overpower a mix far more than their colour
 * suggests. Treat predictions as a well-founded starting ratio, not a
 * guarantee. Measured data can be supplied per item through
 * {@link PigmentOverride} and replaces the estimate wherever it is given.
 *
 * RULES ENFORCED BY THE SEARCH
 * - Only paints are mixed. Thread, markers, fabric, beads and dye are never
 *   offered as mix components.
 * - Both components must be the same medium. This is not overridable.
 * - Both components must be in the same finish class (see {@link finishClassOf})
 *   unless `experimentalFinishes` is set. Variegated items are never mixed.
 */

import { colorFromXyz, D65_WHITE, isXyzInSrgbGamut, labToXyz, xyzToLinearRgb } from './colorConversions';
import {
  deltaE2000Components,
  deltaE2000LowerBound,
  MAX_LIGHTNESS_WEIGHT,
  type DeltaE2000Weights,
} from './deltaE2000';
import { BAND_COUNT, BASIS_B, BASIS_G, BASIS_R, SPECTRAL_TO_XYZ } from './spectralData';
import type {
  CatalogItem,
  ColorCoordinates,
  FinishType,
  MediumType,
  MixWarning,
  ReadonlyVec3,
  TwoPartMix,
  Vec3,
} from './types';

// ---------------------------------------------------------------------------
// Compatibility rules
// ---------------------------------------------------------------------------

/**
 * Finishes grouped by how they physically behave:
 * - `solid`: matte, satin and gloss differ only in sheen and intermix freely.
 * - `transparent`: washes and contrast paints, which tint rather than cover.
 * - `metallic`: colour comes from reflective flake, which a hex cannot describe.
 * - `fluorescent`: emits light, so it can exceed the display gamut.
 * - `variegated`: several colours in one item.
 */
export type FinishClass = 'solid' | 'transparent' | 'metallic' | 'fluorescent' | 'variegated';

const FINISH_CLASS: Readonly<Record<FinishType, FinishClass>> = {
  matte: 'solid',
  satin: 'solid',
  gloss: 'solid',
  wash: 'transparent',
  contrast: 'transparent',
  metallic: 'metallic',
  fluorescent: 'fluorescent',
  variegated: 'variegated',
};

const FINISH_CLASS_CODES: readonly FinishClass[] = ['solid', 'transparent', 'metallic', 'fluorescent', 'variegated'];
const VARIEGATED_CODE = FINISH_CLASS_CODES.indexOf('variegated');

const MIXABLE_MEDIA: ReadonlySet<MediumType> = new Set<MediumType>(['acrylic_paint', 'enamel_paint', 'oil_paint']);

const MEDIUM_CODES: readonly MediumType[] = [
  'acrylic_paint',
  'enamel_paint',
  'oil_paint',
  'embroidery_floss',
  'alcohol_marker',
  'fabric',
  'bead',
  'leather_dye',
];

export function finishClassOf(finish: FinishType): FinishClass {
  return FINISH_CLASS[finish];
}

/** True for media that can be physically blended into one uniform colour. */
export function isMixableMedium(medium: MediumType): boolean {
  return MIXABLE_MEDIA.has(medium);
}

export interface FinishRuleOptions {
  /** Allow pairings across finish classes (e.g. metallic with matte). Default false. */
  experimentalFinishes?: boolean;
}

/**
 * - `compatible`: safe to recommend.
 * - `experimental`: only when the user has enabled Experimental Finishes.
 * - `incompatible`: never recommended.
 */
export type MixCompatibility = 'compatible' | 'experimental' | 'incompatible';

/** Classify whether two catalogue items may be mixed with each other. */
export function mixCompatibility(a: CatalogItem, b: CatalogItem): MixCompatibility {
  if (a.medium !== b.medium || !isMixableMedium(a.medium)) return 'incompatible';
  const classA = finishClassOf(a.finish);
  const classB = finishClassOf(b.finish);
  if (classA === 'variegated' || classB === 'variegated') return 'incompatible';
  return classA === classB ? 'compatible' : 'experimental';
}

export function canMix(a: CatalogItem, b: CatalogItem, options: FinishRuleOptions = {}): boolean {
  const compatibility = mixCompatibility(a, b);
  return compatibility === 'compatible' || (compatibility === 'experimental' && options.experimentalFinishes === true);
}

/**
 * Whether an item with `candidateFinish` may stand in for a target of
 * `targetFinish`. This is what stops a metallic gold being offered for a matte
 * yellow ochre that happens to share its hex.
 */
export function canSubstituteFinish(
  targetFinish: FinishType,
  candidateFinish: FinishType,
  options: FinishRuleOptions = {},
): boolean {
  return options.experimentalFinishes === true || finishClassOf(targetFinish) === finishClassOf(candidateFinish);
}

// ---------------------------------------------------------------------------
// Spectral model
// ---------------------------------------------------------------------------

/**
 * Lowest reflectance the model allows in any band. A band at exactly zero
 * would have infinite K/S; real surfaces never go that low anyway.
 */
export const MIN_REFLECTANCE = 1e-3;

/**
 * Relative scattering power is estimated as luminance raised to this power.
 *
 * Light, opaque paints (white above all) scatter far more than dark saturated
 * ones, which is why a little white visibly tints a strong red. With a single
 * shared scattering constant that effect disappears and white becomes far too
 * weak. An exponent of 0 gives single-constant Kubelka-Munk; 1 weights fully
 * by luminance. 0.5 is an uncalibrated middle setting: it has not been fitted
 * to measured drawdowns, and per-pigment `tintStrength` overrides take
 * precedence where real data exists.
 */
export const SCATTERING_EXPONENT = 0.5;

/** Below this opacity a mix prediction is flagged `low_opacity`. */
export const LOW_OPACITY_THRESHOLD = 0.6;

/**
 * Module-local copies of imported values used in hot loops. A plain local
 * constant is something every runtime and bundler can treat as a literal;
 * a live import binding is not always.
 */
const BANDS = BAND_COUNT;
const lowerBound = deltaE2000LowerBound;
const fullDeltaE = deltaE2000Components;

const TO_X = Float64Array.from(SPECTRAL_TO_XYZ[0] as readonly number[]);
const TO_Y = Float64Array.from(SPECTRAL_TO_XYZ[1] as readonly number[]);
const TO_Z = Float64Array.from(SPECTRAL_TO_XYZ[2] as readonly number[]);
const BASIS_RED = Float64Array.from(BASIS_R);
const BASIS_GREEN = Float64Array.from(BASIS_G);
const BASIS_BLUE = Float64Array.from(BASIS_B);

function clampUnit(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampReflectance(value: number): number {
  if (!(value > MIN_REFLECTANCE)) return MIN_REFLECTANCE; // also catches NaN
  return value > 1 ? 1 : value;
}

/**
 * Expand a linear-light sRGB colour into a reflectance spectrum of
 * {@link BAND_COUNT} bands. Channels are clamped to [0, 1] first, and each
 * band to [{@link MIN_REFLECTANCE}, 1].
 */
export function reflectanceFromLinearRgb(linear: ReadonlyVec3, out = new Float64Array(BANDS)): Float64Array {
  const r = clampUnit(linear[0]);
  const g = clampUnit(linear[1]);
  const b = clampUnit(linear[2]);
  for (let band = 0; band < BANDS; band++) {
    out[band] = clampReflectance(
      r * (BASIS_RED[band] as number) + g * (BASIS_GREEN[band] as number) + b * (BASIS_BLUE[band] as number),
    );
  }
  return out;
}

/** Integrate a reflectance spectrum to CIE XYZ under D65 (Y = 1 for a perfect reflector). */
export function reflectanceToXyz(reflectance: ArrayLike<number>): Vec3 {
  assertBandCount(reflectance);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let band = 0; band < BANDS; band++) {
    const r = reflectance[band] as number;
    x += (TO_X[band] as number) * r;
    y += (TO_Y[band] as number) * r;
    z += (TO_Z[band] as number) * r;
  }
  return [x, y, z];
}

/** Kubelka-Munk: reflectance of an opaque film -> absorption/scattering ratio K/S. */
export function reflectanceToKS(reflectance: number): number {
  const r = clampReflectance(reflectance);
  return ((1 - r) * (1 - r)) / (2 * r);
}

/**
 * Kubelka-Munk: K/S -> reflectance of an opaque film.
 * Uses 1 / (1 + ks + sqrt(ks² + 2ks)), which equals the textbook
 * 1 + ks − sqrt(ks² + 2ks) but does not lose precision for large K/S.
 */
export function ksToReflectance(ks: number): number {
  return 1 / (1 + ks + Math.sqrt(ks * (ks + 2)));
}

function assertBandCount(spectrum: ArrayLike<number>): void {
  if (spectrum.length !== BANDS) {
    throw new RangeError(`Expected a spectrum of ${BANDS} bands, received ${spectrum.length}`);
  }
}

function assertRatio(ratio: readonly [number, number]): void {
  const [a, b] = ratio;
  if (!(a >= 0) || !(b >= 0) || !Number.isFinite(a) || !Number.isFinite(b) || a + b === 0) {
    throw new RangeError(`Invalid mix ratio [${a}, ${b}]: parts must be finite, non-negative and not both zero`);
  }
}

// ---------------------------------------------------------------------------
// Prepared pigments
// ---------------------------------------------------------------------------

/** Measured data for one catalogue item. Anything supplied replaces the hex-derived estimate. */
export interface PigmentOverride {
  /**
   * Measured reflectance, one value in (0, 1] per band of `WAVELENGTHS_NM`
   * ({@link BAND_COUNT} bands of 20 nm). Average a finer instrument reading
   * over each band before passing it in.
   */
  reflectance?: readonly number[];
  /**
   * Relative tinting strength; 1 is neutral. Use above 1 for pigments that
   * dominate a mix (phthalo blue, carbon black) and below 1 for weak ones.
   */
  tintStrength?: number;
}

/** Overrides keyed by `CatalogItem.id`. */
export type PigmentOverrides = ReadonlyMap<string, PigmentOverride>;

/**
 * A stash converted once into flat typed arrays so repeated searches are
 * cheap. Build with {@link preparePigments}; treat as opaque and immutable.
 */
export interface PreparedPigments {
  readonly items: readonly CatalogItem[];
  /** K/S per band, `items.length * BANDS` values, row-major. */
  readonly ks: Float64Array;
  /** Mixing weight per part: scattering estimate times tint strength. */
  readonly weight: Float64Array;
  /** L* of each pigment as the spectral model sees it. */
  readonly lightness: Float64Array;
  readonly mediumCode: Uint8Array;
  readonly finishClassCode: Uint8Array;
  readonly mixable: Uint8Array;
}

function lightnessFromY(y: number): number {
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

/**
 * Convert catalogue items into the spectral form used by the mixer.
 * Cost is linear in the number of items; do it once per stash and reuse it.
 *
 * `item.color.lab` is treated as the authoritative colour, so a
 * spectrophotometer reading stored there is honoured even if `hex` is rounded.
 */
export function preparePigments(items: readonly CatalogItem[], overrides?: PigmentOverrides): PreparedPigments {
  const count = items.length;
  const ks = new Float64Array(count * BANDS);
  const weight = new Float64Array(count);
  const lightness = new Float64Array(count);
  const mediumCode = new Uint8Array(count);
  const finishClassCode = new Uint8Array(count);
  const mixable = new Uint8Array(count);
  const reflectance = new Float64Array(BANDS);

  for (let index = 0; index < count; index++) {
    const item = items[index] as CatalogItem;
    const override = overrides?.get(item.id);

    if (override?.reflectance) {
      assertBandCount(override.reflectance);
      for (let band = 0; band < BANDS; band++) {
        reflectance[band] = clampReflectance(override.reflectance[band] as number);
      }
    } else {
      reflectanceFromLinearRgb(xyzToLinearRgb(labToXyz(item.color.lab)), reflectance);
    }

    let luminance = 0;
    const offset = index * BANDS;
    for (let band = 0; band < BANDS; band++) {
      const r = reflectance[band] as number;
      ks[offset + band] = ((1 - r) * (1 - r)) / (2 * r);
      luminance += (TO_Y[band] as number) * r;
    }

    const tintStrength = override?.tintStrength ?? 1;
    if (!(tintStrength > 0) || !Number.isFinite(tintStrength)) {
      throw new RangeError(`tintStrength for "${item.id}" must be a positive finite number`);
    }
    weight[index] = tintStrength * Math.pow(luminance, SCATTERING_EXPONENT);
    lightness[index] = lightnessFromY(luminance);
    mediumCode[index] = MEDIUM_CODES.indexOf(item.medium);
    finishClassCode[index] = FINISH_CLASS_CODES.indexOf(finishClassOf(item.finish));
    mixable[index] = isMixableMedium(item.medium) ? 1 : 0;
  }

  return { items, ks, weight, lightness, mediumCode, finishClassCode, mixable };
}

function isPrepared(value: PreparedPigments | readonly CatalogItem[]): value is PreparedPigments {
  return !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Single mix prediction
// ---------------------------------------------------------------------------

/**
 * Core mixing step shared by prediction and search. Writes XYZ into
 * `xyzOut` and allocates nothing.
 */
function mixInto(
  ks: Float64Array,
  offsetA: number,
  offsetB: number,
  fractionA: number,
  xyzOut: Float64Array,
): void {
  const fractionB = 1 - fractionA;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let band = 0; band < BANDS; band++) {
    const mixed = fractionA * (ks[offsetA + band] as number) + fractionB * (ks[offsetB + band] as number);
    const r = 1 / (1 + mixed + Math.sqrt(mixed * (mixed + 2)));
    x += (TO_X[band] as number) * r;
    y += (TO_Y[band] as number) * r;
    z += (TO_Z[band] as number) * r;
  }
  xyzOut[0] = x;
  xyzOut[1] = y;
  xyzOut[2] = z;
}

/**
 * Predict the colour of `ratio[0]` parts of A mixed with `ratio[1]` parts of B.
 *
 * This is pure physics: it does not check medium or finish compatibility.
 * Use {@link canMix} first, or {@link findBestTwoPartMixes}, which enforces the rules.
 *
 * @throws {RangeError} when the ratio is negative, non-finite or [0, 0].
 */
export function predictMix(
  a: CatalogItem,
  b: CatalogItem,
  ratio: readonly [number, number],
  overrides?: PigmentOverrides,
): ColorCoordinates {
  assertRatio(ratio);
  const prepared = preparePigments([a, b], overrides);
  const weightA = ratio[0] * (prepared.weight[0] as number);
  const weightB = ratio[1] * (prepared.weight[1] as number);
  const xyz = new Float64Array(3);
  mixInto(prepared.ks, 0, BANDS, weightA / (weightA + weightB), xyz);
  return colorFromXyz([xyz[0] as number, xyz[1] as number, xyz[2] as number]);
}

// ---------------------------------------------------------------------------
// Two-part mix search
// ---------------------------------------------------------------------------

/** Ratios from the specification. Each is tried in both directions (2:1 and 1:2). */
export const DEFAULT_MIX_RATIOS: readonly (readonly [number, number])[] = [
  [1, 1],
  [2, 1],
  [3, 1],
  [4, 1],
];

export interface MixSearchOptions extends FinishRuleOptions {
  /** Integer part ratios to try, each in both directions. Default {@link DEFAULT_MIX_RATIOS}. */
  ratios?: readonly (readonly [number, number])[];
  /** CIEDE2000 parametric factors. */
  weights?: DeltaE2000Weights;
  /** How many mixes to return, best first, at most one per pair of items. Default 1. */
  limit?: number;
  /**
   * Only return mixes with ΔE00 strictly below this. Passing the best
   * single-item ΔE00 here both filters out pointless mixes and speeds the
   * search up considerably.
   */
  maxDeltaE?: number;
  /**
   * Restrict which items may be used as mix components, e.g. to one medium or
   * one finish class. Called once per item, not once per pair.
   */
  eligible?: (item: CatalogItem) => boolean;
}

interface Candidate {
  indexA: number;
  indexB: number;
  partsA: number;
  partsB: number;
  deltaE00: number;
  x: number;
  y: number;
  z: number;
}

const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;
const WHITE_X = D65_WHITE[0];
const WHITE_Z = D65_WHITE[2];

function labF(t: number): number {
  return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

function expandRatios(ratios: readonly (readonly [number, number])[]): Array<[number, number]> {
  const seen = new Set<number>();
  const out: Array<[number, number]> = [];
  for (const ratio of ratios) {
    assertRatio(ratio);
    if (ratio[0] === 0 || ratio[1] === 0) {
      throw new RangeError(`Mix ratio [${ratio[0]}, ${ratio[1]}] must have two non-zero parts`);
    }
    for (const [a, b] of [
      [ratio[0], ratio[1]],
      [ratio[1], ratio[0]],
    ] as const) {
      const fraction = a / (a + b);
      if (seen.has(fraction)) continue;
      seen.add(fraction);
      out.push([a, b]);
    }
  }
  return out;
}

/**
 * Find the two-part mixes closest to a target colour.
 *
 * Every compatible pair is evaluated at every ratio; the result is exact, not
 * a heuristic sample. Pairs are skipped only when a mathematical lower bound
 * on ΔE00 (from lightness alone) already rules them out.
 *
 * @param targetLab Target colour in CIELAB.
 * @param pigments The items to mix from: normally the user's owned stash.
 *   Pass a {@link PreparedPigments} when solving several targets in a row.
 * @returns Up to `limit` mixes, best first, one per pair. Empty when nothing
 *   is compatible or nothing beats `maxDeltaE`.
 */
export function findBestTwoPartMixes(
  targetLab: ReadonlyVec3,
  pigments: PreparedPigments | readonly CatalogItem[],
  options: MixSearchOptions = {},
): TwoPartMix[] {
  const prepared = isPrepared(pigments) ? pigments : preparePigments(pigments);
  const { items, ks, weight, lightness, mediumCode, finishClassCode, mixable } = prepared;
  const count = items.length;
  const limit = Math.max(1, Math.floor(options.limit ?? 1));
  const allowExperimental = options.experimentalFinishes === true;
  const ratios = expandRatios(options.ratios ?? DEFAULT_MIX_RATIOS);
  const ratioCount = ratios.length;
  const kL = options.weights?.kL ?? 1;
  const kC = options.weights?.kC ?? 1;
  const kH = options.weights?.kH ?? 1;
  const targetL = targetLab[0];
  const targetA = targetLab[1];
  const targetB = targetLab[2];
  /** ΔE00 >= |ΔL*| · lightnessBound, see MAX_LIGHTNESS_WEIGHT. */
  const lightnessBound = 1 / (kL * MAX_LIGHTNESS_WEIGHT);

  const usable = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    if (mixable[index] !== 1 || finishClassCode[index] === VARIEGATED_CODE) continue;
    if (options.eligible !== undefined && !options.eligible(items[index] as CatalogItem)) continue;
    usable[index] = 1;
  }

  const best: Candidate[] = [];
  let threshold = options.maxDeltaE ?? Number.POSITIVE_INFINITY;
  const pairBase = new Float64Array(BANDS);
  const pairSlope = new Float64Array(BANDS);

  // Visit pigments nearest the target first. Good mixes usually involve a
  // near neighbour, so the threshold tightens early and the bounds below
  // discard more of the remaining pairs. The result does not depend on order
  // except between exact ties.
  const order: number[] = [];
  const distance = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    if (usable[index] !== 1) continue;
    const lab = (items[index] as CatalogItem).color.lab;
    distance[index] = fullDeltaE(targetL, targetA, targetB, lab[0], lab[1], lab[2], kL, kC, kH);
    order.push(index);
  }
  order.sort((p, q) => (distance[p] as number) - (distance[q] as number) || p - q);
  const usableCount = order.length;

  for (let orderI = 0; orderI < usableCount; orderI++) {
    const i = order[orderI] as number;
    const classI = finishClassCode[i] as number;
    const mediumI = mediumCode[i] as number;
    const lightnessI = lightness[i] as number;
    const weightI = weight[i] as number;
    const offsetI = i * BANDS;

    for (let orderJ = orderI + 1; orderJ < usableCount; orderJ++) {
      const j = order[orderJ] as number;
      if (mediumCode[j] !== mediumI) continue;
      if (finishClassCode[j] !== classI && !allowExperimental) continue;

      // Upper bound. Reflectance is a convex function of K/S, so a mix is
      // never lighter than the weighted average of its components, and so
      // never lighter than the lighter one.
      const lightnessJ = lightness[j] as number;
      const lightest = lightnessI > lightnessJ ? lightnessI : lightnessJ;
      if ((targetL - lightest) * lightnessBound >= threshold) continue;

      // Lower bound. A mix can be darker than both components (blue + yellow),
      // but in each band it is never darker than the darker of the two, i.e.
      // never has a higher K/S than the higher of the two.
      const offsetJ = j * BANDS;
      const darkest = lightnessI < lightnessJ ? lightnessI : lightnessJ;
      if ((darkest - targetL) * lightnessBound >= threshold) {
        let floorY = 0;
        for (let band = 0; band < BANDS; band++) {
          const ksI = ks[offsetI + band] as number;
          const ksJ = ks[offsetJ + band] as number;
          const highest = ksI > ksJ ? ksI : ksJ;
          floorY += (TO_Y[band] as number) / (1 + highest + Math.sqrt(highest * (highest + 2)));
        }
        if ((lightnessFromY(floorY) - targetL) * lightnessBound >= threshold) continue;
      }

      // Per-band K/S of the pair: mixed = ksJ + fraction · (ksI − ksJ).
      for (let band = 0; band < BANDS; band++) {
        const ksJ = ks[offsetJ + band] as number;
        pairBase[band] = ksJ;
        pairSlope[band] = (ks[offsetI + band] as number) - ksJ;
      }

      const weightJ = weight[j] as number;
      let pairBest = threshold;
      let pairRatio = -1;
      let pairX = 0;
      let pairY = 0;
      let pairZ = 0;

      for (let r = 0; r < ratioCount; r++) {
        const ratio = ratios[r] as [number, number];
        const partI = ratio[0] * weightI;
        const fraction = partI / (partI + ratio[1] * weightJ);
        let x = 0;
        let y = 0;
        let z = 0;
        for (let band = 0; band < BANDS; band++) {
          const mixed = (pairBase[band] as number) + fraction * (pairSlope[band] as number);
          // Textbook form. K/S never exceeds MAX_KS here, so the subtraction
          // keeps about ten significant digits, and it avoids a division.
          const reflectance = 1 + mixed - Math.sqrt(mixed * (mixed + 2));
          x += (TO_X[band] as number) * reflectance;
          y += (TO_Y[band] as number) * reflectance;
          z += (TO_Z[band] as number) * reflectance;
        }
        const fy = labF(y);
        const mixL = 116 * fy - 16;
        const deltaL = mixL - targetL;
        if ((deltaL < 0 ? -deltaL : deltaL) * lightnessBound >= pairBest) continue;
        const mixA = 500 * (labF(x / WHITE_X) - fy);
        const mixB = 200 * (fy - labF(z / WHITE_Z));
        if (lowerBound(targetL, targetA, targetB, mixL, mixA, mixB, kL, kC, kH) >= pairBest) continue;
        const deltaE = fullDeltaE(targetL, targetA, targetB, mixL, mixA, mixB, kL, kC, kH);
        if (deltaE < pairBest) {
          pairBest = deltaE;
          pairRatio = r;
          pairX = x;
          pairY = y;
          pairZ = z;
        }
      }

      if (pairRatio < 0) continue;
      const ratio = ratios[pairRatio] as [number, number];
      const candidate: Candidate = {
        indexA: i,
        indexB: j,
        partsA: ratio[0],
        partsB: ratio[1],
        deltaE00: pairBest,
        x: pairX,
        y: pairY,
        z: pairZ,
      };
      let position = best.length;
      while (position > 0 && (best[position - 1] as Candidate).deltaE00 > pairBest) position--;
      best.splice(position, 0, candidate);
      if (best.length > limit) best.pop();
      if (best.length === limit) threshold = (best[limit - 1] as Candidate).deltaE00;
    }
  }

  return best.map((candidate) => {
    // Present the larger share first: "2 parts A to 1 part B".
    const swap = candidate.partsA < candidate.partsB;
    const itemA = items[swap ? candidate.indexB : candidate.indexA] as CatalogItem;
    const itemB = items[swap ? candidate.indexA : candidate.indexB] as CatalogItem;
    const mixXyz: Vec3 = [candidate.x, candidate.y, candidate.z];
    const warnings: MixWarning[] = [];
    if (itemA.opacity < LOW_OPACITY_THRESHOLD || itemB.opacity < LOW_OPACITY_THRESHOLD) warnings.push('low_opacity');
    if (finishClassOf(itemA.finish) !== finishClassOf(itemB.finish)) warnings.push('experimental_finish');
    if (!isXyzInSrgbGamut(mixXyz)) warnings.push('display_clipped');
    return {
      itemA,
      itemB,
      ratio: swap ? [candidate.partsB, candidate.partsA] : [candidate.partsA, candidate.partsB],
      predictedColor: colorFromXyz(mixXyz),
      deltaE00: candidate.deltaE00,
      warnings,
    };
  });
}

/** Convenience wrapper returning only the single best mix, or `undefined` when there is none. */
export function findBestTwoPartMix(
  targetLab: ReadonlyVec3,
  pigments: PreparedPigments | readonly CatalogItem[],
  options: MixSearchOptions = {},
): TwoPartMix | undefined {
  return findBestTwoPartMixes(targetLab, pigments, { ...options, limit: 1 })[0];
}
