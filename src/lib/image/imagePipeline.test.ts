import { describe, expect, it } from 'vitest';

import {
  D65_WHITE,
  colorFromHex,
  hexToLab,
  linearChannelToSrgb,
  linearRgbToXyz,
  rgb8ToLab,
  rgb8ToLinearRgb,
  xyzToLab,
} from '../color/colorConversions';
import { deltaE2000 } from '../color/deltaE2000';
import type { ReadonlyVec3, Vec3 } from '../color/types';
import { clientToImagePoint } from './canvasIo';
import {
  IDENTITY_MATRIX,
  NO_WHITE_BALANCE,
  RGB_TO_XYZ,
  SRGB8_TO_LINEAR,
  XYZ_TO_RGB,
  applyMatrix,
  applyWhiteBalance,
  assertPixelBuffer,
  autoWhiteBalance,
  chromaticAdaptationMatrix,
  correctLinearRgb,
  createImageWorkerClient,
  createInlineImageClient,
  createRandom,
  estimateIlluminant,
  extractLoupePatch,
  extractPalette,
  handleImageWorkerRequest,
  invertMatrix,
  linearToSrgb8,
  multiplyMatrices,
  sampleLoupe,
  whiteBalanceFromNeutral,
  whiteBalanceFromPoint,
  type ImageWorkerRequest,
  type ImageWorkerResponse,
  type Matrix3,
  type PixelBuffer,
  type WorkerLike,
} from './index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Rgba = readonly [number, number, number, number?];

function makeImage(width: number, height: number, pixel: (x: number, y: number) => Rgba): PixelBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = pixel(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return { data, width, height };
}

function pixelAt(image: PixelBuffer, x: number, y: number): Vec3 {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset] as number, image.data[offset + 1] as number, image.data[offset + 2] as number];
}

function encode(linear: ReadonlyVec3): Vec3 {
  return linear.map((channel) => Math.round(Math.min(1, Math.max(0, linearChannelToSrgb(channel))) * 255)) as Vec3;
}

/** How a scene's colours are recorded under a light that is not D65. */
function castMatrixForLight(lightXyz: ReadonlyVec3): Matrix3 {
  return multiplyMatrices(XYZ_TO_RGB, multiplyMatrices(chromaticAdaptationMatrix(D65_WHITE, lightXyz), RGB_TO_XYZ));
}

/** A warm indoor lamp: chromaticity (0.45, 0.41), well towards orange from D65 (0.3127, 0.3290). */
const WARM_LIGHT: Vec3 = [0.45 / 0.41, 1, (1 - 0.45 - 0.41) / 0.41];

const GREY: Vec3 = [128, 128, 128];

/**
 * A test scene: a grid of colour patches with a grey card in the first cell.
 * Patch colours stay in the mid-range so a cast does not clip them.
 */
function makeScene(seed: number, cast?: Matrix3): { image: PixelBuffer; truth: Vec3[]; cell: number; columns: number } {
  const random = createRandom(seed);
  const columns = 6;
  const rows = 5;
  const cell = 16;
  const truth: Vec3[] = [GREY];
  for (let i = 1; i < columns * rows; i++) {
    truth.push([50 + random() * 130, 50 + random() * 130, 50 + random() * 130].map(Math.round) as Vec3);
  }
  const recorded = truth.map((rgb) => (cast ? encode(applyMatrix(cast, rgb8ToLinearRgb(rgb))) : rgb));
  const image = makeImage(columns * cell, rows * cell, (x, y) => {
    const index = Math.floor(y / cell) * columns + Math.floor(x / cell);
    return recorded[index] as Vec3;
  });
  return { image, truth, cell, columns };
}

/** True when the photo could not record this patch: a channel hit the floor or the ceiling. */
function isClipped(rgb: ReadonlyVec3): boolean {
  return rgb.some((channel) => channel === 0 || channel === 255);
}

function patchCentre(index: number, cell: number, columns: number): [number, number] {
  return [(index % columns) * cell + cell / 2, Math.floor(index / columns) * cell + cell / 2];
}

// ---------------------------------------------------------------------------
// pixelMath
// ---------------------------------------------------------------------------

describe('pixelMath', () => {
  it('round-trips every 8-bit code through the decode and encode tables', () => {
    for (let code = 0; code < 256; code++) {
      expect(linearToSrgb8(SRGB8_TO_LINEAR[code] as number)).toBe(code);
    }
  });

  it('encodes within one code value of the exact formula everywhere, and clamps', () => {
    let worst = 0;
    for (let i = 0; i <= 20000; i++) {
      const linear = i / 20000;
      worst = Math.max(worst, Math.abs(linearToSrgb8(linear) - linearChannelToSrgb(linear) * 255));
    }
    expect(worst).toBeLessThanOrEqual(1);
    expect(linearToSrgb8(-0.2)).toBe(0);
    expect(linearToSrgb8(1.7)).toBe(255);
    expect(linearToSrgb8(Number.NaN)).toBe(0);
  });

  it('inverts and multiplies 3 x 3 matrices', () => {
    const product = multiplyMatrices(RGB_TO_XYZ, invertMatrix(RGB_TO_XYZ));
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        expect((product[row] as ReadonlyVec3)[col]).toBeCloseTo(row === col ? 1 : 0, 12);
      }
    }
    expect(() =>
      invertMatrix([
        [1, 2, 3],
        [2, 4, 6],
        [0, 0, 1],
      ]),
    ).toThrow(RangeError);
  });

  it('validates pixel buffers', () => {
    expect(() => assertPixelBuffer({ data: new Uint8ClampedArray(16), width: 2, height: 2 })).not.toThrow();
    expect(() => assertPixelBuffer({ data: new Uint8ClampedArray(15), width: 2, height: 2 })).toThrow(RangeError);
    expect(() => assertPixelBuffer({ data: new Uint8ClampedArray(0), width: 0, height: 2 })).toThrow(RangeError);
    expect(() => assertPixelBuffer({ data: new Uint8ClampedArray(8), width: 1.5, height: 2 })).toThrow(RangeError);
  });

  it('has a deterministic random generator', () => {
    const a = createRandom(7);
    const b = createRandom(7);
    const values = Array.from({ length: 100 }, () => a());
    expect(values).toEqual(Array.from({ length: 100 }, () => b()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(95);
  });
});

