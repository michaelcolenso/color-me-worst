/**
 * Seed data generator. Reads the curated hex list, computes CIELAB / OKLCh
 * with the colour kernel, and writes:
 *   db/seed/catalog_seed.sql        rows for the D1 `brands` and `catalog_items` tables
 *   src/data/catalogSeed.json       the same catalogue as a client bundle
 *   data/catalog/catalog.lock.json  the revision and a fingerprint of its content
 *
 * Run with `npm run seed:generate`. It refuses to run when the content has
 * changed but `revision` in the source has not: browsers only re-import a
 * catalogue with a higher revision, so such a change would never reach
 * existing users. A test fails if the committed outputs are out of date.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCatalog,
  catalogContentHash,
  catalogToJson,
  catalogToSql,
  checkRevision,
  type CatalogLock,
  type SeedSource,
} from '../src/lib/catalog/seedBuilder';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(root, 'data/catalog/catalog.lock.json');
const source = JSON.parse(readFileSync(resolve(root, 'data/catalog/seed-source.json'), 'utf8')) as SeedSource;
const catalog = buildCatalog(source);
const revision = source.revision ?? 1;
const contentHash = catalogContentHash(catalog);
const lock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, 'utf8')) as CatalogLock) : null;

const problem = checkRevision(revision, contentHash, lock);
if (problem !== null) {
  console.error(`Not generated: ${problem}`);
  process.exit(1);
}

writeFileSync(resolve(root, 'db/seed/catalog_seed.sql'), catalogToSql(catalog, revision));
writeFileSync(resolve(root, 'src/data/catalogSeed.json'), catalogToJson(catalog, revision));
writeFileSync(lockPath, `${JSON.stringify({ revision, contentHash } satisfies CatalogLock, null, 2)}\n`);

const perBrand = new Map<string, number>();
for (const item of catalog.items) perBrand.set(item.brand, (perBrand.get(item.brand) ?? 0) + 1);
console.log(`Generated revision ${revision}: ${catalog.items.length} catalogue items across ${catalog.brands.length} brands:`);
for (const [brand, count] of perBrand) console.log(`  ${brand}: ${count}`);
