# color-me-worst

Perceptual colour matching and inventory optimisation for physical colour media
(miniature paints, embroidery floss, markers, fabric). Given a target colour, it
finds the closest items you already own, or a two-part mix of them, using
colour science rather than RGB distance.

## Status

The project is built in gated phases. Each phase stops for sign-off.

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Deterministic colour science and mixing kernel | **Done, awaiting sign-off** |
| 2 | Catalogue schema, seed data, local-first store | Not started |
| 3 | Image normalisation and palette extraction | Not started |
| 4 | Interactive UI and "Shop Your Stash" solver | Not started |
| 5 | Vision-assisted onboarding and export | Not started |

## Phase 1: the colour kernel

Everything lives in `src/lib/color/` and has zero runtime dependencies, so it
runs unchanged in a browser, a Web Worker, an edge runtime or Node.

| File | What it does |
| --- | --- |
| `types.ts` | Canonical data schema (`CatalogItem`, `ColorCoordinates`, `MatchResult`, …) |
| `colorConversions.ts` | sRGB ↔ linear RGB ↔ XYZ (D65) ↔ CIELAB and OKLab/OKLCh, hex parsing, gamut checks |
| `deltaE2000.ts` | CIEDE2000 with kL/kC/kH weights, a per-term breakdown, and a provable lower bound used for fast search |
| `pigmentMixer.ts` | Kubelka-Munk two-part mixing, medium and finish compatibility rules, exhaustive mix search |
| `matchSolver.ts` | Ranks single substitutes, decides when to search for a mix, and classifies shopping-list gaps |
| `spectralData.ts` | Generated spectral tables (do not edit; see below) |
| `colorKernel.test.ts` | 91 tests, including all 34 Sharma et al. (2005) CIEDE2000 reference pairs |

### Run it

```sh
npm install
npm test          # unit tests, including the 50 ms performance budget
npm run typecheck
```

### Use it

```ts
import { createMatchSolver } from './src/lib/color';

const solver = createMatchSolver({ catalog, ownedIds });
const result = solver.solve('#7a8f5c', { mode: 'strict_stash' });

result.bestSingleMatches; // closest items, each with deltaE00 and ownedByUser
result.bestTwoPartMix;    // e.g. 2 parts A to 1 part B, with the predicted colour
result.coverage;          // 'owned_single' | 'owned_mix' | 'owned_approximate' | 'gap'
```

### How mixing is modelled

Paint mixes subtractively, so averaging RGB is wrong (blue plus yellow averages
to grey). The mixer instead:

1. expands each colour into an 18-band reflectance spectrum that reproduces the
   colour exactly;
2. converts reflectance to Kubelka-Munk absorption/scattering (K/S), which adds
   linearly by concentration, and blends there;
3. converts the result back to a colour under D65.

The spectral tables are derived, not hand-typed. `npm run derive:basis` rebuilds
`spectralData.ts` from the CIE 1931 2° observer and D65 tables in
`scripts/data/`, solving for the smoothest physically valid spectra that
reproduce the sRGB primaries.

### Limits you should know about

- **A hex code does not determine a pigment.** The spectrum and tinting
  strength of each paint are estimated from its colour alone. Predictions are a
  sound starting ratio, not a guarantee, and strong tinters (phthalo blue,
  carbon black) will overpower a mix more than predicted. Red plus blue is the
  weakest case: real paints give a dull purple, the estimate gives a dark
  neutral.
- **Tinting strength is an uncalibrated heuristic.** Scattering is estimated as
  the square root of luminance (`SCATTERING_EXPONENT`). It has not been fitted
  to measured paint. Measured reflectance or a per-item `tintStrength` can be
  supplied through `PigmentOverride` and replaces the estimate.
- **Only paints are mixed.** Thread, markers, fabric, beads and dye get
  single-item matches only.
- **Catalogue accuracy is the real ceiling.** The maths is exact; a wrong
  manufacturer hex still produces a wrong match.

### Rules the kernel enforces

- Different media are never mixed (no oil with acrylic), with no override.
- Items are only substituted or mixed within a finish class (solid, transparent,
  metallic, fluorescent) unless `experimentalFinishes` is set. A metallic gold
  is never offered for a matte ochre that shares its hex.
- Mixes are built only from items the user owns.
- Discontinued items are only suggested if the user already owns them.

### Where this departs from the written specification

- **Thresholds reconciled.** The specification gives three overlapping numbers
  for when to mix (3.0–5.0, "no single under 2.5") and when a colour is a gap
  (above 4.0). The solver searches for a mix when the best owned single is at
  or above 2.5, reports it only if it beats that single by at least 0.5 (or
  is what brings the target within 4.0), and calls a gap when nothing owned,
  single or mixed, gets within 4.0. All three are options.
- **Schema additions.** `MediumType` gains `bead` and `leather_dye`, and
  `FinishType` gains `variegated`, because the specification names them in
  prose but omits them from the types. `TwoPartMix` gains a `warnings` list.
- **Extra modules.** `matchSolver.ts` and the generated `spectralData.ts` are
  beyond the four files listed for Phase 1; the solver is what the 50 ms
  performance target actually measures.
- **All 34 Sharma pairs are tested**, not a sample.
