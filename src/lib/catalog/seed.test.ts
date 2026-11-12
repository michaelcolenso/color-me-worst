import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it } from 'vitest';

import { colorFromHex } from '../color/colorConversions';
import type { CatalogItem } from '../color/types';
import {
  buildCatalog,
  catalogItemId,
  catalogToJson,
  catalogToSql,
  slugify,
  type CatalogBundle,
  type SeedSource,
  type SeedSourceItem,
} from './seedBuilder';

const root = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const source = JSON.parse(read('data/catalog/seed-source.json')) as SeedSource;
const migration = read('migrations/0001_initial_schema.sql');
const committedSql = read('db/seed/catalog_seed.sql');
const committedBundle = JSON.parse(read('src/data/catalogSeed.json')) as CatalogBundle;
const catalog = buildCatalog(source);

function row(overrides: Partial<SeedSourceItem> = {}): SeedSourceItem {
  return {
    brand: 'Brand',
    line: 'Line',
    sku: '001',
    name: 'Colour',
    hex: '#123456',
    medium: 'acrylic_paint',
    finish: 'matte',
    opacity: 1,
    discontinued: false,
    source: 'test',
    ...overrides,
  };
}

describe('seed source', () => {
  it('has at least 50 entries spanning the four required ranges', () => {
    expect(source.items.length).toBeGreaterThanOrEqual(50);
    const count = (brand: string, line?: string) =>
      source.items.filter((item) => item.brand === brand && (line === undefined || item.line === line)).length;
    expect(count('Citadel')).toBeGreaterThanOrEqual(10);
    expect(count('Vallejo', 'Model Color')).toBeGreaterThanOrEqual(10);
    expect(count('Monument Hobbies', 'Pro Acryl')).toBeGreaterThanOrEqual(10);
    expect(count('DMC')).toBeGreaterThanOrEqual(10);
  });

  it('covers the finishes the matching rules depend on', () => {
    const finishes = new Set(source.items.map((item) => item.finish));
    for (const finish of ['matte', 'metallic', 'wash', 'contrast', 'fluorescent', 'gloss']) {
      expect(finishes.has(finish as SeedSourceItem['finish'])).toBe(true);
    }
    expect(source.items.some((item) => item.discontinued)).toBe(true);
    expect(source.items.every((item) => item.source.length > 0)).toBe(true);
  });
});

describe('seedBuilder', () => {
  it('slugifies names into stable ids', () => {
    expect(slugify("  Bugman's Glow ")).toBe('bugman-s-glow');
    expect(slugify('Créme Brûlée')).toBe('creme-brulee');
    expect(catalogItemId('Vallejo', 'Model Color', '70.950')).toBe('vallejo:model-color:70-950');
  });

  it('pre-computes CIELAB and OKLCh from each hex with the colour kernel', () => {
    expect(catalog.items).toHaveLength(source.items.length);
    expect(new Set(catalog.items.map((item) => item.id)).size).toBe(catalog.items.length);
    catalog.items.forEach((item, index) => {
      const expected = colorFromHex((source.items[index] as SeedSourceItem).hex);
      expect(item.color).toEqual(expected);
      expect(item.colorSource).toBe('community');
    });
    expect(catalog.brands.map((brand) => brand.id).sort()).toEqual(['citadel', 'dmc', 'monument-hobbies', 'vallejo']);
  });

  it('rejects invalid rows with a message naming the row', () => {
    const build = (item: SeedSourceItem, second?: SeedSourceItem) =>
      buildCatalog({ description: '', items: second ? [item, second] : [item] });
    expect(() => build(row({ hex: '#0' }))).toThrow(/Seed item 0: invalid hex/);
    expect(() => build(row({ opacity: 1.5 }))).toThrow(/opacity/);
    expect(() => build(row({ name: ' ' }))).toThrow(/"name" is required/);
    expect(() => build(row({ medium: 'watercolour' as never }))).toThrow(/unknown medium/);
    expect(() => build(row({ finish: 'shiny' as never }))).toThrow(/unknown finish/);
    expect(() => build(row({ colorSource: 'guess' as never }))).toThrow(/unknown colorSource/);
    expect(() => build(row(), row({ name: 'Other' }))).toThrow(/Seed item 1: duplicate id/);
    expect(() => build(row(), row({ brand: 'BRAND', sku: '002' }))).toThrow(/collides/);
  });

  it('escapes quotes in generated SQL', () => {
    const sql = catalogToSql(buildCatalog({ description: '', items: [row({ name: "Bugman's Glow" })] }));
    expect(sql).toContain("'Bugman''s Glow'");
  });

  it('keeps the committed seed files in step with the source', () => {
    // If this fails, run `npm run seed:generate` and commit the result.
    expect(committedSql).toBe(catalogToSql(catalog));
    expect(read('src/data/catalogSeed.json')).toBe(catalogToJson(catalog));
    expect(committedBundle.revision).toBe(1);
    expect(committedBundle.items).toHaveLength(catalog.items.length);
  });
});

