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
| 2 | Catalogue schema, seed data, local-first store | Done |
| 3 | Image normalisation and palette extraction | Done |
| 4 | Interactive UI and "Shop Your Stash" solver | Done |
| 5 | Vision-assisted onboarding and export | Done; not deployed |
| — | Fixes from two independent reviews (November 2026) | Done; see below |

Nothing has been deployed. The physical accuracy of the catalogue colours and
of mix predictions has not been validated against real paint or thread.

## Review fixes (November 2026)

Two independent reviews were combined; every code finding was reproduced
before it was fixed, and each fix has a test that fails without it.

| Finding | What changed |
| --- | --- |
| Catalogue corrections never reached existing users (revision stuck at 1) | `revision` now lives in `data/catalog/seed-source.json`. `npm run seed:generate` refuses to regenerate changed content at an unchanged revision, and a test enforces the same through `data/catalog/catalog.lock.json`. Items can list `formerIds`; stash entries move to the new id on import, so a rename keeps ownership. The API echoes `catalogRevision`. |
| A pin on transparent pixels crashed the app | Each pin is sampled separately; an unsampleable pin says so and stays movable/removable. A last-resort error screen replaces a blank page. |
| Contradictory labels resolved confidently ("Vallejo 70.950 White" → Black; "Monument 70.950" → Vallejo) | A named brand now *restricts* candidates. If the best candidate leaves a product code or another product's colour word unexplained, the line comes back with an `issue` and alternatives instead of a match. A code that matched nothing and was retried by name is flagged too. |
| Ambiguous imports and recipe lines defaulted to the first guess | Uncertain rows start with no product chosen and cannot be added, counted as covered, or put on the shopping list until the user chooses. |
| Offline cache could store a server error as the app, cached `/api/*`, and deleted other apps' caches | Only successful HTML replaces the offline shell; `/api/` is never intercepted; `no-store` is respected; only this app's old caches are deleted; a new version waits for open tabs to close instead of taking over mid-session; the cache version hashes file contents, including `index.html` and `public/`. |
| Metallic/fluorescent/wash mixes were offered as ordinary mixes | Mixes are searched only for solid (matte/satin/gloss) colours from solid paints. With experimental finishes on, an effect mix is shown with an `effect_finish` warning and never counts as covering the target. Mix warnings are now printed on the recipe card. |
| Wording overstated certainty | "Exact match" → "Very close colour"; "under 1.5 is not visible" removed; "You own this product" is reserved for identity; each product shows its colour source ("community colour data, unverified"); the recipe view says substitutes are judged on unverified data. |
| Late async results could overwrite newer work | Photo loads, automatic white balance and photo import are tied to the request that started them; superseded results are dropped. Export waits until the corrected image matches the current correction. Photo import has a Cancel button and a client-side timeout. |
| Two open tabs disagreed about the stash | After each successful write the store notifies other tabs (BroadcastChannel), which re-read IndexedDB; tabs also refresh when they become visible. Newer edits win per item. |
| Failed saves were invisible | A banner on every tab shows unsaved changes with "Try saving again" and "Download a backup". The Stash tab has backup download and restore (newer version of each item wins). |
| No keyboard route to a first pin or a neutral point | "Add a pin in the middle" focuses a new pin for the arrow keys; each pin has "Use as neutral". |
| Photo import: unbounded latency, unmeasured spend | SDK timeout 45 s per attempt with one retry (was 10 min with two); one JSON log line per call with model, token counts, outcome and duration (no image or label text). The prompt asks for at most 300 labels; the server still truncates. |
| Request size checked only after buffering | The body is read as a stream and abandoned once it passes the byte cap, with or without `Content-Length`. Image bytes must match the declared format before anything is spent. |
| Matching re-ran for every pin on every drag; recipe re-ran per keystroke | Pin results are cached by colour, stash version and options; recipe matching waits for a 250 ms pause in typing. |
| `deltaE2000(NaN, …)` returned 0, a perfect match | It now returns NaN. |
| Quantity-zero items still satisfied matches | Only items with quantity above zero are offered as matches or mix ingredients; they stay on the list. |
| No CI | `docs/ci/github-actions-ci.yml` (move it to `.github/workflows/ci.yml` to enable it) runs unit tests (including catalogue/seed/schema checks), build, Worker bundle check, browser smoke and end-to-end tests. In CI a skipped PDF check fails. |

Checked and not changed: the dependency versions flagged as "ahead of stable"
(`typescript` 7.0.2, `vite` 8.3.8, `vitest` 5.1.0 and the rest) are each the
current `latest` release on npm as of this change.

