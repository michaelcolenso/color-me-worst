/**
 * GENERATED FILE — do not edit by hand.
 * Produced by scripts/deriveSpectralBasis.mjs (run `npm run derive:basis`).
 *
 * Source data: CIE 1931 2-degree standard observer and CIE standard illuminant
 * D65 at 10 nm from 380 nm to 730 nm, summed into 18 bands
 * of 20 nm.
 */

/** Number of spectral bands. */
export const BAND_COUNT = 18;

/** Band centre wavelengths in nanometres. */
export const WAVELENGTHS_NM: readonly number[] = [385, 405, 425, 445, 465, 485, 505, 525, 545, 565, 585, 605, 625, 645, 665, 685, 705, 725];

/**
 * Rows X, Y, Z. Multiplying by a reflectance spectrum gives CIE XYZ under D65
 * with Y = 1 for a perfect reflector.
 */
export const SPECTRAL_TO_XYZ: readonly (readonly number[])[] = [
  [
    0.0002842098058, 0.004889044006, 0.03518035309, 0.07181047288, 0.05367195957, 0.01379206484, 0.001456262274, 0.02314713065, 0.07139156702, 0.1257728981, 0.1692435054, 0.1755366494, 0.1215817222, 0.05696379982, 0.01932837688, 0.00496406027, 0.001177515611, 0.0002643352794,
  ],
  [
    0.000008049813688, 0.0001357613737, 0.001305144469, 0.006489753988, 0.01657760762, 0.03666867643, 0.08473505584, 0.1582447358, 0.1922105151, 0.1809377197, 0.1423867858, 0.09638988382, 0.05250386396, 0.02196329782, 0.007121659785, 0.001800994783, 0.0004250715551, 0.00009542244884,
  ],
  [
    0.001342963489, 0.02328729114, 0.1708742089, 0.3698791911, 0.3263097613, 0.1371871615, 0.04432089959, 0.01206548939, 0.002869415385, 0.0005609434783, 0.0002420719431, 0.00009704363763, 0.00001972452492, 0.000001585357964, 0, 0, 0, 0,
  ],
];

/**
 * Smoothest reflectance spectra that reproduce the linear sRGB primaries.
 * They sum to 1 in every band, so reflectance = r·R + g·G + b·B stays in [0, 1]
 * for any in-gamut linear sRGB colour and reproduces that colour exactly.
 */
export const BASIS_R: readonly number[] = [
  0.03531548, 0.03517786, 0.03283119, 0.0201677, 0.01597303, 0, 0, 0, 0, 0, 0.32371132, 0.85271287, 1, 1, 1, 1, 1, 1,
];

export const BASIS_G: readonly number[] = [
  0, 0, 0, 0, 0.03746037, 0.40653733, 0.80197668, 1, 1, 0.99279057, 0.61764583, 0.14163139, 0, 0, 0, 0, 0, 0,
];

export const BASIS_B: readonly number[] = [
  0.96468452, 0.96482214, 0.96716881, 0.9798323, 0.9465666, 0.59346267, 0.19802332, 0, 0, 0.00720943, 0.05864285, 0.00565574, 0, 0, 0, 0, 0, 0,
];