// ---------------------------------------------------------------------------
// whiteBalance
// ---------------------------------------------------------------------------

describe('whiteBalance: chromatic adaptation', () => {
  it.each(['bradford', 'von_kries', 'channel_gain'] as const)('%s makes a neutral reference exactly neutral', (method) => {
    const neutral = applyMatrix(castMatrixForLight(WARM_LIGHT), [0.4, 0.4, 0.4]);
    const out = correctLinearRgb(neutral, whiteBalanceFromNeutral(neutral, { method }));
    expect(out[0]).toBeCloseTo(out[1], 10);
    expect(out[1]).toBeCloseTo(out[2], 10);
    // Luminance is preserved: only the colour of the light is removed.
    expect(linearRgbToXyz(out)[1]).toBeCloseTo(linearRgbToXyz(neutral)[1], 10);
  });

  it.each(['bradford', 'von_kries'] as const)('%s maps the source white exactly onto the target white', (method) => {
    const adapted = applyMatrix(chromaticAdaptationMatrix(WARM_LIGHT, D65_WHITE, method), WARM_LIGHT);
    for (let i = 0; i < 3; i++) expect(adapted[i]).toBeCloseTo(D65_WHITE[i] as number, 12);
    const back = multiplyMatrices(
      chromaticAdaptationMatrix(D65_WHITE, WARM_LIGHT, method),
      chromaticAdaptationMatrix(WARM_LIGHT, D65_WHITE, method),
    );
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        expect((back[row] as ReadonlyVec3)[col]).toBeCloseTo(row === col ? 1 : 0, 10);
      }
    }
  });

  it('is the identity when the whites are the same, and rejects impossible whites', () => {
    const same = chromaticAdaptationMatrix(D65_WHITE, D65_WHITE);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        expect((same[row] as ReadonlyVec3)[col]).toBeCloseTo(row === col ? 1 : 0, 12);
      }
    }
    expect(() => chromaticAdaptationMatrix([0, 0, 0], D65_WHITE)).toThrow(RangeError);
  });
});

