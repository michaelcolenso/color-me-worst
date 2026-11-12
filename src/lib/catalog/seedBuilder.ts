/**
 * Turns hand-curated seed rows (hex plus metadata) into full catalogue items
 * with pre-computed CIELAB / OKLCh coordinates, and serialises them as SQL
 * for the D1 schema in migrations/0001_initial_schema.sql.
 *
 * Pure functions only: no file or network access, so the same code runs in
 * the generator script, in tests and, later, in an admin import tool.
 */

import { colorFromHex } from '../color/colorConversions';
import type { CatalogItem, ColorSource, FinishType, MediumType } from '../color/types';

/** One row of data/catalog/seed-source.json. */
export interface SeedSourceItem {
  brand: string;
  line: string;
  sku: string;
  name: string;
  hex: string;
  medium: MediumType;
  finish: FinishType;
  opacity: number;
  discontinued: boolean;
  /** Where the hex came from, free text. */
  source: string;
  /** Defaults to `community`. */
  colorSource?: ColorSource;
}

export interface SeedSource {
  description: string;
  items: SeedSourceItem[];
}

export interface BrandRecord {
  id: string;
  name: string;
}

export interface BuiltCatalog {
  brands: BrandRecord[];
  items: CatalogItem[];
  /** Free-text provenance per item id, kept out of `CatalogItem` to keep the client payload small. */
  sourceNotes: Record<string, string>;
}

const MEDIA: readonly MediumType[] = [
  'acrylic_paint',
  'enamel_paint',
  'oil_paint',
  'embroidery_floss',
  'alcohol_marker',
  'fabric',
  'bead',
  'leather_dye',
];
const FINISHES: readonly FinishType[] = [
  'matte',
  'satin',
  'gloss',
  'metallic',
  'wash',
  'contrast',
  'fluorescent',
  'variegated',
];
const COLOR_SOURCES: readonly ColorSource[] = ['community', 'manufacturer', 'measured'];

/** Lower-case, ASCII, hyphen-separated. Stable: ids are built from it. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Deterministic catalogue id: `<brand>:<line>:<sku>`, each part slugified. */
export function catalogItemId(brand: string, line: string, sku: string): string {
  return `${slugify(brand)}:${slugify(line)}:${slugify(sku)}`;
}

function fail(index: number, message: string): never {
  throw new Error(`Seed item ${index}: ${message}`);
}

/**
 * Validate seed rows and compute their colour coordinates.
 * @throws {Error} naming the offending row on any invalid or duplicate entry.
 */
export function buildCatalog(source: SeedSource): BuiltCatalog {
  const brands = new Map<string, BrandRecord>();
  const items: CatalogItem[] = [];
  const sourceNotes: Record<string, string> = {};
  const seen = new Set<string>();

  source.items.forEach((row, index) => {
    for (const field of ['brand', 'line', 'sku', 'name', 'source'] as const) {
      if (typeof row[field] !== 'string' || row[field].trim() === '') fail(index, `"${field}" is required`);
    }
    if (!MEDIA.includes(row.medium)) fail(index, `unknown medium "${String(row.medium)}"`);
    if (!FINISHES.includes(row.finish)) fail(index, `unknown finish "${String(row.finish)}"`);
    if (typeof row.opacity !== 'number' || !(row.opacity >= 0 && row.opacity <= 1)) {
      fail(index, 'opacity must be a number from 0 to 1');
    }
    if (typeof row.discontinued !== 'boolean') fail(index, '"discontinued" must be true or false');
    const colorSource = row.colorSource ?? 'community';
    if (!COLOR_SOURCES.includes(colorSource)) fail(index, `unknown colorSource "${String(colorSource)}"`);

    const id = catalogItemId(row.brand, row.line, row.sku);
    if (seen.has(id)) fail(index, `duplicate id "${id}"`);
    seen.add(id);

    let color;
    try {
      color = colorFromHex(row.hex);
    } catch {
      fail(index, `invalid hex "${String(row.hex)}"`);
    }

    const brandId = slugify(row.brand);
    const existing = brands.get(brandId);
    if (existing === undefined) brands.set(brandId, { id: brandId, name: row.brand });
    else if (existing.name !== row.brand) fail(index, `brand "${row.brand}" collides with "${existing.name}"`);

    items.push({
      id,
      brand: row.brand,
      line: row.line,
      sku: row.sku,
      name: row.name,
      medium: row.medium,
      finish: row.finish,
      opacity: row.opacity,
      color,
      discontinued: row.discontinued,
      colorSource,
    });
    sourceNotes[id] = row.source;
  });

  return { brands: [...brands.values()], items, sourceNotes };
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Six decimals is far below any visible difference and keeps the file diff-stable. */
function sqlReal(value: number): string {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * Serialise a built catalogue as idempotent SQL for the D1 schema. Re-running
 * it updates existing rows in place, so it is safe to apply repeatedly.
 */
export function catalogToSql(catalog: BuiltCatalog, revision = 1): string {
  const lines: string[] = [
    '-- GENERATED FILE — do not edit by hand.',
    '-- Produced by scripts/generateSeed.ts from data/catalog/seed-source.json.',
    '-- Idempotent: safe to apply more than once.',
    '',
  ];
  for (const brand of catalog.brands) {
    lines.push(
      `INSERT INTO brands (id, name) VALUES (${sqlText(brand.id)}, ${sqlText(brand.name)}) ` +
        'ON CONFLICT (id) DO UPDATE SET name = excluded.name;',
    );
  }
  lines.push('');
  const columns =
    'id, brand_id, line, sku, name, medium, finish, opacity, hex, rgb_r, rgb_g, rgb_b, ' +
    'lab_l, lab_a, lab_b, oklch_l, oklch_c, oklch_h, color_source, source_note, discontinued, revision';
  const updates = columns
    .split(', ')
    .filter((column) => column !== 'id')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  for (const item of catalog.items) {
    const { color } = item;
    const values = [
      sqlText(item.id),
      sqlText(slugify(item.brand)),
      sqlText(item.line),
      sqlText(item.sku),
      sqlText(item.name),
      sqlText(item.medium),
      sqlText(item.finish),
      sqlReal(item.opacity),
      sqlText(color.hex),
      String(color.rgb[0]),
      String(color.rgb[1]),
      String(color.rgb[2]),
      sqlReal(color.lab[0]),
      sqlReal(color.lab[1]),
      sqlReal(color.lab[2]),
      sqlReal(color.oklch[0]),
      sqlReal(color.oklch[1]),
      sqlReal(color.oklch[2]),
      sqlText(item.colorSource ?? 'community'),
      sqlText(catalog.sourceNotes[item.id] ?? ''),
      item.discontinued ? '1' : '0',
      String(revision),
    ];
    lines.push(
      `INSERT INTO catalog_items (${columns}) VALUES (${values.join(', ')}) ` +
        `ON CONFLICT (id) DO UPDATE SET ${updates};`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Client payload: the catalogue items plus the revision they belong to. */
export interface CatalogBundle {
  revision: number;
  items: CatalogItem[];
}

/** Serialise the client bundle with rounded coordinates, one item per line. */
export function catalogToJson(catalog: BuiltCatalog, revision = 1): string {
  const round = (value: number) => {
    const rounded = Number(value.toFixed(6));
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  const rows = catalog.items.map((item) =>
    JSON.stringify({
      ...item,
      color: {
        hex: item.color.hex,
        rgb: item.color.rgb,
        lab: item.color.lab.map(round),
        oklch: item.color.oklch.map(round),
      },
    }),
  );
  return `{"revision":${revision},"items":[\n${rows.join(',\n')}\n]}\n`;
}
