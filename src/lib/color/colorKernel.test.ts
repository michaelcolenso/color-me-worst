import { describe, expect, it } from 'vitest';

import {
  BAND_COUNT,
  D65_WHITE,
  DEFAULT_MIX_RATIOS,
  GAP_DELTA_E,
  LINEAR_SRGB_TO_XYZ,
  MAX_LIGHTNESS_WEIGHT,
  MIN_REFLECTANCE,
  WAVELENGTHS_NM,
  canMix,
  canSubstituteFinish,
  classifyDeltaE,
  colorFromHex,
  colorFromLab,
  colorFromRgb8,
  createMatchSolver,
  deltaE2000,
  deltaE2000Breakdown,
  deltaE2000LowerBound,
  deltaE76,
  displayCaveatOf,
  findBestTwoPartMix,
  findBestTwoPartMixes,
  finishClassOf,
  hexToLab,
  hexToRgb8,
  isLabInSrgbGamut,
  isValidHex,
  ksToReflectance,
  labToHex,
  labToLch,
  labToXyz,
  lchToLab,
  linearChannelToSrgb,
  linearRgbToXyz,
  mixCompatibility,
  oklabToOklch,
  oklabToXyz,
  oklchToOklab,
  predictMix,
  preparePigments,
  reflectanceFromLinearRgb,
  reflectanceToKS,
  reflectanceToXyz,
  rgb8ToHex,
  rgb8ToLinearRgb,
  solveMatch,
  srgbChannelToLinear,
  xyzToLab,
  xyzToLinearRgb,
  xyzToOklab,
  type CatalogItem,
  type FinishType,
  type MediumType,
  type ReadonlyVec3,
  type Vec3,
} from './index';
import { BASIS_B, BASIS_G, BASIS_R, SPECTRAL_TO_XYZ } from './spectralData';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Sharma, Wu & Dalal (2005), Table 1: all 34 reference pairs.
 * Columns: [L*, a*, b*] of colour 1, [L*, a*, b*] of colour 2, expected ΔE00.
 */