describe('whiteBalance: from a neutral reference', () => {
  it('recovers the true colours of a scene shot under a warm lamp', () => {
    const { image, truth, cell, columns } = makeScene(1, castMatrixForLight(WARM_LIGHT));
    const before = truth.map((rgb, index) =>
      deltaE2000(rgb8ToLab(rgb), rgb8ToLab(pixelAt(image, ...patchCentre(index, cell, columns)))),
    );
    expect(Math.min(...before)).toBeGreaterThan(5); // the cast is large on every patch

    const balance = whiteBalanceFromPoint(image, ...patchCentre(0, cell, columns));
    expect(balance.castChroma).toBeGreaterThan(15);
    expect(balance.gain).toBe(1);
    for (let i = 0; i < 3; i++) expect(balance.sourceWhite[i]).toBeCloseTo(WARM_LIGHT[i] as number, 1);

    const corrected = applyWhiteBalance(image, balance);
    const errorAt = (index: number) =>
      deltaE2000(rgb8ToLab(truth[index] as Vec3), rgb8ToLab(pixelAt(corrected, ...patchCentre(index, cell, columns))));
    const recordable = truth.map((_, index) => index).filter(
      (index) => !isClipped(pixelAt(image, ...patchCentre(index, cell, columns))),
    );
    expect(recordable.length).toBeGreaterThan(truth.length / 2);
    // For colours the photo could record, what remains is 8-bit rounding.
    const after = recordable.map(errorAt);
    expect(Math.max(...after)).toBeLessThan(1.5);
    expect(after.reduce((sum, value) => sum + value, 0) / after.length).toBeLessThan(0.6);
    expect(pixelAt(corrected, ...patchCentre(0, cell, columns))).toEqual(GREY);
    // Colours the warm light pushed outside what the photo can hold lose
    // information for good, but correction still helps every one of them.
    truth.forEach((_, index) => expect(errorAt(index)).toBeLessThan(before[index] as number));
  });

  it('undoes a per-channel camera cast with the channel-gain method and a known grey card', () => {
    const gains: Matrix3 = [
      [1, 0, 0],
      [0, 0.8, 0],
      [0, 0, 0.55],
    ];
    const { image, truth, cell, columns } = makeScene(2, gains);
    // A channel cast also changes overall brightness, and a grey reference
    // alone cannot say by how much; the card's known lightness settles it.
    const balance = whiteBalanceFromPoint(image, ...patchCentre(0, cell, columns), {
      method: 'channel_gain',
      referenceLightness: rgb8ToLab(GREY)[0],
    });
    expect(balance.method).toBe('channel_gain');
    const corrected = applyWhiteBalance(image, balance);
    truth.forEach((rgb, index) => {
      const centre = patchCentre(index, cell, columns);
      expect(isClipped(pixelAt(image, ...centre))).toBe(false);
      expect(deltaE2000(rgb8ToLab(rgb), rgb8ToLab(pixelAt(corrected, ...centre)))).toBeLessThan(1.5);
    });
    expect(pixelAt(corrected, ...patchCentre(0, cell, columns))).toEqual(GREY);
  });

  it('neutralises a per-channel camera cast with the default method and roughly halves the error elsewhere', () => {
    const gains: Matrix3 = [
      [1, 0, 0],
      [0, 0.8, 0],
      [0, 0, 0.55],
    ];
    const { image, truth, cell, columns } = makeScene(2, gains);
    const balance = whiteBalanceFromPoint(image, ...patchCentre(0, cell, columns));
    const corrected = applyWhiteBalance(image, balance);

    const grey = rgb8ToLab(pixelAt(corrected, ...patchCentre(0, cell, columns)));
    expect(Math.hypot(grey[1], grey[2])).toBeLessThan(0.7);

    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const errorOf = (source: PixelBuffer) =>
      mean(
        truth.map((rgb, index) =>
          deltaE2000(rgb8ToLab(rgb), rgb8ToLab(pixelAt(source, ...patchCentre(index, cell, columns)))),
        ),
      );
    // Bradford models a change of light, not a camera setting, so it is not an exact inverse here.
    expect(errorOf(corrected)).toBeLessThan(errorOf(image) * 0.6);
  });

  it('can correct exposure to a known reference lightness', () => {
    const { image, cell, columns } = makeScene(3, castMatrixForLight(WARM_LIGHT));
    const [x, y] = patchCentre(0, cell, columns);
    const balance = whiteBalanceFromPoint(image, x, y, { referenceLightness: 70 });
    expect(balance.gain).toBeGreaterThan(1);
    const grey = rgb8ToLab(pixelAt(applyWhiteBalance(image, balance), x, y));
    expect(grey[0]).toBeCloseTo(70, 0);
    expect(Math.hypot(grey[1], grey[2])).toBeLessThan(0.7);
    expect(() => whiteBalanceFromNeutral([0.2, 0.2, 0.2], { referenceLightness: 0 })).toThrow(RangeError);
    expect(() => whiteBalanceFromNeutral([0.2, 0.2, 0.2], { referenceLightness: 101 })).toThrow(RangeError);
  });

  it('leaves an already-neutral reference alone', () => {
    const balance = whiteBalanceFromNeutral([0.3, 0.3, 0.3]);
    expect(balance.castChroma).toBeLessThan(1e-6);
    const out = correctLinearRgb([0.6, 0.2, 0.1], balance);
    expect(out[0]).toBeCloseTo(0.6, 9);
    expect(out[1]).toBeCloseTo(0.2, 9);
    expect(out[2]).toBeCloseTo(0.1, 9);
    expect(NO_WHITE_BALANCE.matrix).toEqual(IDENTITY_MATRIX);
  });

  it('refuses references that cannot be measured', () => {
    expect(() => whiteBalanceFromNeutral([0.001, 0.001, 0.001])).toThrow(/too dark/);
    expect(() => whiteBalanceFromNeutral([0.99, 0.9, 0.8])).toThrow(/overexposed/);
    expect(() => whiteBalanceFromNeutral([0.4, 0, 0.3])).toThrow(/zero/);
    const blown = makeImage(20, 20, () => [255, 255, 255]);
    expect(() => whiteBalanceFromPoint(blown, 10, 10)).toThrow(/overexposed/);
    const black = makeImage(20, 20, () => [3, 3, 3]);
    expect(() => whiteBalanceFromPoint(black, 10, 10)).toThrow(/too dark/);
  });

  it('flags a strongly coloured "neutral" through castChroma', () => {
    const red = rgb8ToLinearRgb([200, 40, 40]);
    expect(whiteBalanceFromNeutral(red).castChroma).toBeGreaterThan(40);
  });
});

describe('whiteBalance: applying to an image', () => {
  it('returns a copy, keeps alpha and is exact for the identity', () => {
    const random = createRandom(9);
    const image = makeImage(32, 8, () => [random() * 255, random() * 255, random() * 255, random() * 255]);
    const snapshot = Uint8ClampedArray.from(image.data);
    const same = applyWhiteBalance(image, IDENTITY_MATRIX);
    expect(same.data).not.toBe(image.data);
    expect(same.data).toEqual(snapshot);
    expect(image.data).toEqual(snapshot);

    const warm = applyWhiteBalance(image, whiteBalanceFromNeutral([0.5, 0.4, 0.3]));
    for (let offset = 3; offset < warm.data.length; offset += 4) {
      expect(warm.data[offset]).toBe(snapshot[offset]);
    }
    expect(warm.width).toBe(32);
    expect(warm.height).toBe(8);
  });
});

