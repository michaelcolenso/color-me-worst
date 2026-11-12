import { describe, expect, it } from 'vitest';

import { createRecipeResolver } from '../catalog/recipeParser';
import type { CatalogBundle } from '../catalog/seedBuilder';
import { colorFromHex } from '../color/colorConversions';
import { createMatchSolver, predictMix } from '../color/index';
import type { CatalogItem } from '../color/types';
import seedBundle from '../../data/catalogSeed.json';
import { BUY_MIN_IMPROVEMENT, describeMix, formatDeltaE, summarizeMatch } from './matchSummary';

const seed = (seedBundle as unknown as CatalogBundle).items;
const resolver = createRecipeResolver(seed);
const byId = (id: string) => {
  const found = seed.find((item) => item.id === id);
  if (!found) throw new Error(`missing seed item ${id}`);
  return found;
};

function item(id: string, hex: string, overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    brand: 'Brand',
    line: 'Line',
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

describe('recipeParser', () => {
  const idOf = (line: string) => {
    const resolved = resolver.resolveLine(line);
    return resolved.kind === 'item' ? resolved.item.id : resolved.kind;
  };

  it('resolves names however a tutorial writes them', () => {
    expect(idOf('Mephiston Red')).toBe('citadel:base:mephiston-red');
    expect(idOf('- citadel mephiston red (base)')).toBe('citadel:base:mephiston-red');
    expect(idOf('2x NULN OIL')).toBe('citadel:shade:nuln-oil');
    expect(idOf('3. Retributor Armour x2')).toBe('citadel:base:retributor-armour');
    expect(idOf('• Evil Sunz Scarlet (1 pot)')).toBe('citadel:layer:evil-sunz-scarlet');
    expect(idOf('Pro Acryl Bold Titanium White')).toBe('monument-hobbies:pro-acryl:001');
  });

  it('prefers the longest name that fits', () => {
    expect(idOf('Coal Black')).toBe('monument-hobbies:pro-acryl:002');
    expect(idOf('Vallejo Flat Red')).toBe('vallejo:model-color:70-957');
    expect(idOf('Glossy Black')).toBe('vallejo:model-color:70-861');
  });

  it('matches product codes, needing the brand only when the code is a bare number', () => {
    expect(idOf('70.950')).toBe('vallejo:model-color:70-950');
    expect(idOf('VMC 70.951')).toBe('vallejo:model-color:70-951');
    expect(idOf('DMC 310')).toBe('dmc:six-strand-cotton-floss:310');
    expect(idOf('B5200')).toBe('dmc:six-strand-cotton-floss:b5200');
    expect(idOf('310')).toBe('unknown');
    expect(idOf('pro acryl 001')).toBe('monument-hobbies:pro-acryl:001');
  });

  it('tolerates one typo in a longer word, but not in short ones', () => {
    expect(idOf('Mephistan Red')).toBe('citadel:base:mephiston-red');
    expect(idOf('Abadon Black')).toBe('citadel:base:abaddon-black');
    expect(idOf('Macrage Blue')).toBe('citadel:base:macragge-blue');
    expect(idOf('Nuln Oli')).toBe('unknown'); // "oil" is too short to guess at
  });

  it('uses brand words to break ties and reports the rest as alternatives', () => {
    const plain = resolver.resolveLine('Ivory');
    expect(plain.kind).toBe('item');
    if (plain.kind !== 'item') return;
    const candidates = [plain.item, ...plain.alternatives].map((entry) => entry.brand).sort();
    expect(candidates).toEqual(['Monument Hobbies', 'Vallejo']);

    const vallejo = resolver.resolveLine('Vallejo Ivory');
    expect(vallejo.kind === 'item' && vallejo.item.brand).toBe('Vallejo');
    expect(vallejo.kind === 'item' && vallejo.alternatives).toEqual([]);
    const monument = resolver.resolveLine('Ivory (Monument)');
    expect(monument.kind === 'item' && monument.item.brand).toBe('Monument Hobbies');
  });

  it('reads hex colours as direct targets', () => {
    const withLabel = resolver.resolveLine('Cloak shadow: #2B3A67');
    expect(withLabel).toMatchObject({ kind: 'color', label: 'Cloak shadow' });
    expect(withLabel.kind === 'color' && withLabel.color.hex).toBe('#2b3a67');
    const bare = resolver.resolveLine('#abc');
    expect(bare).toMatchObject({ kind: 'color', label: '#abc' });
    expect(bare.kind === 'color' && bare.color.hex).toBe('#aabbcc');
  });

  it('reports what it cannot place instead of guessing', () => {
    expect(resolver.resolveLine('Unicorn Tears')).toEqual({ kind: 'unknown', raw: 'Unicorn Tears' });
    expect(resolver.resolveLine('a fine detail brush')).toMatchObject({ kind: 'unknown' });
    expect(resolver.resolveLine('   ')).toMatchObject({ kind: 'unknown' });
  });

  it('splits pasted text on lines, semicolons and commas', () => {
    const text = `Paints you will need:
      - Mephiston Red
      - Evil Sunz Scarlet, Wild Rider Red
      Nuln Oil; Agrax Earthshade

      Highlight: #ffe0c0`;
    const kinds = resolver.resolve(text).map((line) => (line.kind === 'item' ? line.item.name : line.kind));
    expect(kinds).toEqual([
      'unknown',
      'Mephiston Red',
      'Evil Sunz Scarlet',
      'Wild Rider Red',
      'Nuln Oil',
      'Agrax Earthshade',
      'color',
    ]);
    expect(resolver.resolve('')).toEqual([]);
  });

  it('never lets one comma-separated entry swallow another', () => {
    const names = (text: string) =>
      resolver.resolve(text).map((line) => (line.kind === 'item' ? line.item.name : `${line.kind}:${line.raw}`));
    // A product code scores far higher than a name, but the name is still its own entry.
    expect(names('Vallejo 70.950 Black, Mephiston Red')).toEqual(['Black', 'Mephiston Red']);
    // An unrecognised entry is reported, not dropped.
    expect(names('Mephiston Red, Unicorn Tears')).toEqual(['Mephiston Red', 'unknown:Unicorn Tears']);
    expect(names('Unicorn Tears, Mephiston Red, Nuln Oil')).toEqual(['unknown:Unicorn Tears', 'Mephiston Red', 'Nuln Oil']);
    expect(names('Nuln Oil, #3a1418')).toEqual(['Nuln Oil', 'color:#3a1418']);
    expect(names('Mephiston Red,, ')).toEqual(['Mephiston Red']);
  });

  it('keeps one item written with a comma as one entry', () => {
    const names = (text: string) =>
      resolver.resolve(text).map((line) => (line.kind === 'item' ? `${line.item.brand} ${line.item.name}` : line.kind));
    expect(names('Mephiston Red, Citadel')).toEqual(['Citadel Mephiston Red']);
    expect(names('Black, Vallejo 70.950')).toEqual(['Vallejo Black']);
    expect(names('Ivory, Vallejo Model Color')).toEqual(['Vallejo Ivory']);
    expect(names('Red, Mephiston')).toEqual(['Citadel Mephiston Red']);
    // The same paint named twice on one line is still one thing to own.
    expect(names('Mephiston Red, Mephiston Red')).toEqual(['Citadel Mephiston Red']);
  });
});

describe('matchSummary', () => {
  const white = item('white', '#f4f4f0');
  const red = item('red', '#9a1115');
  const blue = item('blue', '#1f4fa3');
  const nearRed = item('near-red', '#9c1418');
  const catalog = [white, red, blue, nearRed];

  it('reports an exact or close owned match', () => {
    const solver = createMatchSolver({ catalog, ownedIds: [red.id, white.id] });
    const exact = summarizeMatch(solver.solve(red.color), 'strict_stash');
    expect(exact.verdict).toBe('exact');
    expect(exact.owned).toMatchObject({ kind: 'single' });
    expect(exact.ownedColor?.hex).toBe(red.color.hex);
    expect(exact.ownedDeltaE).toBe(0);
    expect(exact.toBuy).toBeUndefined();

    const close = summarizeMatch(solver.solve('#a2181b'), 'strict_stash');
    expect(close.verdict).toBe('close');
    expect(close.ownedDeltaE as number).toBeGreaterThanOrEqual(1.5);
    expect(close.ownedDeltaE as number).toBeLessThan(2.5);
  });

  it('reports a mix with its predicted colour', () => {
    const solver = createMatchSolver({ catalog, ownedIds: [red.id, white.id, blue.id] });
    const target = predictMix(white, red, [2, 1]);
    const summary = summarizeMatch(solver.solve(target), 'strict_stash');
    expect(summary.verdict).toBe('mix');
    expect(summary.owned?.kind).toBe('mix');
    expect(summary.ownedColor?.hex).toBe(target.hex);
    expect(summary.owned?.kind === 'mix' && describeMix(summary.owned.mix)).toBe('2 parts white : 1 part red');
    expect(summary.quality).toBe('exact');
  });

  it('reports a gap, still showing the nearest owned option', () => {
    const solver = createMatchSolver({ catalog, ownedIds: [blue.id] });
    const summary = summarizeMatch(solver.solve(red.color), 'strict_stash');
    expect(summary.verdict).toBe('gap');
    expect(summary.owned).toMatchObject({ kind: 'single' });
    expect(summary.quality).toBe('poor');
  });

  it('reports an empty stash distinctly from a gap', () => {
    const summary = summarizeMatch(createMatchSolver({ catalog, ownedIds: [] }).solve(red.color), 'full_catalog');
    expect(summary.verdict).toBe('empty');
    expect(summary.owned).toBeUndefined();
    expect(summary.ownedDeltaE).toBeNull();
    expect(summary.toBuy?.item.id).toBe(red.id);
  });

  it('suggests a purchase only in full-catalogue mode and only when clearly better', () => {
    const owningBlue = createMatchSolver({ catalog, ownedIds: [blue.id] });
    const full = summarizeMatch(owningBlue.solve(red.color), 'full_catalog');
    expect(full.toBuy?.item.id).toBe(red.id);
    expect(summarizeMatch(owningBlue.solve(red.color, { mode: 'strict_stash' }), 'strict_stash').toBuy).toBeUndefined();

    // Owning something within the margin of the best catalogue item: nothing to buy.
    const owningNearRed = createMatchSolver({ catalog, ownedIds: [nearRed.id] });
    const solved = owningNearRed.solve(red.color);
    expect(solved.bestOwnedSingle?.deltaE00 as number).toBeLessThan(BUY_MIN_IMPROVEMENT);
    expect(summarizeMatch(solved, 'full_catalog').toBuy).toBeUndefined();
  });

  it('formats numbers and ratios for display', () => {
    expect(formatDeltaE(0)).toBe('0.0');
    expect(formatDeltaE(0.04)).toBe('0.0');
    expect(formatDeltaE(2.449)).toBe('2.4');
    expect(formatDeltaE(12.96)).toBe('13.0');
    const mix = { itemA: white, itemB: red, ratio: [1, 1] as [number, number] };
    expect(describeMix({ ...mix, predictedColor: red.color, deltaE00: 0, warnings: [] })).toBe('1 part white : 1 part red');
  });

  it('gives sensible answers on the real seed catalogue', () => {
    const owned = ['citadel:base:mephiston-red', 'citadel:layer:white-scar', 'citadel:base:abaddon-black'];
    const solver = createMatchSolver({ catalog: seed, ownedIds: owned });
    // Evil Sunz Scarlet is a brighter red the user does not own.
    const target = byId('citadel:layer:evil-sunz-scarlet');
    const summary = summarizeMatch(
      solver.solve(target.color, { targetFinish: target.finish, medium: target.medium }),
      'full_catalog',
    );
    expect(summary.owned).toBeDefined();
    expect(summary.toBuy?.item.id).toBe(target.id);
    expect(['mix', 'approximate', 'gap']).toContain(summary.verdict);
  });
});
