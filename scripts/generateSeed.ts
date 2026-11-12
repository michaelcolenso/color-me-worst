/**
 * Seed data generator. Reads the curated hex list, computes CIELAB / OKLCh
 * with the colour kernel, and writes:
 *   db/seed/catalog_seed.sql   rows for the D1 `brands` and `catalog_items` tables
 *   src/data/catalogSeed.json  the same catalogue as a client bundle
 *
 * Run with `npm run seed:generate`. A test fails if the committed outputs are
 * out of date with the source.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog, catalogToJson, catalogToSql, type SeedSource } from '../src/lib/catalog/seedBuilder';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(readFileSync(resolve(root, 'data/catalog/seed-source.json'), 'utf8')) as SeedSource;
const catalog = buildCatalog(source);

writeFileSync(resolve(root, 'db/seed/catalog_seed.sql'), catalogToSql(catalog));
writeFileSync(resolve(root, 'src/data/catalogSeed.json'), catalogToJson(catalog));

const perBrand = new Map<string, number>();
for (const item of catalog.items) perBrand.set(item.brand, (perBrand.get(item.brand) ?? 0) + 1);
console.log(`Generated ${catalog.items.length} catalogue items across ${catalog.brands.length} brands:`);
for (const [brand, count] of perBrand) console.log(`  ${brand}: ${count}`);