describe('whiteBalance: automatic estimation', () => {
  const gains: Vec3 = [1, 0.78, 0.5];
  const castGains: Matrix3 = [
    [gains[0], 0, 0],
    [0, gains[1], 0],
    [0, 0, gains[2]],
  ];

  /** Random colours whose average is neutral, recorded with a channel-gain cast, plus a grey probe. */
  function noisyScene(withWhite: boolean): PixelBuffer {
    const random = createRandom(31);
    return makeImage(120, 90, (x, y) => {
      if (x < 12 && y < 12) return encode(applyMatrix(castGains, rgb8ToLinearRgb(GREY)));
      if (withWhite && x >= 100 && y < 20) return encode(applyMatrix(castGains, [0.85, 0.85, 0.85]));
      return encode(applyMatrix(castGains, [random() * 0.7, random() * 0.7, random() * 0.7]));
    });
  }
  const probeChroma = (image: PixelBuffer) => {
    const lab = rgb8ToLab(pixelAt(image, 5, 5));
    return Math.hypot(lab[1], lab[2]);
  };

  it('estimates the light with each estimator, scaled to a peak of 1', () => {
    const scene = noisyScene(true);
    for (const estimator of ['gray_world', 'shades_of_gray', 'white_patch'] as const) {
      const light = estimateIlluminant(scene, { estimator });
      expect(Math.max(...light)).toBeCloseTo(1, 12);
      expect(light[1] / light[0]).toBeCloseTo(gains[1], 1);
      expect(light[2] / light[0]).toBeCloseTo(gains[2], 1);
    }
  });

  it('removes most of a cast with no reference point', () => {
    const scene = noisyScene(true);
    const before = probeChroma(scene);
    expect(before).toBeGreaterThan(10);
    for (const estimator of ['gray_world', 'shades_of_gray', 'white_patch'] as const) {
      const corrected = applyWhiteBalance(scene, autoWhiteBalance(scene, { estimator }));
      expect(probeChroma(corrected)).toBeLessThan(before / 4);
    }
    // Default settings work without a white object in shot.
    const plain = noisyScene(false);
    expect(probeChroma(applyWhiteBalance(plain, autoWhiteBalance(plain)))).toBeLessThan(before / 4);
  });

  it('ignores clipped and transparent pixels, and fails clearly when nothing is usable', () => {
    const base = noisyScene(false);
    const light = estimateIlluminant(base);
    const withGlare = makeImage(base.width, base.height, (x, y) => {
      if (y >= 80) return [255, 255, 255]; // blown-out strip
      if (y >= 70) return [0, 255, 0, 0]; // transparent strip
      return [...pixelAt(base, x, y), 255] as unknown as Rgba;
    });
    const withGlareLight = estimateIlluminant(withGlare);
    for (let i = 0; i < 3; i++) expect(withGlareLight[i]).toBeCloseTo(light[i] as number, 1);

    expect(() => estimateIlluminant(makeImage(4, 4, () => [10, 20, 30, 0]))).toThrow(/No usable pixels/);
    expect(() => estimateIlluminant(makeImage(4, 4, () => [255, 255, 255]))).toThrow(/No usable pixels/);
    expect(() => estimateIlluminant(makeImage(4, 4, () => [0, 0, 0]))).toThrow(/too dark/);
    expect(() => estimateIlluminant(base, { norm: 0.5 })).toThrow(RangeError);
  });

  it('samples large images on a grid without changing the answer much', () => {
    const scene = noisyScene(false);
    const full = estimateIlluminant(scene);
    const sparse = estimateIlluminant(scene, { maxSamples: 500 });
    for (let i = 0; i < 3; i++) expect(sparse[i]).toBeCloseTo(full[i] as number, 1);
  });
});

// ---------------------------------------------------------------------------
// loupeSampler
// ---------------------------------------------------------------------------