const SHARMA_PAIRS: ReadonlyArray<readonly [ReadonlyVec3, ReadonlyVec3, number]> = [
  [[50.0000, 2.6772, -79.7751], [50.0000, 0.0000, -82.7485], 2.0425],
  [[50.0000, 3.1571, -77.2803], [50.0000, 0.0000, -82.7485], 2.8615],
  [[50.0000, 2.8361, -74.0200], [50.0000, 0.0000, -82.7485], 3.4412],
  [[50.0000, -1.3802, -84.2814], [50.0000, 0.0000, -82.7485], 1.0000],
  [[50.0000, -1.1848, -84.8006], [50.0000, 0.0000, -82.7485], 1.0000],
  [[50.0000, -0.9009, -85.5211], [50.0000, 0.0000, -82.7485], 1.0000],
  [[50.0000, 0.0000, 0.0000], [50.0000, -1.0000, 2.0000], 2.3669],
  [[50.0000, -1.0000, 2.0000], [50.0000, 0.0000, 0.0000], 2.3669],
  [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0009], 7.1792],
  [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0010], 7.1792],
  [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0011], 7.2195],
  [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0012], 7.2195],
  [[50.0000, -0.0010, 2.4900], [50.0000, 0.0009, -2.4900], 4.8045],
  [[50.0000, -0.0010, 2.4900], [50.0000, 0.0010, -2.4900], 4.8045],
  [[50.0000, -0.0010, 2.4900], [50.0000, 0.0011, -2.4900], 4.7461],
  [[50.0000, 2.5000, 0.0000], [50.0000, 0.0000, -2.5000], 4.3065],
  [[50.0000, 2.5000, 0.0000], [73.0000, 25.0000, -18.0000], 27.1492],
  [[50.0000, 2.5000, 0.0000], [61.0000, -5.0000, 29.0000], 22.8977],
  [[50.0000, 2.5000, 0.0000], [56.0000, -27.0000, -3.0000], 31.9030],
  [[50.0000, 2.5000, 0.0000], [58.0000, 24.0000, 15.0000], 19.4535],
  [[50.0000, 2.5000, 0.0000], [50.0000, 3.1736, 0.5854], 1.0000],
  [[50.0000, 2.5000, 0.0000], [50.0000, 3.2972, 0.0000], 1.0000],
  [[50.0000, 2.5000, 0.0000], [50.0000, 1.8634, 0.5757], 1.0000],
  [[50.0000, 2.5000, 0.0000], [50.0000, 3.2592, 0.3350], 1.0000],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.2630],
  [[61.2901, 3.7196, -5.3901], [61.4292, 2.2480, -4.9620], 1.8731],
  [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
  [[22.7233, 20.0904, -46.6940], [23.0331, 14.9730, -42.5619], 2.0373],
  [[36.4612, 47.8580, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  [[90.8027, -2.0831, 1.4410], [91.1528, -1.6435, 0.0447], 1.4441],
  [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
  [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
  [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082],
];

/** Deterministic PRNG (mulberry32) so every run tests the same values. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 0;
function makeItem(
  hex: string,
  overrides: Partial<Omit<CatalogItem, 'color'>> & { name?: string } = {},
): CatalogItem {
  nextId += 1;
  return {
    id: overrides.id ?? `item-${nextId}`,
    brand: overrides.brand ?? 'Test Brand',
    line: overrides.line ?? 'Test Line',
    sku: overrides.sku ?? `SKU-${nextId}`,
    name: overrides.name ?? hex,
    medium: overrides.medium ?? 'acrylic_paint',
    finish: overrides.finish ?? 'matte',
    opacity: overrides.opacity ?? 1,
    color: colorFromHex(hex),
    discontinued: overrides.discontinued ?? false,
  };
}

function randomHex(random: () => number): string {
  return rgb8ToHex([random() * 255, random() * 255, random() * 255]);
}

function randomStash(size: number, seed: number): CatalogItem[] {
  const random = createRandom(seed);
  return Array.from({ length: size }, () => makeItem(randomHex(random)));
}

function expectVecClose(actual: ReadonlyVec3, expected: ReadonlyVec3, tolerance: number): void {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs((actual[i] as number) - (expected[i] as number))).toBeLessThanOrEqual(tolerance);
  }
}

// ---------------------------------------------------------------------------
// colorConversions
// ---------------------------------------------------------------------------

describe('colorConversions', () => {
  it('parses and formats hex colours', () => {
    expect(hexToRgb8('#ff8000')).toEqual([255, 128, 0]);
    expect(hexToRgb8('FF8000')).toEqual([255, 128, 0]);
    expect(hexToRgb8(' #f80 ')).toEqual([255, 136, 0]);
    expect(rgb8ToHex([255, 128, 0])).toBe('#ff8000');
    expect(rgb8ToHex([300, -5, 15.6])).toBe('#ff0010');
    expect(isValidHex('#abc')).toBe(true);
    expect(isValidHex('#abcd')).toBe(false);
  });

  it('rejects malformed hex colours', () => {
    for (const bad of ['', '#', '#12', '#12345', '#gggggg', 'red', '#1234567']) {
      expect(() => hexToRgb8(bad)).toThrow(RangeError);
    }
  });

  it('round-trips every 8-bit channel value through the transfer function', () => {
    for (let value = 0; value <= 255; value++) {
      const encoded = value / 255;
      expect(linearChannelToSrgb(srgbChannelToLinear(encoded))).toBeCloseTo(encoded, 12);
    }
    expect(srgbChannelToLinear(-0.5)).toBeCloseTo(-srgbChannelToLinear(0.5), 15);
  });

  it('derives the published sRGB matrix and D65 white', () => {
    const published = [
      [0.4124, 0.3576, 0.1805],
      [0.2126, 0.7152, 0.0722],
      [0.0193, 0.1192, 0.9505],
    ];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        expect((LINEAR_SRGB_TO_XYZ[row] as ReadonlyVec3)[col]).toBeCloseTo((published[row] as number[])[col] as number, 4);
      }
    }
    expectVecClose(D65_WHITE, [0.9505, 1, 1.089], 5e-4);
    expectVecClose(linearRgbToXyz([1, 1, 1]), D65_WHITE, 1e-12);
  });

  it('maps white, black and the sRGB primaries to their known CIELAB values', () => {
    expectVecClose(hexToLab('#ffffff'), [100, 0, 0], 1e-9);
    expectVecClose(hexToLab('#000000'), [0, 0, 0], 1e-9);
    // Widely published D65 values; tolerance covers the 4th-digit white point convention.
    expectVecClose(hexToLab('#ff0000'), [53.24, 80.09, 67.2], 0.05);
    expectVecClose(hexToLab('#00ff00'), [87.73, -86.18, 83.18], 0.05);
    expectVecClose(hexToLab('#0000ff'), [32.3, 79.19, -107.86], 0.05);
    expectVecClose(hexToLab('#777777'), [50.03, 0, 0], 0.01);
  });

  it('matches the reference OKLab values from Ottosson', () => {
    expectVecClose(xyzToOklab([0.95, 1, 1.089]), [1, 0, 0], 1e-3);
    expectVecClose(xyzToOklab([1, 0, 0]), [0.45, 1.236, -0.019], 1e-3);
    expectVecClose(xyzToOklab([0, 1, 0]), [0.922, -0.671, 0.263], 1e-3);
    expectVecClose(xyzToOklab([0, 0, 1]), [0.153, -1.415, -0.449], 1e-3);
    expectVecClose(xyzToOklab(D65_WHITE), [1, 0, 0], 1e-9);
  });

  it('round-trips XYZ <-> Lab, XYZ <-> OKLab and the polar forms', () => {
    const random = createRandom(11);
    for (let i = 0; i < 500; i++) {
      const xyz = linearRgbToXyz([random(), random(), random()]);
      expectVecClose(labToXyz(xyzToLab(xyz)), xyz, 1e-12);
      expectVecClose(oklabToXyz(xyzToOklab(xyz)), xyz, 1e-9);
      const lab = xyzToLab(xyz);
      expectVecClose(lchToLab(labToLch(lab)), lab, lab[1] ** 2 + lab[2] ** 2 < 1e-6 ? 1e-3 : 1e-9);
      const oklab = xyzToOklab(xyz);
      expectVecClose(oklchToOklab(oklabToOklch(oklab)), oklab, oklab[1] ** 2 + oklab[2] ** 2 < 1e-8 ? 1e-4 : 1e-12);
    }
  });

  it('round-trips all 8-bit colours on a dense grid through Lab back to hex', () => {
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const hex = rgb8ToHex([r, g, b]);
          expect(labToHex(hexToLab(hex))).toBe(hex);
        }
      }
    }
  });

  it('reports hue 0 for achromatic colours and degrees in [0, 360) otherwise', () => {
    expect(colorFromHex('#808080').oklch[2]).toBe(0);
    expect(colorFromHex('#808080').oklch[1]).toBeLessThan(1e-4);
    const blue = colorFromHex('#0000ff').oklch;
    expect(blue[2]).toBeGreaterThan(260);
    expect(blue[2]).toBeLessThan(270);
    const random = createRandom(5);
    for (let i = 0; i < 200; i++) {
      const hue = colorFromHex(randomHex(random)).oklch[2];
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('builds consistent ColorCoordinates records', () => {
    const color = colorFromHex('#3A7BD5');
    expect(color.hex).toBe('#3a7bd5');
    expect(color.rgb).toEqual([58, 123, 213]);
    expect(colorFromRgb8([58, 123, 213])).toEqual(color);
    const fromLab = colorFromLab(color.lab);
    expect(fromLab.hex).toBe(color.hex);
    expectVecClose(fromLab.oklch, color.oklch, 1e-9);
  });

  it('detects colours outside the sRGB gamut and clamps their hex', () => {
    expect(isLabInSrgbGamut(hexToLab('#ff0000'))).toBe(true);
    expect(isLabInSrgbGamut(hexToLab('#000000'))).toBe(true);
    const neon: Vec3 = [80, -120, 100];
    expect(isLabInSrgbGamut(neon)).toBe(false);
    const clamped = colorFromLab(neon);
    expect(clamped.lab).toEqual(neon);
    expect(clamped.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(clamped.rgb.every((channel) => channel >= 0 && channel <= 255)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deltaE2000
// ---------------------------------------------------------------------------

describe('deltaE2000', () => {
  it('has all 34 Sharma et al. (2005) reference pairs', () => {
    expect(SHARMA_PAIRS).toHaveLength(34);
  });

  it.each(SHARMA_PAIRS.map((pair, index) => [index + 1, ...pair] as const))(
    'matches Sharma pair %i to 4 decimal places in both directions',
    (_index, lab1, lab2, expected) => {
      expect(deltaE2000(lab1, lab2).toFixed(4)).toBe(expected.toFixed(4));
      expect(deltaE2000(lab2, lab1).toFixed(4)).toBe(expected.toFixed(4));
    },
  );

  it('is zero for identical colours and symmetric for random ones', () => {
    const random = createRandom(42);
    for (let i = 0; i < 1000; i++) {
      const a: Vec3 = [random() * 100, random() * 200 - 100, random() * 200 - 100];
      const b: Vec3 = [random() * 100, random() * 200 - 100, random() * 200 - 100];
      expect(deltaE2000(a, a)).toBe(0);
      const forward = deltaE2000(a, b);
      expect(forward).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(forward)).toBe(true);
      expect(Math.abs(forward - deltaE2000(b, a))).toBeLessThan(1e-10);
    }
  });

  it('applies the parametric weighting factors', () => {
    const lightnessOnly: [Vec3, Vec3] = [
      [40, 10, 10],
      [60, 10, 10],
    ];
    const base = deltaE2000(...lightnessOnly);
    expect(deltaE2000(...lightnessOnly, { kL: 2 })).toBeCloseTo(base / 2, 10);
    expect(deltaE2000(...lightnessOnly, { kC: 2, kH: 2 })).toBeCloseTo(base, 10);

    const chromaOnly: [Vec3, Vec3] = [
      [50, 20, 0],
      [50, 40, 0],
    ];
    expect(deltaE2000(...chromaOnly, { kC: 2 })).toBeCloseTo(deltaE2000(...chromaOnly) / 2, 10);
    expect(deltaE2000(...chromaOnly, { kL: 2 })).toBeCloseTo(deltaE2000(...chromaOnly), 10);
  });

  it('breaks the difference down into signed lightness, chroma and hue terms', () => {
    const breakdown = deltaE2000Breakdown([50, 20, 10], [60, 30, 25]);
    expect(breakdown.lightness).toBeGreaterThan(0);
    expect(breakdown.chroma).toBeGreaterThan(0);
    const recomposed = Math.sqrt(
      breakdown.lightness ** 2 + breakdown.chroma ** 2 + breakdown.hue ** 2 + breakdown.rotation,
    );
    expect(recomposed).toBeCloseTo(breakdown.deltaE00, 12);
    expect(breakdown.deltaE00).toBe(deltaE2000([50, 20, 10], [60, 30, 25]));
  });

  it('never falls below the lightness lower bound used for search pruning', () => {
    const random = createRandom(7);
    for (let i = 0; i < 5000; i++) {
      const a: Vec3 = [random() * 100, random() * 256 - 128, random() * 256 - 128];
      const b: Vec3 = [random() * 100, random() * 256 - 128, random() * 256 - 128];
      const bound = Math.abs(a[0] - b[0]) / MAX_LIGHTNESS_WEIGHT;
      expect(deltaE2000(a, b)).toBeGreaterThanOrEqual(bound - 1e-9);
    }
  });

  it('has a cheap lower bound that never exceeds the true value, for any weights', () => {
    const random = createRandom(13);
    let tightest = 0;
    for (let i = 0; i < 20000; i++) {
      const spread = i % 2 === 0 ? 128 : 12; // include the near-neutral region
      const a: Vec3 = [random() * 100, (random() * 2 - 1) * spread, (random() * 2 - 1) * spread];
      const b: Vec3 = [random() * 100, (random() * 2 - 1) * spread, (random() * 2 - 1) * spread];
      const weights = i % 3 === 0 ? { kL: 1 + random() * 2, kC: 0.5 + random() * 2, kH: 0.5 + random() * 2 } : {};
      const actual = deltaE2000(a, b, weights);
      const bound = deltaE2000LowerBound(...a, ...b, weights.kL, weights.kC, weights.kH);
      expect(bound).toBeGreaterThanOrEqual(0);
      expect(bound).toBeLessThanOrEqual(actual + 1e-9);
      if (actual > 0) tightest = Math.max(tightest, bound / actual);
    }
    // Not vacuous: for some pairs the bound is close to the true value.
    expect(tightest).toBeGreaterThan(0.9);
  });

  it('classifies differences into the specification bands', () => {
    expect(classifyDeltaE(0)).toBe('exact');
    expect(classifyDeltaE(1.49)).toBe('exact');
    expect(classifyDeltaE(1.5)).toBe('close');
    expect(classifyDeltaE(2.99)).toBe('close');
    expect(classifyDeltaE(3)).toBe('noticeable');
    expect(classifyDeltaE(4.99)).toBe('noticeable');
    expect(classifyDeltaE(5)).toBe('poor');
  });

  it('discounts chroma steps between saturated colours, unlike plain Lab distance', () => {
    const a: Vec3 = [50, 80, 0];
    const b: Vec3 = [50, 100, 0];
    expect(deltaE76(a, b)).toBeCloseTo(20, 12);
    expect(deltaE2000(a, b)).toBeLessThan(deltaE76(a, b) / 3);
    // The same 20-unit step from neutral is a large visible difference.
    expect(deltaE2000([50, 0, 0], [50, 20, 0])).toBeGreaterThan(deltaE2000(a, b) * 3);
  });
});

// ---------------------------------------------------------------------------
// spectral data
// ---------------------------------------------------------------------------

describe('spectral basis', () => {
  it('covers the visible range in 18 bands of 20 nm', () => {
    expect(BAND_COUNT).toBe(18);
    expect(WAVELENGTHS_NM).toHaveLength(BAND_COUNT);
    expect(WAVELENGTHS_NM[0]).toBe(385);
    expect(WAVELENGTHS_NM[BAND_COUNT - 1]).toBe(725);
    for (let band = 1; band < BAND_COUNT; band++) {
      expect((WAVELENGTHS_NM[band] as number) - (WAVELENGTHS_NM[band - 1] as number)).toBe(20);
    }
    for (const table of [BASIS_R, BASIS_G, BASIS_B, ...SPECTRAL_TO_XYZ]) expect(table).toHaveLength(BAND_COUNT);
  });

  it('is a partition of unity with every band in [0, 1]', () => {
    for (let band = 0; band < BAND_COUNT; band++) {
      const r = BASIS_R[band] as number;
      const g = BASIS_G[band] as number;
      const b = BASIS_B[band] as number;
      for (const value of [r, g, b]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(r + g + b).toBeCloseTo(1, 7);
    }
  });

  it('integrates a perfect reflector to the D65 white', () => {
    expectVecClose(reflectanceToXyz(new Float64Array(BAND_COUNT).fill(1)), D65_WHITE, 1e-8);
  });

  it('reproduces each linear sRGB primary exactly', () => {
    const bases = [BASIS_R, BASIS_G, BASIS_B];
    bases.forEach((basis, k) => {
      const linear = xyzToLinearRgb(reflectanceToXyz(basis));
      const expected: Vec3 = [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0];
      expectVecClose(linear, expected, 1e-6);
    });
  });

  it('round-trips arbitrary colours through a reflectance spectrum', () => {
    const random = createRandom(3);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const hex = randomHex(random);
      const lab = hexToLab(hex);
      const reflectance = reflectanceFromLinearRgb(rgb8ToLinearRgb(hexToRgb8(hex)));
      for (const value of reflectance) {
        expect(value).toBeGreaterThanOrEqual(MIN_REFLECTANCE);
        expect(value).toBeLessThanOrEqual(1);
      }
      worst = Math.max(worst, deltaE2000(lab, xyzToLab(reflectanceToXyz(reflectance))));
    }
    // The only loss is the MIN_REFLECTANCE floor, which matters near black.
    expect(worst).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// pigmentMixer
// ---------------------------------------------------------------------------

describe('pigmentMixer: Kubelka-Munk model', () => {
  it('inverts K/S <-> reflectance, including very large K/S', () => {
    for (const r of [MIN_REFLECTANCE, 0.01, 0.1, 0.5, 0.9, 1]) {
      expect(ksToReflectance(reflectanceToKS(r))).toBeCloseTo(r, 12);
    }
    expect(reflectanceToKS(1)).toBe(0);
    expect(reflectanceToKS(0)).toBe(reflectanceToKS(MIN_REFLECTANCE));
    const tiny = ksToReflectance(1e12);
    expect(tiny).toBeGreaterThan(0);
    expect(tiny).toBeLessThan(1e-11);
  });

  it('returns the same colour when a paint is mixed with itself', () => {
    const random = createRandom(19);
    for (let i = 0; i < 200; i++) {
      const item = makeItem(randomHex(random));
      for (const ratio of [[1, 1], [3, 1]] as const) {
        expect(deltaE2000(item.color.lab, predictMix(item, item, ratio).lab)).toBeLessThan(1);
      }
    }
  });

  it('returns a component unchanged when the other has zero parts', () => {
    const a = makeItem('#c0392b');
    const b = makeItem('#2980b9');
    expect(predictMix(a, b, [1, 0]).hex).toBe(a.color.hex);
    expect(predictMix(a, b, [0, 1]).hex).toBe(b.color.hex);
  });

  it('is symmetric: A:B at m:n equals B:A at n:m', () => {
    const a = makeItem('#f1c40f');
    const b = makeItem('#8e44ad');
    expectVecClose(predictMix(a, b, [3, 1]).lab, predictMix(b, a, [1, 3]).lab, 1e-9);
  });

  it('mixes blue and yellow to green, where averaging RGB gives grey', () => {
    const blue = makeItem('#1f4fa3');
    const yellow = makeItem('#f7d417');
    const mix = predictMix(blue, yellow, [1, 1]);
    const [, chroma, hue] = mix.oklch;
    // OKLCh green sits roughly between 120° and 170°.
    expect(hue).toBeGreaterThan(115);
    expect(hue).toBeLessThan(175);
    expect(chroma).toBeGreaterThan(0.06);

    const blueLinear = rgb8ToLinearRgb(blue.color.rgb);
    const yellowLinear = rgb8ToLinearRgb(yellow.color.rgb);
    const average = xyzToLab(
      linearRgbToXyz([
        (blueLinear[0] + yellowLinear[0]) / 2,
        (blueLinear[1] + yellowLinear[1]) / 2,
        (blueLinear[2] + yellowLinear[2]) / 2,
      ]),
    );
    const averageChroma = Math.hypot(average[1], average[2]);
    const mixChroma = Math.hypot(mix.lab[1], mix.lab[2]);
    expect(mixChroma).toBeGreaterThan(averageChroma * 1.5);
    // Subtractive mixes are darker than the additive average.
    expect(mix.lab[0]).toBeLessThan(average[0]);
  });

  it('never makes a mix lighter than its lighter component, but can make it darker than both', () => {
    const random = createRandom(23);
    for (let i = 0; i < 300; i++) {
      const a = makeItem(randomHex(random));
      const b = makeItem(randomHex(random));
      const prepared = preparePigments([a, b]);
      const high = Math.max(prepared.lightness[0] as number, prepared.lightness[1] as number);
      for (const ratio of [[4, 1], [1, 1], [1, 4]] as const) {
        expect(predictMix(a, b, ratio).lab[0]).toBeLessThanOrEqual(high + 1e-9);
      }
    }
    // Complementary colours absorb each other's light.
    const orange = makeItem('#e8731a');
    const blue = makeItem('#1a5fe8');
    const mud = predictMix(orange, blue, [1, 1]).lab[0];
    expect(mud).toBeLessThan(Math.min(orange.color.lab[0], blue.color.lab[0]) - 1);
  });

  it('moves lightness monotonically as white is added', () => {
    const white = makeItem('#ffffff');
    const red = makeItem('#9a1115');
    const steps = [[1, 4], [1, 1], [4, 1]].map((ratio) => predictMix(white, red, ratio as [number, number]).lab[0]);
    expect(steps[0]).toBeLessThan(steps[1] as number);
    expect(steps[1]).toBeLessThan(steps[2] as number);
  });

  it('tints a strong red visibly towards pink with white', () => {
    const pink = predictMix(makeItem('#ffffff'), makeItem('#9a1115'), [1, 1]);
    const red = hexToLab('#9a1115');
    expect(pink.lab[0]).toBeGreaterThan(red[0] + 8);
    expect(pink.oklch[1]).toBeGreaterThan(0.05);
  });

  it('honours tint strength and measured reflectance overrides', () => {
    const blue = makeItem('#123c8c', { id: 'strong-blue' });
    const white = makeItem('#ffffff', { id: 'white' });
    const neutral = predictMix(blue, white, [1, 1]);
    const strong = predictMix(blue, white, [1, 1], new Map([['strong-blue', { tintStrength: 4 }]]));
    expect(strong.lab[0]).toBeLessThan(neutral.lab[0] - 3);

    const grey = new Array<number>(BAND_COUNT).fill(0.2);
    expect(BAND_COUNT).toBeGreaterThan(2);
    const measured = preparePigments([blue], new Map([['strong-blue', { reflectance: grey }]]));
    expect(measured.lightness[0]).toBeCloseTo(xyzToLab(reflectanceToXyz(grey))[0], 9);

    expect(() => preparePigments([blue], new Map([['strong-blue', { reflectance: [0.5, 0.5] }]]))).toThrow(RangeError);
    expect(() => preparePigments([blue], new Map([['strong-blue', { tintStrength: 0 }]]))).toThrow(RangeError);
  });

  it('rejects invalid ratios', () => {
    const a = makeItem('#112233');
    const b = makeItem('#445566');
    for (const ratio of [[0, 0], [-1, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1]] as const) {
      expect(() => predictMix(a, b, ratio)).toThrow(RangeError);
    }
    expect(() => findBestTwoPartMix([50, 0, 0], [a, b], { ratios: [[1, 0]] })).toThrow(RangeError);
  });
});

describe('pigmentMixer: compatibility rules', () => {
  const acrylic = (finish: FinishType) => makeItem('#808080', { medium: 'acrylic_paint', finish });

  it('groups finishes into physical classes', () => {
    expect(finishClassOf('matte')).toBe('solid');
    expect(finishClassOf('satin')).toBe('solid');
    expect(finishClassOf('gloss')).toBe('solid');
    expect(finishClassOf('wash')).toBe('transparent');
    expect(finishClassOf('contrast')).toBe('transparent');
    expect(finishClassOf('metallic')).toBe('metallic');
    expect(finishClassOf('fluorescent')).toBe('fluorescent');
    expect(finishClassOf('variegated')).toBe('variegated');
  });

  it('never mixes across media, even with experimental finishes on', () => {
    const oil = makeItem('#808080', { medium: 'oil_paint' });
    expect(mixCompatibility(acrylic('matte'), oil)).toBe('incompatible');
    expect(canMix(acrylic('matte'), oil, { experimentalFinishes: true })).toBe(false);
  });

  it('never mixes media that cannot be blended', () => {
    const media: MediumType[] = ['embroidery_floss', 'alcohol_marker', 'fabric', 'bead', 'leather_dye'];
    for (const medium of media) {
      const a = makeItem('#808080', { medium });
      const b = makeItem('#404040', { medium });
      expect(canMix(a, b, { experimentalFinishes: true })).toBe(false);
    }
  });

  it('mixes within a finish class and gates cross-class mixes behind the experimental flag', () => {
    expect(canMix(acrylic('matte'), acrylic('gloss'))).toBe(true);
    expect(canMix(acrylic('wash'), acrylic('contrast'))).toBe(true);
    expect(canMix(acrylic('metallic'), acrylic('metallic'))).toBe(true);
    expect(canMix(acrylic('metallic'), acrylic('matte'))).toBe(false);
    expect(canMix(acrylic('metallic'), acrylic('matte'), { experimentalFinishes: true })).toBe(true);
    expect(canMix(acrylic('wash'), acrylic('matte'))).toBe(false);
    expect(canMix(acrylic('variegated'), acrylic('variegated'), { experimentalFinishes: true })).toBe(false);
  });

  it('only substitutes within a finish class unless experimental', () => {
    expect(canSubstituteFinish('matte', 'satin')).toBe(true);
    expect(canSubstituteFinish('matte', 'metallic')).toBe(false);
    expect(canSubstituteFinish('matte', 'metallic', { experimentalFinishes: true })).toBe(true);
    expect(canSubstituteFinish('metallic', 'metallic')).toBe(true);
  });
});

describe('pigmentMixer: two-part search', () => {
  it('recovers a known mix and reports the larger share first', () => {
    const white = makeItem('#f4f4f0', { name: 'white' });
    const red = makeItem('#9a1115', { name: 'red' });
    const distractors = [makeItem('#1f4fa3'), makeItem('#2e7d32'), makeItem('#f7d417'), makeItem('#222222')];
    const target = predictMix(red, white, [1, 3]);
    const mix = findBestTwoPartMix(target.lab, [red, ...distractors, white]);
    expect(mix).toBeDefined();
    expect(mix?.itemA.name).toBe('white');
    expect(mix?.itemB.name).toBe('red');
    expect(mix?.ratio).toEqual([3, 1]);
    expect(mix?.deltaE00).toBeLessThan(1e-6);
    expect(mix?.predictedColor.hex).toBe(target.hex);
    expect(mix?.warnings).toEqual([]);
  });

  it('agrees with an unpruned brute-force search', () => {
    const stash = randomStash(60, 101);
    const random = createRandom(202);
    const ratios: Array<[number, number]> = [];
    for (const [a, b] of DEFAULT_MIX_RATIOS) {
      ratios.push([a, b]);
      if (a !== b) ratios.push([b, a]);
    }
    for (let trial = 0; trial < 25; trial++) {
      const target = hexToLab(randomHex(random));
      let bruteBest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < stash.length; i++) {
        for (let j = i + 1; j < stash.length; j++) {
          for (const ratio of ratios) {
            const predicted = predictMix(stash[i] as CatalogItem, stash[j] as CatalogItem, ratio);
            bruteBest = Math.min(bruteBest, deltaE2000(target, predicted.lab));
          }
        }
      }
      const found = findBestTwoPartMix(target, stash);
      expect(found?.deltaE00).toBeCloseTo(bruteBest, 9);
    }
  });

  it('returns results best-first, one per pair, and respects limit and maxDeltaE', () => {
    const stash = randomStash(30, 55);
    const target = hexToLab('#7a8f5c');
    const mixes = findBestTwoPartMixes(target, stash, { limit: 5 });
    expect(mixes).toHaveLength(5);
    const pairs = new Set(mixes.map((mix) => [mix.itemA.id, mix.itemB.id].sort().join('|')));
    expect(pairs.size).toBe(5);
    for (let i = 1; i < mixes.length; i++) {
      expect((mixes[i] as { deltaE00: number }).deltaE00).toBeGreaterThanOrEqual((mixes[i - 1] as { deltaE00: number }).deltaE00);
    }
    for (const mix of mixes) {
      expect(mix.ratio[0]).toBeGreaterThanOrEqual(mix.ratio[1]);
      expect(deltaE2000(target, mix.predictedColor.lab)).toBeCloseTo(mix.deltaE00, 9);
    }
    const best = (mixes[0] as { deltaE00: number }).deltaE00;
    expect(findBestTwoPartMixes(target, stash, { maxDeltaE: best })).toEqual([]);
    expect(findBestTwoPartMixes(target, stash, { maxDeltaE: best + 1e-6 })).toHaveLength(1);
  });

  it('only uses the ratios it is given', () => {
    const stash = randomStash(12, 77);
    const allowed = new Set(['1:1', '2:1', '3:1', '4:1']);
    for (const mix of findBestTwoPartMixes([55, 10, 20], stash, { limit: 20 })) {
      expect(allowed.has(mix.ratio.join(':'))).toBe(true);
    }
    for (const mix of findBestTwoPartMixes([55, 10, 20], stash, { limit: 20, ratios: [[5, 2]] })) {
      expect(mix.ratio).toEqual([5, 2]);
    }
  });

  it('never pairs incompatible items and flags experimental and low-opacity mixes', () => {
    const gold = makeItem('#c9a227', { finish: 'metallic', name: 'gold' });
    const ochre = makeItem('#b8860b', { finish: 'matte', name: 'ochre' });
    const oilWhite = makeItem('#ffffff', { medium: 'oil_paint', name: 'oil white' });
    const floss = makeItem('#ffffff', { medium: 'embroidery_floss', name: 'floss' });
    const target = predictMix(gold, ochre, [1, 1]).lab;

    expect(findBestTwoPartMixes(target, [gold, ochre, oilWhite, floss], { limit: 10 })).toEqual([]);

    const experimental = findBestTwoPartMixes(target, [gold, ochre, oilWhite, floss], {
      limit: 10,
      experimentalFinishes: true,
    });
    expect(experimental).toHaveLength(1);
    expect(experimental[0]?.warnings).toContain('experimental_finish');

    const glaze = makeItem('#3355aa', { opacity: 0.3 });
    const base = makeItem('#dddddd');
    expect(findBestTwoPartMix([60, 0, -20], [glaze, base])?.warnings).toContain('low_opacity');
  });

  it('applies the eligibility filter', () => {
    const stash = randomStash(10, 9);
    const banned = (stash[0] as CatalogItem).id;
    const mixes = findBestTwoPartMixes([50, 0, 0], stash, { limit: 100, eligible: (item) => item.id !== banned });
    expect(mixes).toHaveLength(36);
    expect(mixes.some((mix) => mix.itemA.id === banned || mix.itemB.id === banned)).toBe(false);
  });

  it('returns nothing for stashes that cannot be mixed', () => {
    expect(findBestTwoPartMixes([50, 0, 0], [])).toEqual([]);
    expect(findBestTwoPartMixes([50, 0, 0], [makeItem('#123456')])).toEqual([]);
    expect(findBestTwoPartMix([50, 0, 0], [])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// matchSolver
// ---------------------------------------------------------------------------

describe('matchSolver', () => {
  it('never offers a metallic for a matte target with a near-identical hex', () => {
    const gold = makeItem('#b8860c', { finish: 'metallic', name: 'gold' });
    const ochre = makeItem('#a87a12', { finish: 'matte', name: 'ochre' });
    const input = { catalog: [gold, ochre], ownedIds: [gold.id, ochre.id] };

    const strict = solveMatch('#b8860b', input);
    expect(strict.bestSingleMatches.map((match) => match.item.name)).toEqual(['ochre']);

    const experimental = solveMatch('#b8860b', input, { experimentalFinishes: true });
    expect(experimental.bestSingleMatches[0]?.item.name).toBe('gold');

    const metallicTarget = solveMatch('#b8860b', input, { targetFinish: 'metallic' });
    expect(metallicTarget.bestSingleMatches.map((match) => match.item.name)).toEqual(['gold']);
  });

  it('ranks the full catalogue but flags ownership, and restricts to owned items in strict mode', () => {
    const exact = makeItem('#3a7bd5', { name: 'exact (not owned)' });
    const near = makeItem('#3f7fd0', { name: 'near (owned)' });
    const far = makeItem('#d53a3a', { name: 'far (owned)' });
    const solver = createMatchSolver({ catalog: [far, near, exact], ownedIds: new Set([near.id, far.id, 'unknown-id']) });
    expect(solver.catalogSize).toBe(3);
    expect(solver.ownedCount).toBe(2);

    const full = solver.solve('#3a7bd5');
    expect(full.bestSingleMatches.map((match) => match.item.name)).toEqual([
      'exact (not owned)',
      'near (owned)',
      'far (owned)',
    ]);
    expect(full.bestSingleMatches.map((match) => match.ownedByUser)).toEqual([false, true, true]);
    expect(full.bestSingleMatches[0]?.deltaE00).toBe(0);
    expect(full.bestOwnedSingle?.item.name).toBe('near (owned)');
    expect(full.coverage).toBe('owned_single');
    expect(full.bestTwoPartMix).toBeUndefined();

    const strict = solver.solve('#3a7bd5', { mode: 'strict_stash' });
    expect(strict.bestSingleMatches.every((match) => match.ownedByUser)).toBe(true);
    expect(strict.bestSingleMatches).toHaveLength(2);
  });

  it('skips discontinued items the user does not own, but keeps owned ones', () => {
    const gone = makeItem('#445566', { discontinued: true, name: 'gone' });
    const ownedGone = makeItem('#445567', { discontinued: true, name: 'owned gone' });
    const input = { catalog: [gone, ownedGone], ownedIds: [ownedGone.id] };
    expect(solveMatch('#445566', input).bestSingleMatches.map((match) => match.item.name)).toEqual(['owned gone']);
    expect(solveMatch('#445566', input, { includeDiscontinued: true }).bestSingleMatches).toHaveLength(2);
  });

  it('filters by medium and limits the number of single matches', () => {
    const floss = makeItem('#aa3344', { medium: 'embroidery_floss', name: 'floss' });
    const paints = randomStash(20, 31);
    const input = { catalog: [floss, ...paints], ownedIds: [] as string[] };
    const result = solveMatch('#aa3344', input, { medium: 'embroidery_floss' });
    expect(result.bestSingleMatches.map((match) => match.item.name)).toEqual(['floss']);
    expect(solveMatch('#aa3344', input, { maxSingleMatches: 3 }).bestSingleMatches).toHaveLength(3);
    expect(result.bestOwnedDeltaE).toBeNull();
    expect(result.coverage).toBe('gap');
  });

  it('proposes an owned mix when no owned single is close, and only then', () => {
    const white = makeItem('#f4f4f0', { name: 'white' });
    const red = makeItem('#9a1115', { name: 'red' });
    const blue = makeItem('#1f4fa3', { name: 'blue' });
    const catalog = [white, red, blue];
    const target = predictMix(white, red, [2, 1]);
    const solver = createMatchSolver({ catalog, ownedIds: catalog.map((item) => item.id) });

    const solved = solver.solve(target);
    expect(solved.coverage).toBe('owned_mix');
    expect(solved.bestTwoPartMix?.itemA.name).toBe('white');
    expect(solved.bestTwoPartMix?.itemB.name).toBe('red');
    expect(solved.bestTwoPartMix?.ratio).toEqual([2, 1]);
    expect(solved.bestOwnedDeltaE).toBeLessThan(1e-6);
    expect(solved.bestOwnedSingle?.deltaE00).toBeGreaterThan(GAP_DELTA_E);

    expect(solver.solve(target, { allowMixes: false }).bestTwoPartMix).toBeUndefined();
    expect(solver.solve(target, { allowMixes: false }).coverage).toBe('gap');

    // An owned exact single means no mix is searched for or reported.
    expect(solver.solve(red.color).bestTwoPartMix).toBeUndefined();

    // Mixes come only from owned items, even in full catalogue mode.
    const unowned = createMatchSolver({ catalog, ownedIds: [blue.id] }).solve(target);
    expect(unowned.bestTwoPartMix).toBeUndefined();
    expect(unowned.coverage).toBe('gap');
  });

  it('does not mix thread: floss targets get singles only', () => {
    const a = makeItem('#ffffff', { medium: 'embroidery_floss' });
    const b = makeItem('#aa0000', { medium: 'embroidery_floss' });
    const solved = solveMatch('#d58080', { catalog: [a, b], ownedIds: [a.id, b.id] });
    expect(solved.bestTwoPartMix).toBeUndefined();
  });

  it('reports a mix only when it clearly beats the best owned single', () => {
    const stash = randomStash(60, 404);
    const solver = createMatchSolver({ catalog: stash, ownedIds: stash.map((item) => item.id) });
    const random = createRandom(505);
    for (let i = 0; i < 40; i++) {
      const solved = solver.solve(randomHex(random));
      const single = solved.bestOwnedSingle?.deltaE00 ?? Number.POSITIVE_INFINITY;
      if (solved.bestTwoPartMix) {
        expect(single).toBeGreaterThanOrEqual(2.5);
        expect(solved.bestTwoPartMix.deltaE00).toBeLessThan(single - 0.5);
        expect(solved.bestOwnedDeltaE).toBe(solved.bestTwoPartMix.deltaE00);
      } else {
        expect(solved.bestOwnedDeltaE).toBe(single);
      }
      if (solved.coverage === 'gap') expect(solved.bestOwnedDeltaE as number).toBeGreaterThan(GAP_DELTA_E);
    }
  });

  it('flags finishes a screen cannot reproduce', () => {
    expect(displayCaveatOf(makeItem('#c9a227', { finish: 'metallic' }))).toBe('metallic');
    expect(displayCaveatOf(makeItem('#39ff14', { finish: 'fluorescent' }))).toBe('fluorescent');
    expect(displayCaveatOf(makeItem('#808080', { finish: 'variegated' }))).toBe('variegated');
    expect(displayCaveatOf(makeItem('#808080', { finish: 'matte' }))).toBeNull();
  });

  it('rejects an invalid hex target', () => {
    expect(() => solveMatch('not-a-colour', { catalog: [], ownedIds: [] })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Performance guardrail (specification section 6)
// ---------------------------------------------------------------------------

describe('performance', () => {
  it('solves single match plus two-part mix search over a 300-item stash in under 50 ms', () => {
    const stash = randomStash(300, 2024);
    const solver = createMatchSolver({ catalog: stash, ownedIds: stash.map((item) => item.id) });
    const random = createRandom(999);
    const targets = Array.from({ length: 30 }, () => randomHex(random));

    // Warm up the JIT the way a running app would be warm.
    for (const target of targets.slice(0, 5)) solver.solve(target, { mixTriggerDeltaE: 0, mixMinImprovement: 0 });

    const timings: number[] = [];
    for (const target of targets) {
      const start = performance.now();
      // mixTriggerDeltaE 0 forces the mix search on every target (worst case).
      solver.solve(target, { mixTriggerDeltaE: 0, mixMinImprovement: 0 });
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)] as number;
    const worst = timings[timings.length - 1] as number;
    console.info(`300-item solve: median ${median.toFixed(2)} ms, worst ${worst.toFixed(2)} ms`);
    expect(median).toBeLessThan(50);
  });
});