Not done (needs a decision, data or hardware, not code): choosing a licence;
a privacy policy for photo import; DMC dataset redistribution rights; a
deployed staging environment; real-device, Safari/Firefox and screen-reader
testing; real-photo and real-label evaluation; physical colour validation;
saving open projects across reloads; paginated print export; per-paint tint
strength in the UI; storing unknown products without a colour; a content
security policy (to be tested against the deployed Worker); a spend budget
in money rather than request counts.

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
npm run test:browser   # image pipeline in headless Chromium (needs Playwright installed)
npm run dev            # the app, with hot reload
npm run build          # typecheck, then production bundle in dist/
npm run test:e2e       # drive the built app in headless Chromium (needs Playwright installed)
npm run worker:check   # validate and bundle the Cloudflare Worker without deploying
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

No Worker, database or other cloud resource has been deployed. (The Worker
code was added in Phase 5; the D1 schema is still not wired to it.) The
migration has been run against SQLite locally, not against a real D1 database.

### What was added

| Path | What it is |
| --- | --- |
| `migrations/0001_initial_schema.sql` | D1 schema: `brands`, `catalog_items`, `user_stashes`, `recipes`, `recipe_items`, with indexes |
| `data/catalog/seed-source.json` | 1,312 catalogue items (revision 2): name, code, hex, finish, opacity, provenance |
| `scripts/buildSeedSource.py` | One-off import tool that built the source list from two public datasets |
| `scripts/generateSeed.ts` | Computes CIELAB/OKLCh for every item and writes the two files below |
| `db/seed/catalog_seed.sql` | Generated seed rows for D1 (idempotent) |
| `src/data/catalogSeed.json` | Generated client bundle of the same catalogue |
| `src/lib/catalog/seedBuilder.ts` | Validation, id scheme, and SQL/JSON serialisation used by the generator |
| `src/lib/store/stashStore.ts` | Local-first store: IndexedDB for durability, in-memory index for queries |

### Seed catalogue

Revision 2 (November 2026): 1,312 items. The full brush-paint ranges that
miniature-painting tutorials name, plus the original DMC thread sample:

| Brand | Ranges | Items |
| --- | --- | --- |
| Citadel | Base, Layer, Dry, Shade, Glaze, Contrast; Foundation and Foundation Wash (discontinued) | 334 |
| Vallejo | Model Color, Game Color, Game Color Wash, Xpress Color, Xpress Color Intense | 428 |
| Army Painter | Warpaints Fanatic and Fanatic Wash, Speedpaint 2.0; original Warpaints (marked discontinued) | 408 |
| Monument Hobbies | Pro Acryl (with its washes), Pro Acryl Signature | 119 |
| DMC | Six-strand floss sample, unchanged | 23 |

Left out on purpose: airbrush and spray ranges, primers, varnishes, mediums,
texture and effect paints. Every revision-1 id is unchanged, so existing
stashes keep working; the build checked that all 111 revision-1 items are
present with the same colour, finish and opacity.

Assumptions made by `scripts/buildSeedSource.py` that you may want to check:

- **Finish is assigned by rule.** Each range has a default (Shade and washes
  are `wash`, Contrast/Speedpaint/Xpress are `contrast`, the rest `matte`).
  Metallics in opaque ranges are found by whole words (gold, silver, steel,
  bronze…) plus a short list of names with no such word (Leadbelcher,
  Retributor Armour, Screaming Bell…) and exceptions (Steel Legion Drab,
  Bronze Green, Bronze Brown, anything "Golden", "Gold Yellow"). The build
  prints every name it classed as metallic. Vallejo Game Color "Steel Grey"
  is treated as non-metallic on judgement, not evidence.
- **The original Army Painter Warpaints range is assumed discontinued**
  (superseded by Warpaints Fanatic). It stays in the catalogue so older
  tutorials resolve; the recipe translator prefers the Fanatic paint of the
  same name and offers the old one alongside, without asking.
- **The dataset has errors the build works around:** Army Painter code WP1405
  is given to two different paints (the second is identified by name); Vallejo
  72.483 and Citadel Kommando Khaki are listed twice with different colours
  (the first listing is kept).
- **The dataset was last updated in March 2025**, so paints released since
  then are missing.

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
- **Finish and opacity are not in either dataset.** They are assigned by rule
  in `scripts/buildSeedSource.py` (see above). Treat them as editorial
  assumptions.