describe('loupeSampler', () => {
  const BASE: Vec3 = [150, 60, 45];
  const baseLab = rgb8ToLab(BASE);

  it('returns the exact colour of a flat area', () => {
    const image = makeImage(30, 30, () => BASE);
    const sample = sampleLoupe(image, 15, 15);
    expect(sample.color.rgb).toEqual(BASE);
    expect(sample.pixelCount).toBe(25);
    expect(sample.usedCount).toBe(25);
    expect(sample.rejectedCount).toBe(0);
    expect(sample.spread).toBeLessThan(1e-9);
    expect(sampleLoupe(image, 15, 15, { kernel: 11 }).pixelCount).toBe(121);
    expect(sampleLoupe(image, 15, 15, { kernel: 1 }).color.rgb).toEqual(BASE);
  });

  it('averages out sensor noise', () => {
    const random = createRandom(4);
    const noise = () => Math.round((random() - 0.5) * 16);
    const image = makeImage(40, 40, () => [BASE[0] + noise(), BASE[1] + noise(), BASE[2] + noise()]);
    const single = deltaE2000(baseLab, rgb8ToLab(pixelAt(image, 20, 20)));
    const sample = sampleLoupe(image, 20, 20, { kernel: 11 });
    expect(deltaE2000(baseLab, sample.color.lab)).toBeLessThan(1);
    expect(sample.spread).toBeGreaterThan(0.3);
    // The point of the loupe: it beats reading one pixel on a typical noisy patch.
    const singles: number[] = [];
    for (let i = 0; i < 100; i++) {
      singles.push(deltaE2000(baseLab, rgb8ToLab(pixelAt(image, 5 + (i % 10) * 3, 5 + Math.floor(i / 10) * 3))));
    }
    const typicalSingle = singles.sort((a, b) => a - b)[50] as number;
    expect(deltaE2000(baseLab, sample.color.lab)).toBeLessThan(typicalSingle);
    expect(single).toBeGreaterThanOrEqual(0);
  });

  it('discards specular highlights and shadows', () => {
    // 11 x 11 kernel = 121 pixels: 20 blown-out glare, 12 bright-but-unclipped glare, 12 deep shadow.
    const image = makeImage(31, 31, (x, y) => {
      const dx = x - 15;
      const dy = y - 15;
      if (dy === -5 || (dy === -4 && dx < 4)) return [255, 255, 255];
      if (dy === 5 && dx <= 0) return [238, 226, 222];
      if (dy === 4 && dx <= 0) return [28, 12, 9];
      return BASE;
    });
    const sample = sampleLoupe(image, 15, 15, { kernel: 11 });
    expect(sample.color.rgb).toEqual(BASE);
    expect(sample.rejectedCount).toBeGreaterThanOrEqual(11 + 9 + 6 + 6);
    expect(sample.usedCount + sample.rejectedCount).toBe(121);
    expect(sample.spread).toBeLessThan(0.1);

    // A plain average of the same pixels is visibly wrong.
    let sum: Vec3 = [0, 0, 0];
    for (let y = 10; y <= 20; y++) {
      for (let x = 10; x <= 20; x++) {
        const lab = rgb8ToLab(pixelAt(image, x, y));
        sum = [sum[0] + lab[0], sum[1] + lab[1], sum[2] + lab[2]];
      }
    }
    const mean: Vec3 = [sum[0] / 121, sum[1] / 121, sum[2] / 121];
    expect(deltaE2000(baseLab, mean)).toBeGreaterThan(5);
  });

  it('reports a large spread when the kernel straddles an edge', () => {
    const image = makeImage(30, 30, (x) => (x < 15 ? [200, 30, 30] : [30, 30, 200]));
    expect(sampleLoupe(image, 15, 15, { kernel: 11 }).spread).toBeGreaterThan(3);
    expect(sampleLoupe(image, 5, 15, { kernel: 5 }).spread).toBeLessThan(1e-9);
  });

  it('clips the kernel at image borders', () => {
    const image = makeImage(10, 10, () => BASE);
    expect(sampleLoupe(image, 0, 0).pixelCount).toBe(9);
    expect(sampleLoupe(image, 9, 4).pixelCount).toBe(15);
    expect(sampleLoupe(image, 4.4, 4.6).pixelCount).toBe(25);
  });

  it('ignores transparent pixels and fails when nothing is opaque', () => {
    const image = makeImage(11, 11, (x) => (x < 5 ? [0, 255, 0, 0] : BASE));
    const sample = sampleLoupe(image, 5, 5);
    expect(sample.color.rgb).toEqual(BASE);
    expect(sample.usedCount).toBe(15);
    expect(sample.rejectedCount).toBe(10);
    expect(() => sampleLoupe(makeImage(5, 5, () => [1, 2, 3, 0]), 2, 2)).toThrow(/transparent/);
  });

  it('still measures areas that are genuinely pure white or black', () => {
    expect(sampleLoupe(makeImage(9, 9, () => [255, 255, 255]), 4, 4).color.hex).toBe('#ffffff');
    expect(sampleLoupe(makeImage(9, 9, () => [0, 0, 0]), 4, 4).color.hex).toBe('#000000');
  });

  it('applies a white-balance correction before measuring', () => {
    const cast = castMatrixForLight(WARM_LIGHT);
    const recorded = encode(applyMatrix(cast, rgb8ToLinearRgb(BASE)));
    const image = makeImage(20, 20, () => recorded);
    const balance = whiteBalanceFromNeutral(applyMatrix(cast, rgb8ToLinearRgb(GREY)));
    expect(deltaE2000(baseLab, sampleLoupe(image, 10, 10).color.lab)).toBeGreaterThan(5);
    expect(deltaE2000(baseLab, sampleLoupe(image, 10, 10, { whiteBalance: balance.matrix }).color.lab)).toBeLessThan(1);
  });

  it('rejects invalid kernels and points outside the image', () => {
    const image = makeImage(10, 10, () => BASE);
    for (const kernel of [0, 4, -3, 2.5]) expect(() => sampleLoupe(image, 5, 5, { kernel })).toThrow(RangeError);
    for (const [x, y] of [[-1, 5], [10, 5], [5, 10], [Number.NaN, 5]] as const) {
      expect(() => sampleLoupe(image, x, y)).toThrow(/outside/);
    }
  });

  it('extracts a centred patch for the magnifier, transparent beyond the edges', () => {
    const image = makeImage(6, 6, (x, y) => [x * 10, y * 10, 7]);
    const patch = extractLoupePatch(image, 0, 3, 5);
    expect(patch.width).toBe(5);
    expect(patch.height).toBe(5);
    const at = (col: number, row: number) => Array.from(patch.data.slice((row * 5 + col) * 4, (row * 5 + col) * 4 + 4));
    expect(at(2, 2)).toEqual([0, 30, 7, 255]); // the clicked pixel is the centre
    expect(at(4, 0)).toEqual([20, 10, 7, 255]);
    expect(at(0, 2)).toEqual([0, 0, 0, 0]); // left of the image
    expect(() => extractLoupePatch(image, 0, 0, 4)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// paletteExtractor
// ---------------------------------------------------------------------------

describe('paletteExtractor', () => {
  const BLOCKS: Array<{ hex: string; share: number }> = [
    { hex: '#27548a', share: 0.4 },
    { hex: '#d8c9a3', share: 0.25 },
    { hex: '#8a2d2d', share: 0.15 },
    { hex: '#3f7f4f', share: 0.12 },
    { hex: '#1b1b1f', share: 0.08 },
  ];

  /** Vertical bands of the block colours with mild noise, like a simple illustration. */
  function bandedImage(width: number, height: number, noiseLevel = 6): PixelBuffer {
    const random = createRandom(77);
    const edges: number[] = [];
    let running = 0;
    for (const block of BLOCKS) {
      running += block.share;
      edges.push(running * width);
    }
    return makeImage(width, height, (x) => {
      const index = edges.findIndex((edge) => x < edge);
      const rgb = colorFromHex((BLOCKS[index === -1 ? BLOCKS.length - 1 : index] as { hex: string }).hex).rgb;
      const noise = () => Math.round((random() - 0.5) * noiseLevel);
      return [rgb[0] + noise(), rgb[1] + noise(), rgb[2] + noise()];
    });
  }

  it('finds the colours of a five-colour image with the right proportions', () => {
    const result = extractPalette(bandedImage(400, 300), { count: 5 });
    expect(result.swatches).toHaveLength(5);
    expect(result.sampleCount).toBeGreaterThan(10_000);
    expect(result.sampleCount).toBeLessThanOrEqual(20_000);
    result.swatches.forEach((swatch, index) => {
      const block = BLOCKS[index] as { hex: string; share: number };
      expect(deltaE2000(hexToLab(block.hex), swatch.color.lab)).toBeLessThan(1.5);
      expect(swatch.population).toBeCloseTo(block.share, 1);
    });
    expect(result.swatches.reduce((sum, swatch) => sum + swatch.population, 0)).toBeCloseTo(1, 12);
    const populations = result.swatches.map((swatch) => swatch.population);
    expect(populations).toEqual([...populations].sort((a, b) => b - a));
  });

  it('is deterministic, and finds the same colours from a different seed', () => {
    const image = bandedImage(300, 200);
    const first = extractPalette(image, { count: 5 });
    expect(extractPalette(image, { count: 5 })).toEqual(first);
    const other = extractPalette(image, { count: 5, seed: 12345 });
    expect(other.swatches).toHaveLength(5);
    for (const swatch of first.swatches) {
      const nearest = Math.min(...other.swatches.map((candidate) => deltaE2000(swatch.color.lab, candidate.color.lab)));
      expect(nearest).toBeLessThan(1);
    }
  });

  it('returns fewer colours than asked when the image has fewer', () => {
    const two = makeImage(60, 60, (x) => (x < 45 ? [200, 40, 40] : [40, 40, 200]));
    const result = extractPalette(two, { count: 8 });
    expect(result.swatches.map((swatch) => swatch.color.hex)).toEqual(['#c82828', '#2828c8']);
    expect(result.swatches[0]?.population).toBeCloseTo(0.75, 1);

    const flat = extractPalette(makeImage(40, 40, () => [90, 120, 60]), { count: 12 });
    expect(flat.swatches).toHaveLength(1);
    expect(flat.swatches[0]?.color.rgb).toEqual([90, 120, 60]);
    expect(flat.swatches[0]?.population).toBe(1);
  });

  it('merges near-identical clusters unless merging is switched off', () => {
    const noisy = bandedImage(300, 200, 10);
    const merged = extractPalette(noisy, { count: 12 });
    expect(merged.swatches.length).toBeLessThanOrEqual(12);
    for (let i = 0; i < merged.swatches.length; i++) {
      for (let j = i + 1; j < merged.swatches.length; j++) {
        const distance = deltaE2000(
          (merged.swatches[i] as { color: { lab: Vec3 } }).color.lab,
          (merged.swatches[j] as { color: { lab: Vec3 } }).color.lab,
        );
        expect(distance).toBeGreaterThanOrEqual(2.5);
      }
    }
    const unmerged = extractPalette(noisy, { count: 12, mergeDeltaE: 0 });
    expect(unmerged.swatches).toHaveLength(12);
    expect(unmerged.swatches.length).toBeGreaterThan(merged.swatches.length);
  });

  it('separates the requested number of colours on a rich image', () => {
    const random = createRandom(5);
    const image = makeImage(200, 150, () => [random() * 255, random() * 255, random() * 255]);
    for (const count of [5, 8, 12]) {
      const result = extractPalette(image, { count });
      expect(result.swatches).toHaveLength(count);
      expect(result.iterations).toBeGreaterThan(1);
    }
  });

  it('is not fooled by a repeating texture whose period matches the sampling grid', () => {
    // 600 x 600 gives a sampling stride of 5; red sits on every fifth column.
    const striped = makeImage(600, 600, (x) => (x % 5 === 2 ? [200, 30, 30] : [30, 30, 200]));
    const result = extractPalette(striped, { count: 4 });
    expect(result.swatches.map((swatch) => swatch.color.hex)).toEqual(['#1e1ec8', '#c81e1e']);
    expect(result.swatches[0]?.population).toBeCloseTo(0.8, 1);
    for (const phase of [0, 1, 3, 4]) {
      const shifted = makeImage(600, 600, (x) => (x % 5 === phase ? [200, 30, 30] : [30, 30, 200]));
      expect(extractPalette(shifted, { count: 4 }).swatches[0]?.color.hex).toBe('#1e1ec8');
    }
    const light = estimateIlluminant(striped, { estimator: 'gray_world', maxSamples: 14_400 });
    // 80 % blue, 20 % red: blue must dominate the estimate.
    expect(light[2]).toBe(1);
    expect(light[0]).toBeLessThan(0.5);
  });

  it('ignores transparent pixels and fails when nothing is opaque', () => {
    const image = makeImage(60, 60, (x) => (x < 30 ? [255, 0, 255, 0] : [40, 90, 160]));
    const result = extractPalette(image, { count: 5 });
    expect(result.swatches.map((swatch) => swatch.color.rgb)).toEqual([[40, 90, 160]]);
    expect(() => extractPalette(makeImage(8, 8, () => [1, 2, 3, 0]))).toThrow(/no opaque pixels/);
  });

  it('applies white balance while sampling', () => {
    const cast = castMatrixForLight(WARM_LIGHT);
    const truth: Vec3 = [70, 110, 170];
    const image = makeImage(50, 50, () => encode(applyMatrix(cast, rgb8ToLinearRgb(truth))));
    const balance = whiteBalanceFromNeutral(applyMatrix(cast, rgb8ToLinearRgb(GREY)));
    const raw = extractPalette(image, { count: 3 }).swatches[0]?.color.lab as Vec3;
    const fixed = extractPalette(image, { count: 3, whiteBalance: balance.matrix }).swatches[0]?.color.lab as Vec3;
    expect(deltaE2000(rgb8ToLab(truth), raw)).toBeGreaterThan(5);
    expect(deltaE2000(rgb8ToLab(truth), fixed)).toBeLessThan(1);
  });

  it('rejects invalid palette sizes', () => {
    const image = makeImage(10, 10, () => [10, 20, 30]);
    for (const count of [0, 17, 2.5, -1]) expect(() => extractPalette(image, { count })).toThrow(RangeError);
    expect(extractPalette(image, { count: 1 }).swatches).toHaveLength(1);
    expect(extractPalette(image, { count: 16 }).swatches).toHaveLength(1);
  });

  it('handles a phone-sized photo quickly', () => {
    const random = createRandom(8);
    const width = 2048;
    const height = 1536;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < data.length; offset += 4) {
      data[offset] = random() * 255;
      data[offset + 1] = random() * 255;
      data[offset + 2] = random() * 255;
      data[offset + 3] = 255;
    }
    const image: PixelBuffer = { data, width, height };
    extractPalette(image, { count: 12 }); // warm up

    let start = performance.now();
    const result = extractPalette(image, { count: 12 });
    const paletteMs = performance.now() - start;
    start = performance.now();
    applyWhiteBalance(image, whiteBalanceFromNeutral([0.5, 0.42, 0.3]));
    const balanceMs = performance.now() - start;
    start = performance.now();
    autoWhiteBalance(image);
    const autoMs = performance.now() - start;
    console.info(
      `2048x1536: palette(12) ${paletteMs.toFixed(0)} ms over ${result.sampleCount} samples, ` +
        `apply white balance ${balanceMs.toFixed(0)} ms, auto white balance ${autoMs.toFixed(0)} ms`,
    );
    expect(result.swatches).toHaveLength(12);
    expect(paletteMs).toBeLessThan(1000);
    expect(balanceMs).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// worker protocol and client
// ---------------------------------------------------------------------------

describe('image worker', () => {
  const image = makeImage(40, 40, (x) => (x < 20 ? [200, 40, 40] : [40, 40, 200]));

  /** Stand-in for a real Worker: runs the same handler, answers asynchronously. */
  function fakeWorker(options: { reverse?: boolean } = {}) {
    const messageListeners: Array<(event: { data: ImageWorkerResponse }) => void> = [];
    const errorListeners: Array<(event: { message?: string }) => void> = [];
    const queued: ImageWorkerResponse[] = [];
    let terminated = false;
    const posted: ImageWorkerRequest[] = [];
    const worker: WorkerLike = {
      postMessage(message) {
        posted.push(message);
        // structuredClone mimics the copy a real worker boundary makes.
        const { response } = handleImageWorkerRequest(structuredClone(message));
        queued.push(response);
      },
      addEventListener(type: 'message' | 'error', listener: never) {
        (type === 'message' ? messageListeners : errorListeners).push(listener);
      },
      terminate() {
        terminated = true;
      },
    };
    return {
      worker,
      posted,
      flush() {
        const batch = options.reverse ? queued.splice(0).reverse() : queued.splice(0);
        if (!terminated) for (const data of batch) for (const listener of messageListeners) listener({ data });
      },
      crash(message: string) {
        for (const listener of errorListeners) listener({ message });
      },
      isTerminated: () => terminated,
    };
  }

  it('executes each request type', () => {
    const palette = handleImageWorkerRequest({ id: 1, type: 'extractPalette', image, options: { count: 4 } });
    expect(palette.response).toMatchObject({ id: 1, ok: true });
    expect(palette.response.ok && palette.response.result).toEqual(extractPalette(image, { count: 4 }));

    const auto = handleImageWorkerRequest({ id: 2, type: 'autoWhiteBalance', image });
    expect(auto.response.ok && auto.response.result).toEqual(autoWhiteBalance(image));

    const applied = handleImageWorkerRequest({ id: 3, type: 'applyWhiteBalance', image, matrix: IDENTITY_MATRIX });
    expect(applied.response.ok).toBe(true);
    const output = (applied.response.ok && applied.response.result) as PixelBuffer;
    expect(output.data).toEqual(image.data);
    expect(applied.transfer).toEqual([output.data.buffer]);
  });

  it('reports failures as data instead of throwing', () => {
    const bad = handleImageWorkerRequest({ id: 9, type: 'extractPalette', image, options: { count: 99 } });
    expect(bad.response).toEqual({
      id: 9,
      ok: false,
      error: { name: 'RangeError', message: expect.stringContaining('count must be') as unknown as string },
    });
    const unknown = handleImageWorkerRequest({ id: 4, type: 'nope' } as unknown as ImageWorkerRequest);
    expect(unknown.response).toMatchObject({ id: 4, ok: false, error: { name: 'TypeError' } });
  });

  it('matches responses to requests even when they arrive out of order', async () => {
    const fake = fakeWorker({ reverse: true });
    const client = createImageWorkerClient(fake.worker);
    const palette = client.extractPalette(image, { count: 3 });
    const balance = client.autoWhiteBalance(image);
    const applied = client.applyWhiteBalance(image, IDENTITY_MATRIX);
    expect(fake.posted.map((request) => request.id)).toEqual([1, 2, 3]);
    fake.flush();
    expect(await palette).toEqual(extractPalette(image, { count: 3 }));
    expect(await balance).toEqual(autoWhiteBalance(image));
    expect((await applied).data).toEqual(image.data);
  });

  it('rejects with the original error type', async () => {
    const fake = fakeWorker();
    const client = createImageWorkerClient(fake.worker);
    const failing = client.extractPalette(image, { count: 0 });
    fake.flush();
    await expect(failing).rejects.toBeInstanceOf(RangeError);
    await expect(failing).rejects.toThrow(/count must be/);
  });

  it('rejects everything in flight when the worker crashes or is terminated', async () => {
    const crashing = fakeWorker();
    const first = createImageWorkerClient(crashing.worker);
    const lost = first.extractPalette(image);
    crashing.crash('script failed to load');
    await expect(lost).rejects.toThrow(/Image worker failed: script failed to load/);

    // After a fatal error the worker is dead: later calls fail at once
    // rather than waiting for a reply that will never come.
    expect(crashing.isTerminated()).toBe(true);
    await expect(first.autoWhiteBalance(image)).rejects.toThrow(/Image worker failed: script failed to load/);
    expect(crashing.posted).toHaveLength(1);

    // The same holds when the worker fails before anything was asked of it.
    const deadOnArrival = fakeWorker();
    const second = createImageWorkerClient(deadOnArrival.worker);
    deadOnArrival.crash('404');
    await expect(second.extractPalette(image)).rejects.toThrow(/Image worker failed: 404/);
    expect(deadOnArrival.posted).toHaveLength(0);

    const fake = fakeWorker();
    const client = createImageWorkerClient(fake.worker);
    const pending = client.extractPalette(image);
    client.terminate();
    expect(fake.isTerminated()).toBe(true);
    await expect(pending).rejects.toThrow(/terminated/);
    await expect(client.autoWhiteBalance(image)).rejects.toThrow(/terminated/);
  });

  it('offers the same interface without a worker', async () => {
    const client = createInlineImageClient();
    expect(await client.extractPalette(image, { count: 3 })).toEqual(extractPalette(image, { count: 3 }));
    expect(await client.autoWhiteBalance(image)).toEqual(autoWhiteBalance(image));
    expect((await client.applyWhiteBalance(image, IDENTITY_MATRIX)).data).toEqual(image.data);
    await expect(client.extractPalette(image, { count: 0 })).rejects.toBeInstanceOf(RangeError);
    client.terminate();
    await expect(client.extractPalette(image)).rejects.toThrow(/terminated/);
  });
});

// ---------------------------------------------------------------------------
// canvas helpers (the DOM-free part)
// ---------------------------------------------------------------------------

describe('canvasIo', () => {
  it('maps a pointer position on a scaled element to image pixels', () => {
    const element = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 300 }) };
    const size = { width: 2000, height: 1500 };
    expect(clientToImagePoint(element, size, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(clientToImagePoint(element, size, 300, 200)).toEqual({ x: 1000, y: 750 });
    expect(clientToImagePoint(element, size, 500, 350)).toEqual({ x: 1999, y: 1499 }); // clamped to the last pixel
    expect(clientToImagePoint(element, size, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

// A sanity link back to the colour kernel: a corrected neutral really is D65.
describe('integration with the colour kernel', () => {
  it('maps the estimated light to L* a* b* neutral', () => {
    const neutral = applyMatrix(castMatrixForLight(WARM_LIGHT), [0.4, 0.4, 0.4]);
    const balance = whiteBalanceFromNeutral(neutral);
    const lab = xyzToLab(linearRgbToXyz(correctLinearRgb(neutral, balance)));
    expect(Math.hypot(lab[1], lab[2])).toBeLessThan(1e-6);
  });
});