describe('database schema (SQLite, as used by Cloudflare D1)', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(migration);
    db.exec(committedSql);
  });

  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  const insertItem = (overrides: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      id: 'test:line:1',
      brand_id: 'citadel',
      line: 'Line',
      sku: '1',
      name: 'Test',
      medium: 'acrylic_paint',
      finish: 'matte',
      opacity: 1,
      hex: '#aabbcc',
      rgb_r: 170,
      rgb_g: 187,
      rgb_b: 204,
      lab_l: 75,
      lab_a: -2,
      lab_b: -10,
      oklch_l: 0.78,
      oklch_c: 0.03,
      oklch_h: 250,
      ...overrides,
    };
    const columns = Object.keys(values);
    db.prepare(
      `INSERT INTO catalog_items (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).run(...(Object.values(values) as Array<string | number>));
  };

  it('creates the four required tables', () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    ).map((table) => table.name);
    for (const table of ['brands', 'catalog_items', 'user_stashes', 'recipes', 'recipe_items']) {
      expect(tables).toContain(table);
    }
  });

  it('loads the seed, and loading it twice changes nothing', () => {
    expect(count('brands')).toBe(4);
    expect(count('catalog_items')).toBe(catalog.items.length);
    db.exec(committedSql);
    expect(count('brands')).toBe(4);
    expect(count('catalog_items')).toBe(catalog.items.length);
  });

  it('stores the same colour coordinates the kernel computes', () => {
    const rows = db
      .prepare('SELECT id, hex, rgb_r, rgb_g, rgb_b, lab_l, lab_a, lab_b, oklch_l, oklch_c, oklch_h FROM catalog_items')
      .all() as Array<Record<string, number | string>>;
    const byId = new Map(catalog.items.map((item) => [item.id, item] as const));
    expect(rows).toHaveLength(catalog.items.length);
    for (const stored of rows) {
      const item = byId.get(stored.id as string) as CatalogItem;
      expect(stored.hex).toBe(item.color.hex);
      expect([stored.rgb_r, stored.rgb_g, stored.rgb_b]).toEqual(item.color.rgb);
      (['lab_l', 'lab_a', 'lab_b'] as const).forEach((column, i) => {
        expect(stored[column] as number).toBeCloseTo(item.color.lab[i] as number, 5);
      });
      (['oklch_l', 'oklch_c', 'oklch_h'] as const).forEach((column, i) => {
        expect(stored[column] as number).toBeCloseTo(item.color.oklch[i] as number, 5);
      });
    }
  });

  it('rejects values outside the allowed enumerations and ranges', () => {
    expect(() => insertItem()).not.toThrow();
    expect(() => insertItem({ id: 'x:1', sku: '2', medium: 'watercolour' })).toThrow(/CHECK/);
    expect(() => insertItem({ id: 'x:2', sku: '3', finish: 'shiny' })).toThrow(/CHECK/);
    expect(() => insertItem({ id: 'x:3', sku: '4', opacity: 1.2 })).toThrow(/CHECK/);
    expect(() => insertItem({ id: 'x:4', sku: '5', hex: '#AABBCC' })).toThrow(/CHECK/);
    expect(() => insertItem({ id: 'x:5', sku: '6', hex: 'aabbcc' })).toThrow(/CHECK/);
    expect(() => insertItem({ id: 'x:6', sku: '7', rgb_r: 256 })).toThrow(/CHECK/);
    expect(() => insertItem({ id: 'x:7', sku: '8', color_source: 'guess' })).toThrow(/CHECK/);
  });

  it('enforces brand references and one SKU per brand line', () => {
    expect(() => insertItem({ brand_id: 'no-such-brand' })).toThrow(/FOREIGN KEY/);
    insertItem();
    expect(() => insertItem({ id: 'test:line:other' })).toThrow(/UNIQUE/);
  });

  it('keeps one stash row per user and item, and only for real items', () => {
    const itemId = (catalog.items[0] as CatalogItem).id;
    const insert = db.prepare(
      'INSERT INTO user_stashes (user_id, catalog_item_id, quantity, updated_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('user-1', itemId, 2, 1000);
    insert.run('user-2', itemId, 1, 1000);
    expect(() => insert.run('user-1', itemId, 1, 2000)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert.run('user-1', 'missing:item:1', 1, 1000)).toThrow(/FOREIGN KEY/);
    expect(() => insert.run('user-3', itemId, -1, 1000)).toThrow(/CHECK/);
  });

  it('deletes recipe items with their recipe and validates target colours', () => {
    db.prepare('INSERT INTO recipes (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      'recipe-1',
      'user-1',
      'Blood Angel',
      1000,
      1000,
    );
    const insert = db.prepare(
      'INSERT INTO recipe_items (recipe_id, position, label, catalog_item_id, target_hex, target_lab_l, target_lab_a, target_lab_b) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('recipe-1', 0, 'armour', (catalog.items[1] as CatalogItem).id, '#960c09', 31.3, 52.2, 41.1);
    insert.run('recipe-1', 1, 'pin on photo', null, '#c0c0c0', 77.7, 0, 0);
    expect(() => insert.run('recipe-1', 2, 'bad', null, 'red', 0, 0, 0)).toThrow(/CHECK/);
    expect(() => insert.run('no-recipe', 0, 'orphan', null, '#000000', 0, 0, 0)).toThrow(/FOREIGN KEY/);
    expect(count('recipe_items')).toBe(2);
    db.prepare('DELETE FROM recipes WHERE id = ?').run('recipe-1');
    expect(count('recipe_items')).toBe(0);
  });

  it('answers the hot queries from indexes, not table scans', () => {
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((step) => step.detail).join(' | ');
    expect(plan("SELECT * FROM catalog_items WHERE brand_id = 'citadel' AND line = 'Base'")).toContain(
      'idx_catalog_items_brand_line',
    );
    expect(plan('SELECT * FROM catalog_items WHERE revision > 3')).toContain('idx_catalog_items_revision');
    expect(plan("SELECT * FROM catalog_items WHERE medium = 'acrylic_paint' AND lab_l BETWEEN 40 AND 60")).toMatch(
      /idx_catalog_items_(lightness|medium_finish)/,
    );
    expect(plan("SELECT * FROM user_stashes WHERE user_id = 'u' AND updated_at > 5")).toContain('idx_user_stashes_sync');
    expect(plan("SELECT * FROM user_stashes WHERE user_id = 'u'")).not.toContain('SCAN');
    expect(plan("SELECT * FROM recipes WHERE user_id = 'u' AND updated_at > 5")).toContain('idx_recipes_sync');
  });
});
