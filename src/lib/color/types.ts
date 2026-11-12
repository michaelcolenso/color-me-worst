/**
 * Canonical data schema for the colour-matching engine.
 *
 * The shapes follow section 4 of the system specification. Additions beyond
 * the specification are marked "Extension" and are all optional or additive,
 * so data written against the original schema stays valid.
 */

/** A triple of numbers: RGB, XYZ, L*a*b*, OKLab or OKLCh depending on context. */
export type Vec3 = [number, number, number];

/** Read-only view of a {@link Vec3}, accepted by every function that only reads. */
export type ReadonlyVec3 = readonly [number, number, number];

export type MediumType =
  | 'acrylic_paint'
  | 'enamel_paint'
  | 'oil_paint'
  | 'embroidery_floss'
  | 'alcohol_marker'
  | 'fabric'
  /** Extension: named in the problem statement but missing from the original union. */
  | 'bead'
  /** Extension: named in the problem statement but missing from the original union. */
  | 'leather_dye';

export type FinishType =
  | 'matte'
  | 'satin'
  | 'gloss'
  | 'metallic'
  | 'wash'
  | 'contrast'
  | 'fluorescent'
  /** Extension: multi-colour threads and fabrics that no single swatch can represent. */
  | 'variegated';

export interface ColorCoordinates {
  /** Lower-case `#rrggbb`. */
  hex: string;
  /** 8-bit sRGB, each channel 0–255. */
  rgb: Vec3;
  /** CIELAB under D65: L* 0–100, a* and b* roughly −128 to 127. */
  lab: Vec3;
  /** OKLCh: lightness 0–1, chroma 0–~0.4, hue in degrees 0–360 (0 when achromatic). */
  oklch: Vec3;
}

/**
 * Extension. How far a catalogue colour can be trusted:
 * - `community`: crowd-sourced hex, unverified against the product;
 * - `manufacturer`: published by the maker;
 * - `measured`: instrument reading of the physical product.
 */
export type ColorSource = 'community' | 'manufacturer' | 'measured';

export interface CatalogItem {
  id: string;
  brand: string;
  line: string;
  sku: string;
  name: string;
  medium: MediumType;
  finish: FinishType;
  /** 0.0 (transparent) to 1.0 (opaque). */
  opacity: number;
  color: ColorCoordinates;
  discontinued: boolean;
  /** Extension. Absent means unknown; treat as `community`. */
  colorSource?: ColorSource;
}

export interface SingleMatch {
  item: CatalogItem;
  deltaE00: number;
  ownedByUser: boolean;
}

/** Things a caller should surface next to a predicted mix. */
export type MixWarning =
  /** At least one component is translucent, so the opaque-film model is less reliable. */
  | 'low_opacity'
  /** The pair is only allowed because "Experimental Finishes" is switched on. */
  | 'experimental_finish'
  /** The predicted colour lies outside sRGB; hex and rgb are the nearest displayable colour. */
  | 'display_clipped';

export interface TwoPartMix {
  itemA: CatalogItem;
  itemB: CatalogItem;
  /** Parts of A to parts of B by volume, e.g. [2, 1]. */
  ratio: [number, number];
  /**
   * `lab` and `oklch` are the physical prediction. `hex` and `rgb` are the
   * nearest displayable colour, which differs only when `warnings` contains
   * `display_clipped`.
   */
  predictedColor: ColorCoordinates;
  deltaE00: number;
  /** Extension. Empty when there is nothing to flag. */
  warnings: MixWarning[];
}

export interface MatchResult {
  targetColor: ColorCoordinates;
  bestSingleMatches: SingleMatch[];
  bestTwoPartMix?: TwoPartMix;
}
