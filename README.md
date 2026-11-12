# color-me-worst

Perceptual colour matching and inventory optimisation for physical colour media
(miniature paints, embroidery floss, markers, fabric). Given a target colour, it
finds the closest items you already own, or a two-part mix of them, using
colour science rather than RGB distance.

## Status

The project is built in gated phases. Each phase stops for sign-off.

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Deterministic colour science and mixing kernel | Done |
| 2 | Catalogue schema, seed data, local-first store | **Done, awaiting sign-off** |
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
| `colorKernel.test.ts` | 92 tests, including all 34 Sharma et al. (2005) CIEDE2000 reference pairs |

### Run it

```sh
npm install
npm test               # all unit tests, including both performance budgets
npm run typecheck
npm run seed:generate  # rebuild the seed SQL and client bundle from the source list
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

## Phase 2: catalogue, seed data and local store

### Stack decision

The specification suggested Next.js with Supabase/PostgreSQL. This project
uses **Cloudflare D1 (SQLite) behind Workers** instead, with the front end to
be a React PWA. Reasons: the app is local-first, so the server only distributes
the catalogue and relays stash changes; nothing in the schema needs
PostgreSQL-specific features; and it keeps hosting on one platform. The schema
is plain SQL with CHECK constraints and would port to PostgreSQL with minor
type changes if that is ever needed.

No Worker, database or other cloud resource has been created yet. The
migration has been run against SQLite locally, not against a real D1 database.

### What was added

| Path | What it is |
| --- | --- |
| `migrations/0001_initial_schema.sql` | D1 schema: `brands`, `catalog_items`, `user_stashes`, `recipes`, `recipe_items`, with indexes |
| `data/catalog/seed-source.json` | 111 curated items: name, code, hex, finish, opacity, provenance |
| `scripts/buildSeedSource.py` | One-off import tool that built the source list from two public datasets |
| `scripts/generateSeed.ts` | Computes CIELAB/OKLCh for every item and writes the two files below |
| `db/seed/catalog_seed.sql` | Generated seed rows for D1 (idempotent) |
| `src/data/catalogSeed.json` | Generated client bundle of the same catalogue |
| `src/lib/catalog/seedBuilder.ts` | Validation, id scheme, and SQL/JSON serialisation used by the generator |
| `src/lib/store/stashStore.ts` | Local-first store: IndexedDB for durability, in-memory index for queries |

### Seed catalogue

111 items: Citadel 40, Vallejo Model Color 25, Monument Hobbies Pro Acryl 23,
DMC six-strand floss 23. It deliberately includes metallics, washes, contrast
paints, a fluorescent, a gloss and two discontinued paints so every matching
rule has real data to act on.

**Where the data came from, and how far to trust it**

- Names, codes and hex values for the paints come from
  [Arcturus5404/miniature-paints](https://github.com/Arcturus5404/miniature-paints)
  (MIT licence). DMC values come from
  [seanockert/rgb-to-dmc](https://github.com/seanockert/rgb-to-dmc), which
  publishes no licence file.
- These are community hex values. They have **not** been checked against
  physical paint or thread, and some are plainly approximate (the source lists
  Citadel's Abaddon Black as pure `#000000`, which no real paint is). Every
  seed row is therefore marked `color_source = 'community'`.
- **Finish and opacity are not in either dataset.** They were assigned by hand
  in `scripts/buildSeedSource.py` (for example, Citadel Shade paints as `wash`
  at opacity 0.25). Treat them as editorial assumptions.
- The paint dataset has no Citadel product codes, so Citadel SKUs are derived
  from the paint name.

The schema records a `color_source` per item (`community`, `manufacturer` or
`measured`) so better data can replace the seed row by row and the UI can show
how trustworthy each match is.

### Local store

`StashStore` loads the catalogue and stash from IndexedDB once, then answers
every query from memory, which is why filtering is fast: reading thousands of
rows from IndexedDB per query would not meet the budget.

```ts
import { StashStore, createIndexedDbAdapter } from './src/lib/store/stashStore';
import type { CatalogBundle } from './src/lib/catalog/seedBuilder';
import seedJson from './src/data/catalogSeed.json';

const seed = seedJson as unknown as CatalogBundle;
const store = await StashStore.open(await createIndexedDbAdapter());
if (store.catalogRevision < seed.revision) await store.importCatalog(seed.items, seed.revision);

await store.setOwned('citadel:base:mephiston-red', true);
store.queryCatalog({ text: 'red', owned: true });
store.queryCatalog({ near: { lab: [45, 50, 30], maxDeltaE: 5 }, sort: 'deltaE' });
store.getSolver().solve('#7a8f5c', { mode: 'strict_stash' });
```

Measured on a 6,000-item synthetic catalogue in the development container:
text and attribute filters take under 0.5 ms, and ranking the whole catalogue
by colour distance takes about 3 ms, against a 15 ms budget.

**Sync.** The store does not talk to a server. It keeps what a sync layer
needs: every stash entry has a timestamp, a tombstone flag for removals and a
`dirty` flag, exposed through `pendingChanges()`, `markSynced()` and
`applyRemote()`. Conflicts resolve last-write-wins per item. The network half
of sync is not built yet.

### Not done in this phase

- No Worker API, authentication or deployed database.
- No network sync; only the local bookkeeping for it.
- `user_id` is an opaque string with no users table, pending an auth decision.
- The catalogue is a 111-item sample, not a full range for any brand.