- **Licensing:** see `THIRD_PARTY_NOTICES.md`. The paint dataset is MIT
  licensed, but its README describes the data as scraped and invites use "in
  your own personal projects"; confirm commercial use with its author before
  launch. The DMC dataset publishes no licence at all.
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
- (Revision 1 was a 111-item sample; revision 2 covers four brands' full brush ranges.)

## Phase 3: photo normalisation and colour extraction

Everything is in `src/lib/image/`. Apart from `canvasIo.ts` it has no DOM
access, so it runs in a Web Worker or in Node.

| File | What it does |
| --- | --- |
| `whiteBalance.ts` | Removes a lighting cast, from a clicked neutral point or automatically |
| `loupeSampler.ts` | De-noised colour picker: reads a 5 x 5 or 11 x 11 square, rejects glare and shadow, returns the median |
| `paletteExtractor.ts` | K-means++ in CIELAB: the 5 to 12 dominant colours of an image |
| `imageWorker.ts`, `imageWorkerProtocol.ts`, `imageWorkerClient.ts` | Web Worker entry, message protocol and a promise-based client |
| `canvasIo.ts` | Browser glue: decode a file to sRGB pixels, map a click to image coordinates |
| `pixelMath.ts` | Shared pixel buffer type, fast sRGB tables, 3 x 3 matrices |

```ts
import { decodeImage } from './src/lib/image/canvasIo';
import { createImageWorkerClient, sampleLoupe, whiteBalanceFromPoint } from './src/lib/image';

const photo = await decodeImage(file);                         // sRGB pixels, EXIF-rotated, max 2048 px
const balance = whiteBalanceFromPoint(photo, greyX, greyY);     // user clicked a grey card
const pin = sampleLoupe(photo, x, y, { kernel: 11, whiteBalance: balance.matrix });
store.getSolver().solve(pin.color, { mode: 'strict_stash' });   // straight into the Phase 1 solver

const worker = new Worker(new URL('./src/lib/image/imageWorker.ts', import.meta.url), { type: 'module' });
const palette = await createImageWorkerClient(worker).extractPalette(photo, {
  count: 8,
  whiteBalance: balance.matrix,
});
```

### White balance

A correction is a 3 x 3 matrix on linear-light sRGB. It can be baked into a
copy of the image, or handed to the sampler and palette extractor, which
correct on the fly.

- **From a reference (accurate).** The user clicks something neutral. Three
  models are offered: `bradford` (default) and `von_kries` are chromatic
  adaptations that model a change of light; `channel_gain` scales red, green
  and blue directly, which is what a camera's own white balance does.
- **Automatic (a guess).** `shades_of_gray` (default), `gray_world` or
  `white_patch` estimate the light from image statistics. All of them fail on
  scenes dominated by one colour.
- **Guards.** A reference that is too dark or blown out is refused with a
  clear message. `castChroma` reports how strong the cast was; above about 40
  the "neutral" was probably a coloured object.

### What white balance cannot do

- **It cannot recover clipped colours.** If the light pushed a colour outside
  what the photo can record (a channel at 0 or 255), that information is gone.
  Correction still improves such colours but does not restore them.
- **Neither model is exact for a real photo.** A real cast mixes the light's
  colour with whatever the camera did about it. In the tests, Bradford undoes a
  simulated change of light to within rounding, but only about halves the error
  of a simulated per-channel camera cast; `channel_gain` is the reverse.
- **It does not fix metamerism** or uneven lighting across the frame.
- **Nothing here has been tested on real photographs**, only on synthetic
  images with known answers.

### Verification

- 51 unit tests on synthetic images with known answers (181 in the whole suite).
- `npm run test:browser` decodes a PNG, corrects it and extracts a palette
  inside a real Web Worker in headless Chromium, and checks the worker returns
  exactly what the main thread computes.
- Measured in the development container on a 2048 x 1536 image: palette of 12
  50–70 ms, automatic white balance 50–75 ms, full-image correction 200–300 ms.

### Not done in this phase

- No user interface: there is no loupe or pin on screen yet (Phase 4).
- Semantic region detection ("cloak highlights") is Phase 5.

## Phase 4: the app

A React single-page app in `src/app/`, built with Vite. It is installable and
works offline after the first visit. Three tabs:

- **Photo.** Open a photo (or the built-in sample), tap to drop pins, drag
  them to fine-tune with a magnifier, and see the best match for each pin.
  Lighting can be corrected by tapping a neutral point or automatically. A
  switch chooses between **Full catalogue** (also suggests what to buy) and
  **My stash only**. The main colours of the photo can be extracted in one tap.
- **Recipe.** Paste a tutorial's supply list. Each line is resolved to a
  catalogue item and answered from the stash: owned, substitute, mix, or
  missing. Lines that nothing owned can get close to (ΔE above 4) form the
  shopping list, which can be copied.
- **Stash.** Search the catalogue and mark what you own. Saved on the device.

| Path | What it is |
| --- | --- |
| `src/app/views/WorkspaceView.tsx` | Photo canvas, draggable pins, magnifier, lighting tools, palette |
| `src/app/views/RecipeView.tsx` | Recipe translator table and shopping list |
| `src/app/views/StashView.tsx` | Catalogue browser and ownership toggles |
| `src/app/components/SplitSwatch.tsx` | Target and match touching along one sharp edge |
| `src/app/components/MatchCard.tsx` | One target and the best option for it |
| `src/lib/catalog/recipeParser.ts` | Resolves free-text lines to catalogue items |
| `src/lib/match/matchSummary.ts` | Turns a solver result into a verdict and wording |
| `src/app/serviceWorker.js`, `public/manifest.webmanifest` | Offline support and install metadata; the build writes `/sw.js` with the list of files to cache |
| `scripts/e2e.mjs` | End-to-end test of the production build |

### Design decisions

- **Plain CSS, not Tailwind.** The specification suggested Tailwind. With five
  components a single stylesheet with design tokens is smaller and has nothing
  to configure or keep compatible. It can be swapped in later if the UI grows.
- **Swatches are never decorated.** The two halves of a comparison share an
  edge with no gap, border, rounding or shadow, and sit on the same mid-grey
  in light and dark themes, because any separator or coloured surround changes
  how a difference looks. The end-to-end test measures this.
- **Recipes are resolved by rules, not a language model.** Every word of a
  paint's name must appear in the line (one typo allowed in longer words), or
  the line must carry its product code. A line that fits several items asks
  the user to choose; a line that fits none is reported, not guessed.
- **A poor nearest option is labelled as such.** When nothing owned is close,
  the nearest mix is still shown, but under "Nothing you own gets close".
- **Photos in the workspace never leave the device.** All image work happens
  in the browser. (Phase 5 later added an optional "Read a photo" stash import
  that does upload; it says so where it is offered.)

### Verification

- 198 unit tests, including 17 new ones for recipe parsing and verdicts.
- `npm run test:e2e` builds the production bundle and drives it in headless
  Chromium at 390 x 844 and 1280 x 900: builds a stash and confirms it survives
  a reload, places, drags, nudges and deletes pins, corrects lighting from the
  grey card, switches match mode, extracts a palette, translates the example
  recipe, checks the shopping list, confirms the swatch halves touch, confirms
  every built file is in the offline cache after one visit, reloads with the
  network off, and checks for sideways scrolling and console errors.

### Not done, or not verified

- **Not deployed.** Nothing has been published; `npm run build` output is
  static and can be served from any host.
- **Not tested on real devices or in Safari or Firefox**, only headless
  Chromium with touch emulation.
- **Not tested with real photographs.**
- **No accessibility audit.** Controls are labelled and keyboard-operable, and
  pins can be moved with arrow keys, but no screen-reader testing was done.
- Pins and the open photo are not saved between visits (export is Phase 5).
- No accounts or cross-device sync.

## Phase 5: stash import and recipe card export

### Stash import

Adding a few hundred paints one by one is the main barrier to using the app,
so the Stash tab has **Add many at once**:

- **Paste a list.** Matched on the device by the same rule-based resolver the
  recipe translator uses. No server, no model, works offline.
- **Read a photo** of a paint rack, a box of thread or a handwritten list.
  This is the only feature that sends anything off the device, and the app
  says so next to the button.

Either way the user reviews what was found, resolves ambiguous names, and
confirms before anything is added.

### How the photo path works

```
photo -> app downsizes to a JPEG (max 1600 px) -> POST /api/ingest
      -> Gemini reads the text on each label into { brand, name, code }
      -> deterministic matching against the catalogue
      -> candidates back to the app for review
```

The model **only reads**. It is told nothing about the catalogue, never picks
an item and never returns a colour. What it reads is treated as untrusted
text: cleaned, length-limited, and matched by code. Anything that matches
nothing is reported as unmatched, and the app ignores any item id its own
catalogue does not contain.

| Path | What it is |
| --- | --- |
| `worker/ingest.ts` | The API: validation, origin check, rate limits, label matching. No Cloudflare or model dependency, so it is fully unit-tested |
| `worker/vision.ts` | The one model call, using Google's `@google/genai` SDK with a JSON schema for the reply, which is validated again on our side |
| `worker/rateLimiter.ts` | Durable Object that counts photo imports atomically |
| `worker/index.ts` | Cloudflare Worker entry: serves the built app and answers `/api/*` |
| `wrangler.jsonc` | Worker configuration |
| `src/app/components/StashImport.tsx` | Import and review UI |

Safeguards on the endpoint:

- **Cost.** Photo import is refused unless a rate limiter is available, and
  nothing is spent if the limiter cannot be reached. Defaults are 20 photos
  per connection per hour and 500 in total per 24 hours. Counting is done by a
  Durable Object, so simultaneous requests are counted exactly. (A key-value
  store was the first design; Workers KV rejects more than one write per key
  per second, which would have failed simultaneous imports.)
- **Abuse.** Requests from another website's pages are refused; there are no
  cross-origin headers. Images over 5 MB, other file types, malformed base64
  and oversized bodies are rejected before any model call.
- **Privacy.** The Worker does not store the photo or log its contents.
  Google's Gemini API terms govern what is sent to the model. Check them for
  the tier your key is on before launch: how Google may use submitted content
  can differ between free and paid use. (Not checked as part of this change.)
- **Failure.** Upstream errors are never echoed to the client.

The model is Gemini, through the `@google/genai` SDK (3.x, which needs Node 22
or later for local tooling). The default is `gemini-3.8-flash`, the model the
SDK's own documentation uses; override it with a `VISION_MODEL` variable, and
check Google's model list for what your key can use. Each attempt times out
after 45 s, with one retry. Every call logs one JSON line with the model,
token counts (input, output and thinking), outcome and duration, and nothing
from the photo. A `GEMINI_BASE_URL` variable routes calls through a gateway.

The label reader was Claude until November 2026; the swap touched only
`worker/vision.ts`, the Worker's variable names and the disclosure text.

### Recipe card export

With pins placed, **Save as a recipe card** downloads a PNG or a PDF showing
the photo with numbered pins and, for each pin, the target and match swatches
touching, the item or mix ratio, the colour difference and the verdict.

| Path | What it is |
| --- | --- |
| `src/lib/export/recipeCard.ts` | Draws the card on a canvas at 2400 px wide |
| `src/lib/export/cardEntries.ts` | The wording of each row |
| `src/lib/export/pdf.ts` | A dependency-free PDF writer: one page wrapping the card as a JPEG |

The PNG keeps swatch colours exact. The PDF embeds a high-quality JPEG of the
same drawing, so its colours are very close but not bit-exact.

### Turning photo import on (not done)

Nothing has been deployed and no accounts or keys were created. To go live:

```sh
npx wrangler secret put GEMINI_API_KEY      # only needed for "Read a photo"; key from Google AI Studio
npm run deploy                              # builds, then deploys
```

The rate limiter's Durable Object is created by the deploy itself; there is no
storage to set up by hand. Without the key the app still deploys and works;
only "Read a photo" reports that it is not switched on.

### Verification

- 239 unit tests. 41 are new: the API (validation, limits, origin check,
  error mapping), label matching, PDF structure, card wording and text
  wrapping.
- The Worker was run in Cloudflare's local runtime (`wrangler dev`) and
  exercised with HTTP requests: health, text import, photo import refused
  without a key, foreign origin refused, static app, single-page fallback.
- The rate limiter was tested in that runtime with 30 simultaneous photo
  imports from one client against a limit of 20: exactly 20 were let through
  and 10 refused, with no server errors. (The model endpoint was pointed at a
  dead local port for this, so no real model call was made.)
- `npm run worker:check` validates the configuration and bundles the Worker.
- `npm run test:e2e` now also imports from a pasted list, checks the photo
  upload is a real JPEG, drives the review screen against a stand-in server,
  checks the "not switched on" and rate-limit messages, downloads both card
  formats, reads the swatch colours back out of the PNG and confirms they
  equal the pin colours exactly, and has an independent PDF reader (poppler)
  open and render the PDF.

### Not done, or not verified

- **The label reader has never called the real model.** It typechecks against
  the installed SDK and is tested with a stand-in. How well it reads real
  racks, small labels or handwriting is unknown until it is run with a key.
- **Not deployed.** No Worker, Durable Object or secret exists on Cloudflare.
- **Rate limits are keyed by network address**, so people behind one address
  share an allowance. There are no user accounts.
- **Durable Objects have not been exercised on Cloudflare itself**, only in
  the local runtime. Check your plan's Durable Object allowance before relying
  on it.
- **The catalogue ships inside the Worker and the app**, so a catalogue change
  needs a redeploy (and a revision bump; see "Review fixes"). The D1 schema
  from Phase 2 is not wired up yet.
- **Semantic region detection** ("cloak highlights") from the specification's
  architecture section is not built; no phase lists it as a deliverable.
- **No cross-device sync**: the local bookkeeping exists, the server half does not.
