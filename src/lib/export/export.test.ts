import { describe, expect, it } from 'vitest';

import { colorFromHex } from '../color/colorConversions';
import { createMatchSolver, predictMix } from '../color/index';
import type { CatalogItem } from '../color/types';
import { summarizeMatch } from '../match/matchSummary';
import { buildCardEntries } from './cardEntries';
import { wrapLines } from './cardLayout';
import { buildImagePdf } from './pdf';

const decode = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

/** Smallest thing that passes for a JPEG here: start-of-image marker, filler, end-of-image marker. */
const FAKE_JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 250, 251, 252, 0xff, 0xd9]);

describe('buildImagePdf', () => {
  const pdf = buildImagePdf(FAKE_JPEG, 2400, 3600, { title: 'Cloak (test) \\ é' });
  const text = decode(pdf);

  it('has a header, a binary marker and an end-of-file marker', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf[10]).toBeGreaterThan(127);
    expect(text.endsWith('%%EOF\n')).toBe(true);
  });

  it('has a cross-reference table whose offsets point at each object', () => {
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 9)).toBe('xref\n0 7\n');
    const rows = text.slice(startxref + 9).split('\n').slice(0, 7);
    expect(rows[0]).toBe('0000000000 65535 f ');
    rows.slice(1).forEach((row, index) => {
      expect(row).toMatch(/^\d{10} 00000 n $/);
      const offset = Number(row.slice(0, 10));
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`);
    });
    // Every row is exactly 20 bytes including its line ending, as the format requires.
    expect(text.slice(startxref + 9, startxref + 9 + 7 * 20).length).toBe(140);
    expect(text).toContain('/Size 7 /Root 1 0 R /Info 6 0 R');
  });

  it('sizes the page to the image and embeds the JPEG untouched', () => {
    expect(text).toContain('/MediaBox [0 0 595.28 892.92]');
    expect(text).toContain('q 595.28 0 0 892.92 0 0 cm /Im0 Do Q');
    expect(text).toContain(`/Width 2400 /Height 3600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${FAKE_JPEG.length}`);
    const start = text.indexOf('stream\n', text.indexOf('/DCTDecode')) + 'stream\n'.length;
    expect(Array.from(pdf.slice(start, start + FAKE_JPEG.length))).toEqual(Array.from(FAKE_JPEG));
    expect(text.slice(start + FAKE_JPEG.length, start + FAKE_JPEG.length + 11)).toBe('\nendstream\n');
  });

  it('declares stream lengths that match the stream contents', () => {
    const content = /<< \/Length (\d+) >>\nstream\n([^\n]*)\nendstream/.exec(text);
    expect(content).not.toBeNull();
    expect(Number(content?.[1])).toBe(content?.[2]?.length);
  });

  it('escapes the title and keeps it ASCII', () => {
    expect(text).toContain('/Title (Cloak \\(test\\) \\\\ ?)');
  });

  it('honours a custom page width', () => {
    expect(decode(buildImagePdf(FAKE_JPEG, 100, 50, { pageWidth: 200 }))).toContain('/MediaBox [0 0 200 100]');
  });

  it('rejects data that is not a JPEG and invalid sizes', () => {
    expect(() => buildImagePdf(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), 10, 10)).toThrow(/not a JPEG/);
    expect(() => buildImagePdf(new Uint8Array(0), 10, 10)).toThrow(RangeError);
    expect(() => buildImagePdf(FAKE_JPEG, 0, 10)).toThrow(RangeError);
    expect(() => buildImagePdf(FAKE_JPEG, 10.5, 10)).toThrow(RangeError);
    expect(() => buildImagePdf(FAKE_JPEG, 10, 10, { pageWidth: 0 })).toThrow(RangeError);
  });
});

describe('buildCardEntries', () => {
  function item(id: string, hex: string, overrides: Partial<CatalogItem> = {}): CatalogItem {
    return {
      id,
      brand: 'Brand',
      line: 'Range',
      sku: id,
      name: id,
      medium: 'acrylic_paint',
      finish: 'matte',
      opacity: 1,
      color: colorFromHex(hex),
      discontinued: false,
      ...overrides,
    };
  }
  const white = item('white', '#f4f4f0', { name: 'White' });
  const red = item('red', '#9a1115', { name: 'Red', sku: '70.957' });
  const blue = item('blue', '#1f4fa3', { name: 'Blue' });
  const catalog = [white, red, blue];
  const pin = (target: ReturnType<typeof colorFromHex>, ownedIds: string[], mode: 'full_catalog' | 'strict_stash' = 'full_catalog') => ({
    number: 1,
    x: 10,
    y: 20,
    target,
    summary: summarizeMatch(createMatchSolver({ catalog, ownedIds }).solve(target, { mode }), mode),
  });

  it('describes an owned single match with its range and code', () => {
    const [entry] = buildCardEntries([pin(red.color, [red.id])]);
    expect(entry).toMatchObject({
      number: 1,
      x: 10,
      y: 20,
      title: 'Brand Red',
      detail: 'Range, 70.957',
      note: 'Exact match · dE 0.0',
    });
    expect(entry?.matchColor?.hex).toBe(red.color.hex);
    expect(entry?.target.hex).toBe(red.color.hex);
  });

  it('omits a code that is just the name again', () => {
    const [entry] = buildCardEntries([pin(white.color, [white.id])]);
    expect(entry?.detail).toBe('Range');
  });

  it('describes a mix by its ratio and shows the predicted colour', () => {
    const target = predictMix(white, red, [3, 1]);
    const [entry] = buildCardEntries([pin(target, [white.id, red.id], 'strict_stash')]);
    expect(entry?.title).toBe('3 parts White : 1 part Red');
    expect(entry?.detail).toBe('Predicted mix; test on a spare surface first.');
    expect(entry?.note).toMatch(/^Mix from your stash · dE 0\.0$/);
    expect(entry?.matchColor?.hex).toBe(target.hex);
  });

  it('says so plainly when the nearest owned option is poor, and names what to buy', () => {
    const [entry] = buildCardEntries([pin(red.color, [blue.id])]);
    expect(entry?.title).toBe('Brand Blue');
    expect(entry?.detail).toMatch(/^Nearest owned, not a good match\. Range\. Closer if bought: Brand Red \(dE 0\.0\)$/);
    expect(entry?.note).toMatch(/^Not in your stash · dE /);
  });

  it('falls back to the item to buy, or the bare target, when nothing is owned', () => {
    const [withCatalog] = buildCardEntries([pin(red.color, [])]);
    expect(withCatalog).toMatchObject({ title: 'Brand Red', note: 'Nothing to compare' });
    expect(withCatalog?.detail).toBe('Not owned. Range, dE 0.0');
    expect(withCatalog?.matchColor?.hex).toBe(red.color.hex);

    const [strict] = buildCardEntries([pin(red.color, [], 'strict_stash')]);
    expect(strict).toMatchObject({ title: 'Target #9a1115', detail: 'Nothing in the stash to compare.' });
    expect(strict?.matchColor).toBeUndefined();
  });

  it('keeps pins in order', () => {
    const pins = [1, 2, 3].map((number) => ({ ...pin(red.color, [red.id]), number }));
    expect(buildCardEntries(pins).map((entry) => entry.number)).toEqual([1, 2, 3]);
    expect(buildCardEntries([])).toEqual([]);
  });
});

describe('wrapLines', () => {
  /** Ten units per character: predictable widths without a canvas. */
  const measure = (text: string) => text.length * 10;

  it('keeps short text on one line', () => {
    expect(wrapLines('Mephiston Red', 200, measure)).toEqual(['Mephiston Red']);
    expect(wrapLines('', 200, measure)).toEqual([]);
    expect(wrapLines('   ', 200, measure)).toEqual([]);
  });

  it('never drops any part of text that has no line limit', () => {
    const recipe = '4 parts Bold Titanium White : 1 part Mechanicus Standard Grey';
    for (const width of [600, 300, 200, 120, 60]) {
      const lines = wrapLines(recipe, width, measure);
      expect(lines.join(' ').replace(/\s+/g, '')).toBe(recipe.replace(/\s+/g, ''));
      expect(lines.every((line) => measure(line) <= width)).toBe(true);
      expect(lines.some((line) => line.includes('…'))).toBe(false);
    }
    expect(wrapLines(recipe, 320, measure)).toEqual(['4 parts Bold Titanium White : 1', 'part Mechanicus Standard Grey']);
  });

  it('splits a single word that is wider than the line instead of overflowing', () => {
    expect(wrapLines('Supercalifragilistic', 80, measure)).toEqual(['Supercal', 'ifragili', 'stic']);
  });

  it('cuts with an ellipsis only when a line limit is given', () => {
    const text = 'one two three four five six seven eight';
    expect(wrapLines(text, 100, measure, { maxLines: 2 })).toEqual(['one two', 'three fou…']);
    expect(wrapLines(text, 100, measure, { maxLines: 2 }).every((line) => measure(line) <= 100)).toBe(true);
    expect(wrapLines('one two', 100, measure, { maxLines: 2 })).toEqual(['one two']);
    expect(wrapLines(text, 100, measure, { maxLines: 1 })).toEqual(['one two…']);
  });
});
