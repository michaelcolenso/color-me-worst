# Contributing

## Set up

Node 22 or later (the Gemini SDK requires it).

```sh
npm ci
npm run dev        # app at the printed local address
```

The browser checks need Playwright with Chromium installed on the machine
(it is deliberately not a project dependency), and the PDF check needs
poppler (`pdfinfo`, `pdftoppm`):

```sh
npm install --no-save playwright@1.63.0
npx playwright install --with-deps chromium
sudo apt-get install -y poppler-utils   # or your platform's equivalent
```

## Before opening a pull request

Run what CI runs (`docs/ci/github-actions-ci.yml`, to be moved to `.github/workflows/ci.yml`):

```sh
npm test               # unit tests, including catalogue, seed and schema checks
npm run build          # type check and production bundle
npm run worker:check   # bundles the Worker as a deploy would; deploys nothing
npm run test:browser   # image pipeline in headless Chromium
npm run test:e2e       # the built app at phone and desktop sizes
```

A pull request should say which of these you ran and what each reported.
A check that could not run is "not run", not "passed".

## Changing the catalogue

1. Edit `data/catalog/seed-source.json` (or `scripts/buildSeedSource.py` and
   re-run it).
2. Increase `"revision"` in `seed-source.json`. Browsers only re-import a
   catalogue whose revision is higher than the one they already hold, so a
   change at the same revision never reaches existing users.
3. If an item's brand, range or code changes, its id changes. Add the old id
   to the item's `"formerIds"` so people who own it keep it.
4. Run `npm run seed:generate` and commit the regenerated files, including
   `data/catalog/catalog.lock.json`. The generator and a test both refuse
   changed content at an unchanged revision.
5. Record where new colour values came from (`"source"`, and `"colorSource"`:
   `community`, `manufacturer` or `measured`). Do not add data whose licence
   does not allow redistribution.

## Ground rules

- The colour kernel (`src/lib/color/`) has no runtime dependencies; keep it
  that way.
- Anything a language model returns is untrusted text. It never selects a
  catalogue item or a colour by itself; deterministic code does, and the user
  confirms anything uncertain.
- Wording in the interface must not claim more than the data supports:
  catalogue colours are approximations, and mixes are estimates.
- Never skip, disable or weaken a test to make a change pass.
