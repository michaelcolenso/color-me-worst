import type { DisplayCaveat } from '../lib/color/matchSolver';
import type { ColorSource, FinishType, MediumType, MixWarning } from '../lib/color/types';

export const MEDIUM_LABELS: Readonly<Record<MediumType, string>> = {
  acrylic_paint: 'Acrylic paint',
  enamel_paint: 'Enamel paint',
  oil_paint: 'Oil paint',
  embroidery_floss: 'Embroidery floss',
  alcohol_marker: 'Alcohol marker',
  fabric: 'Fabric',
  bead: 'Beads',
  leather_dye: 'Leather dye',
};

export const FINISH_LABELS: Readonly<Record<FinishType, string>> = {
  matte: 'Matte',
  satin: 'Satin',
  gloss: 'Gloss',
  metallic: 'Metallic',
  wash: 'Wash',
  contrast: 'Contrast',
  fluorescent: 'Fluorescent',
  variegated: 'Variegated',
};

export const CAVEAT_LABELS: Readonly<Record<DisplayCaveat, string>> = {
  metallic: 'Metallic: a screen can’t show the shine',
  fluorescent: 'Fluorescent: brighter in real life than on screen',
  variegated: 'Variegated: one swatch can’t show every colour',
};

/** How far a catalogue colour can be trusted, shown next to every product. */
export const COLOR_SOURCE_LABELS: Readonly<Record<ColorSource, string>> = {
  community: 'community colour data, unverified',
  manufacturer: 'manufacturer’s colour',
  measured: 'measured colour',
};

export const MIX_WARNING_LABELS: Readonly<Record<MixWarning, string>> = {
  low_opacity: 'One of these is translucent, so the prediction is less reliable.',
  experimental_finish: 'Mixes different finishes (experimental).',
  display_clipped: 'The real mix is more vivid than a screen can show.',
  effect_finish: 'Uses a metallic, fluorescent or wash/contrast paint. The colour is a rough estimate; the effect itself can’t be predicted.',
};
