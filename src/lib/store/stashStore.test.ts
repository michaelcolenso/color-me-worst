import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { colorFromHex, rgb8ToHex } from '../color/colorConversions';
import type { CatalogItem, FinishType, MediumType } from '../color/types';
import type { CatalogBundle } from '../catalog/seedBuilder';
import seedBundle from '../../data/catalogSeed.json';
import {
  StashStore,
  createIndexedDbAdapter,
  createMemoryAdapter,
  type RemoteStashEntry,
  type StorageAdapter,
} from './stashStore';

const seed = seedBundle as unknown as CatalogBundle;

/** Deterministic PRNG (mulberry32). */
function createRandom(seedValue: number): () => number {
  let state = seedValue >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

const BRANDS = ['Citadel', 'Vallejo', 'Monument Hobbies', 'DMC', 'Army Painter', 'Anchor', 'Copic', 'Scale75'];
const WORDS = ['Red', 'Blue', 'Green', 'Dark', 'Light', 'Pale', 'Deep', 'Flesh', 'Grey', 'Gold', 'Sky', 'Bone'];

/** A synthetic catalogue shaped like a real one: several brands, lines, media and finishes. */
function syntheticCatalog(size: number): CatalogItem[] {
  const random = createRandom(4242);
  const finishes: FinishType[] = ['matte', 'matte', 'matte', 'satin', 'gloss', 'metallic', 'wash', 'contrast'];
  return Array.from({ length: size }, (_, index) => {
    const brand = BRANDS[index % BRANDS.length] as string;
    const medium: MediumType =
      brand === 'DMC' || brand === 'Anchor' ? 'embroidery_floss' : brand === 'Copic' ? 'alcohol_marker' : 'acrylic_paint';
    const name = `${WORDS[Math.floor(random() * WORDS.length)]} ${WORDS[Math.floor(random() * WORDS.length)]} ${index}`;
    return item(`synthetic-${index}`, rgb8ToHex([random() * 255, random() * 255, random() * 255]), {
      brand,
      line: `Line ${index % 5}`,
      sku: String(1000 + index),
      name,
      medium,
      finish: medium === 'acrylic_paint' ? (finishes[index % finishes.length] as FinishType) : 'matte',
      discontinued: index % 40 === 0,
    });
  });
}

async function openSeeded(adapter: StorageAdapter = createMemoryAdapter(), now?: () => number): Promise<StashStore> {
  const store = await StashStore.open(adapter, now ? { now } : {});
  await store.importCatalog(seed.items, seed.revision);
  return store;
}

const idOf = (store: StashStore, text: string): string => {
  const { rows } = store.queryCatalog({ text, limit: 1 });
  if (rows[0] === undefined) throw new Error(`no seed item matches "${text}"`);
  return rows[0].item.id;
};

describe('StashStore: catalogue', () => {
  it('starts empty and imports the seed bundle', async () => {
    const store = await StashStore.open(createMemoryAdapter());
    expect(store.catalogSize).toBe(0);
    expect(store.catalogRevision).toBe(0);
    expect(store.queryCatalog().total).toBe(0);
    await store.importCatalog(seed.items, seed.revision);
    expect(store.catalogSize).toBe(seed.items.length);
    expect(store.catalogRevision).toBe(1);
    expect(store.brands()).toEqual(['Citadel', 'DMC', 'Monument Hobbies', 'Vallejo']);
    expect(store.lines('Vallejo')).toEqual(['Model Color']);
    expect(store.getItem('citadel:base:mephiston-red')?.name).toBe('Mephiston Red');
    expect(store.getItem('nope')).toBeUndefined();
  });

  it('rejects a catalogue with duplicate ids and keeps the old one', async () => {
    const store = await openSeeded();
    await expect(store.importCatalog([item('a', '#111111'), item('a', '#222222')], 2)).rejects.toThrow(/Duplicate/);
    expect(store.catalogSize).toBe(seed.items.length);
    expect(store.catalogRevision).toBe(1);
  });

  it('returns rows in brand, line, name order with paging', async () => {
    const store = await openSeeded();
    const all = store.queryCatalog({ limit: 1000 });
    expect(all.total).toBe(seed.items.length);
    expect(all.rows).toHaveLength(seed.items.length);
    const keys = all.rows.map((row) => `${row.item.brand}|${row.item.line}|${row.item.name}`);
    expect(keys[0]?.startsWith('Citadel|Base|')).toBe(true);
    const brandOrder = [...new Set(all.rows.map((row) => row.item.brand))];
    expect(brandOrder).toEqual(['Citadel', 'DMC', 'Monument Hobbies', 'Vallejo']);

    const page = store.queryCatalog({ limit: 10, offset: 5 });
    expect(page.total).toBe(seed.items.length);
    expect(page.rows.map((row) => row.item.id)).toEqual(all.rows.slice(5, 15).map((row) => row.item.id));
    expect(store.queryCatalog().rows).toHaveLength(100);
    expect(store.queryCatalog({ limit: 0 }).rows).toEqual([]);
  });

  it('filters by text, brand, line, medium, finish and discontinued', async () => {
    const store = await openSeeded();
    const names = (query: Parameters<StashStore['queryCatalog']>[0]) =>
      store.queryCatalog({ ...query, limit: 1000 }).rows.map((row) => row.item.name);

    expect(names({ text: 'mephiston' })).toEqual(['Mephiston Red']);
    expect(names({ text: 'RED citadel base' }).sort()).toEqual(['Khorne Red', 'Mephiston Red']);
    expect(names({ text: '70.950' })).toEqual(['Black']);
    expect(names({ text: 'zzz-no-match' })).toEqual([]);
    expect(names({ text: '   ' })).toHaveLength(seed.items.length);

    expect(names({ brand: 'DMC' })).toHaveLength(23);
    expect(names({ brand: ['DMC', 'Vallejo'] })).toHaveLength(48);
    expect(names({ brand: 'Citadel', line: 'Shade' }).sort()).toEqual([
      'Agrax Earthshade',
      'Druchii Violet',
      'Nuln Oil',
      'Reikland Fleshshade',
    ]);
    expect(names({ medium: 'embroidery_floss' })).toHaveLength(23);
    expect(names({ medium: ['embroidery_floss', 'oil_paint'] })).toHaveLength(23);
    expect(names({ finish: 'fluorescent' })).toEqual(['Yellow Fluorescent']);
    expect(names({ finishClass: 'transparent' })).toHaveLength(10);
    expect(names({ finishClass: 'metallic', brand: 'Citadel' })).toHaveLength(6);

    expect(names({ brand: 'Citadel' })).toHaveLength(40);
    expect(names({ brand: 'Citadel', includeDiscontinued: false })).toHaveLength(38);
  });

  it('ranks by colour distance and applies a maximum distance', async () => {
    const store = await openSeeded();
    const target = colorFromHex('#960c09').lab; // Mephiston Red's seed colour
    const ranked = store.queryCatalog({ near: { lab: target }, sort: 'deltaE', limit: 5 });
    expect(ranked.rows[0]?.item.name).toBe('Mephiston Red');
    // Not exactly 0: the bundle stores coordinates rounded to six decimals.
    expect(ranked.rows[0]?.deltaE00 as number).toBeLessThan(1e-4);
    const distances = ranked.rows.map((row) => row.deltaE00 as number);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));

    const close = store.queryCatalog({ near: { lab: target, maxDeltaE: 5 }, limit: 1000 });
    expect(close.total).toBeGreaterThan(0);
    expect(close.total).toBeLessThan(seed.items.length);
    expect(close.rows.every((row) => (row.deltaE00 as number) <= 5)).toBe(true);

    expect(store.queryCatalog({ brand: 'DMC' }).rows[0]?.deltaE00).toBeUndefined();
    expect(() => store.queryCatalog({ sort: 'deltaE' })).toThrow(RangeError);
  });
});

describe('StashStore: stash', () => {
  it('adds, updates and removes items, leaving a tombstone', async () => {
    let clock = 1000;
    const store = await openSeeded(createMemoryAdapter(), () => clock);
    const red = idOf(store, 'mephiston');

    expect(store.isOwned(red)).toBe(false);
    await store.setOwned(red, true, { quantity: 2, note: 'half empty' });
    expect(store.isOwned(red)).toBe(true);
    expect(store.ownedCount).toBe(1);
    expect(store.getStashEntry(red)).toEqual({
      itemId: red,
      quantity: 2,
      note: 'half empty',
      updatedAt: 1000,
      deleted: false,
      dirty: true,
    });

    clock = 2000;
    await store.setOwned(red, true);
    expect(store.getStashEntry(red)?.quantity).toBe(2); // unchanged when not specified
    expect(store.getStashEntry(red)?.note).toBe('half empty');
    expect(store.getStashEntry(red)?.updatedAt).toBe(2000);

    clock = 3000;
    await store.setOwned(red, false);
    expect(store.isOwned(red)).toBe(false);
    expect(store.ownedCount).toBe(0);
    expect(store.getStashEntry(red)).toMatchObject({ deleted: true, dirty: true, updatedAt: 3000 });

    await store.setOwned('never-owned', false); // removing something not owned is a no-op
    expect(store.getStashEntry('never-owned')).toBeUndefined();
  });

  it('rejects unknown items and invalid quantities', async () => {
    const store = await openSeeded();
    await expect(store.setOwned('missing:item:1', true)).rejects.toThrow(RangeError);
    const red = idOf(store, 'mephiston');
    await expect(store.setOwned(red, true, { quantity: -1 })).rejects.toThrow(RangeError);
    await expect(store.setOwned(red, true, { quantity: 1.5 })).rejects.toThrow(RangeError);
    expect(store.ownedCount).toBe(0);
  });

  it('reflects ownership in queries', async () => {
    const store = await openSeeded();
    const ids = [idOf(store, 'mephiston'), idOf(store, 'nuln oil'), idOf(store, 'DMC 310')];
    await store.setOwnedMany(ids, true);
    expect(store.ownedIds()).toEqual(new Set(ids));
    const owned = store.queryCatalog({ owned: true });
    expect(owned.total).toBe(3);
    expect(owned.rows.every((row) => row.owned)).toBe(true);
    expect(store.queryCatalog({ owned: false }).total).toBe(seed.items.length - 3);
    expect(store.queryCatalog({ owned: true, brand: 'DMC' }).rows.map((row) => row.item.sku)).toEqual(['310']);
  });

  it('never moves a timestamp backwards when the clock does', async () => {
    let clock = 5000;
    const store = await openSeeded(createMemoryAdapter(), () => clock);
    const red = idOf(store, 'mephiston');
    await store.setOwned(red, true);
    clock = 100; // device clock corrected backwards
    await store.setOwned(red, false);
    expect(store.getStashEntry(red)?.updatedAt).toBe(5001);
  });

  it('notifies subscribers and bumps the version on every change', async () => {
    const store = await openSeeded();
    const red = idOf(store, 'mephiston');
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    const before = store.version;
    await store.setOwned(red, true);
    expect(calls).toBe(1);
    expect(store.version).toBe(before + 1);
    await store.importCatalog(seed.items, 2);
    expect(calls).toBe(2);
    unsubscribe();
    await store.setOwned(red, false);
    expect(calls).toBe(2);
  });
});

describe('StashStore: sync bookkeeping', () => {
  it('tracks pending changes until the server confirms that exact version', async () => {
    let clock = 1000;
    const store = await openSeeded(createMemoryAdapter(), () => clock);
    const red = idOf(store, 'mephiston');
    const oil = idOf(store, 'nuln oil');
    await store.setOwnedMany([red, oil], true);

    const sent = store.pendingChanges();
    expect(sent.map((entry) => entry.itemId).sort()).toEqual([oil, red].sort());
    expect(sent.every((entry) => !('dirty' in entry))).toBe(true);

    clock = 2000;
    await store.setOwned(oil, false); // edited again while the upload was in flight
    await store.markSynced(sent);

    const stillPending = store.pendingChanges();
    expect(stillPending.map((entry) => entry.itemId)).toEqual([oil]);
    expect(stillPending[0]).toMatchObject({ deleted: true, updatedAt: 2000 });
    expect(store.getStashEntry(red)?.dirty).toBe(false);
  });

  it('merges remote entries last-write-wins, with the server winning ties', async () => {
    let clock = 1000;
    const store = await openSeeded(createMemoryAdapter(), () => clock);
    const red = idOf(store, 'mephiston');
    const oil = idOf(store, 'nuln oil');
    const bone = idOf(store, 'ushabti');
    await store.setOwnedMany([red, oil], true);

    const remote: RemoteStashEntry[] = [
      { itemId: red, quantity: 1, updatedAt: 500, deleted: true }, // older: ignored
      { itemId: oil, quantity: 4, updatedAt: 1000, deleted: false }, // tie: server wins
      { itemId: bone, quantity: 1, updatedAt: 900, deleted: false }, // new from another device
    ];
    expect(await store.applyRemote(remote)).toBe(2);
    expect(store.isOwned(red)).toBe(true);
    expect(store.getStashEntry(red)?.dirty).toBe(true);
    expect(store.getStashEntry(oil)).toMatchObject({ quantity: 4, dirty: false });
    expect(store.isOwned(bone)).toBe(true);
    expect(store.pendingChanges().map((entry) => entry.itemId)).toEqual([red]);

    // Applying the same download again changes nothing.
    expect(await store.applyRemote(remote)).toBe(0);

    // A newer remote deletion removes the item locally.
    clock = 3000;
    expect(await store.applyRemote([{ itemId: bone, quantity: 1, updatedAt: 2500, deleted: true }])).toBe(1);
    expect(store.isOwned(bone)).toBe(false);
    expect(store.queryCatalog({ owned: true }).rows.some((row) => row.item.id === bone)).toBe(false);
  });

  it('resolves several versions of one item in a single download to the newest', async () => {
    const store = await openSeeded();
    const red = idOf(store, 'mephiston');
    const changed = await store.applyRemote([
      { itemId: red, quantity: 2, updatedAt: 5000, deleted: false },
      { itemId: red, quantity: 1, updatedAt: 4000, deleted: true }, // older, listed later
    ]);
    expect(changed).toBe(1);
    expect(store.isOwned(red)).toBe(true);
    expect(store.getStashEntry(red)).toMatchObject({ quantity: 2, updatedAt: 5000, deleted: false, dirty: false });

    const oil = idOf(store, 'nuln oil');
    await store.applyRemote([
      { itemId: oil, quantity: 1, updatedAt: 4000, deleted: false },
      { itemId: oil, quantity: 1, updatedAt: 5000, deleted: true }, // newer, listed later
    ]);
    expect(store.isOwned(oil)).toBe(false);
    expect(store.getStashEntry(oil)?.updatedAt).toBe(5000);
  });

  it('keeps stash entries for items missing from a newer catalogue', async () => {
    const store = await openSeeded();
    const red = idOf(store, 'mephiston');
    await store.setOwned(red, true);
    await store.importCatalog(seed.items.filter((entry) => entry.id !== red), 2);
    expect(store.getItem(red)).toBeUndefined();
    expect(store.isOwned(red)).toBe(true);
    expect(store.queryCatalog({ owned: true }).total).toBe(0);
    await store.importCatalog(seed.items, 3);
    expect(store.queryCatalog({ owned: true }).rows.map((row) => row.item.id)).toEqual([red]);
  });
});

describe('StashStore: matching', () => {
  it('provides a solver over the current stash and rebuilds it when the stash changes', async () => {
    const store = await openSeeded();
    const first = store.getSolver();
    expect(store.getSolver()).toBe(first);
    expect(first.ownedCount).toBe(0);

    const red = idOf(store, 'mephiston');
    await store.setOwned(red, true);
    const second = store.getSolver();
    expect(second).not.toBe(first);
    expect(second.ownedCount).toBe(1);

    const solved = second.solve('#960c09', { mode: 'strict_stash' });
    expect(solved.bestSingleMatches[0]?.item.id).toBe(red);
    expect(solved.coverage).toBe('owned_single');
  });

  it('does not offer a seed metallic for a matte target of the same colour', async () => {
    const store = await openSeeded();
    const gold = store.getItem('citadel:base:retributor-armour') as CatalogItem;
    expect(gold.finish).toBe('metallic');
    const matte = store.getSolver().solve(gold.color.hex);
    expect(matte.bestSingleMatches.every((match) => match.item.finish !== 'metallic')).toBe(true);
    const metallic = store.getSolver().solve(gold.color.hex, { targetFinish: 'metallic' });
    expect(metallic.bestSingleMatches[0]?.item.id).toBe(gold.id);
  });
});

describe('StashStore: persistence', () => {
  it('survives a reload on IndexedDB', async () => {
    const factory = new IDBFactory();
    const first = await StashStore.open(await createIndexedDbAdapter({ factory, name: 'reload-test' }), {
      now: () => 1234,
    });
    await first.importCatalog(seed.items, seed.revision);
    const red = idOf(first, 'mephiston');
    const oil = idOf(first, 'nuln oil');
    await first.setOwned(red, true, { quantity: 3, note: 'new pot' });
    await first.setOwned(oil, true);
    await first.setOwned(oil, false);
    await first.markSynced([{ itemId: red, updatedAt: 1234 }]);
    first.close();

    const second = await StashStore.open(await createIndexedDbAdapter({ factory, name: 'reload-test' }));
    expect(second.catalogSize).toBe(seed.items.length);
    expect(second.catalogRevision).toBe(seed.revision);
    expect(second.getItem(red)).toEqual(first.getItem(red));
    expect(second.getStashEntry(red)).toEqual({
      itemId: red,
      quantity: 3,
      note: 'new pot',
      updatedAt: 1234,
      deleted: false,
      dirty: false,
    });
    expect(second.isOwned(oil)).toBe(false);
    expect(second.getStashEntry(oil)?.deleted).toBe(true);
    expect(second.queryCatalog({ owned: true }).rows.map((row) => row.item.id)).toEqual([red]);
    expect(second.pendingChanges().map((entry) => entry.itemId)).toEqual([oil]);
    second.close();
  });

  it('persists changes in the order they were made, even when a subscriber edits the stash', async () => {
    const factory = new IDBFactory();
    let clock = 1000;
    const first = await StashStore.open(await createIndexedDbAdapter({ factory, name: 'reentrant' }), {
      now: () => clock,
    });
    await first.importCatalog(seed.items, seed.revision);
    const red = idOf(first, 'mephiston');

    // A subscriber that immediately removes the item that was just added.
    let reacted = false;
    let nested: Promise<void> | undefined;
    first.subscribe(() => {
      if (reacted || !first.isOwned(red)) return;
      reacted = true;
      nested = first.setOwned(red, false);
    });
    await first.setOwned(red, true);
    await nested;
    expect(first.isOwned(red)).toBe(false);
    first.close();

    const second = await StashStore.open(await createIndexedDbAdapter({ factory, name: 'reentrant' }));
    expect(second.isOwned(red)).toBe(false);
    expect(second.getStashEntry(red)).toMatchObject({ deleted: true, updatedAt: 1001 });
    second.close();

    // Un-awaited back-to-back edits land in call order too.
    clock = 2000;
    const third = await StashStore.open(await createIndexedDbAdapter({ factory, name: 'reentrant' }), {
      now: () => clock,
    });
    const writes = [third.setOwned(red, true), third.setOwned(red, false), third.setOwned(red, true, { quantity: 4 })];
    await Promise.all(writes);
    third.close();
    const fourth = await StashStore.open(await createIndexedDbAdapter({ factory, name: 'reentrant' }));
    expect(fourth.getStashEntry(red)).toMatchObject({ deleted: false, quantity: 4 });
    fourth.close();
  });

  it('keeps accepting writes after one fails', async () => {
    const adapter = createMemoryAdapter();
    const store = await openSeeded(adapter);
    const red = idOf(store, 'mephiston');
    const original = adapter.putStash.bind(adapter);
    let fail = true;
    adapter.putStash = (entries) => (fail ? Promise.reject(new Error('disk full')) : original(entries));
    await expect(store.setOwned(red, true)).rejects.toThrow('disk full');
    fail = false;
    await store.setOwned(red, true, { quantity: 2 });
    expect((await adapter.loadStash()).find((entry) => entry.itemId === red)?.quantity).toBe(2);
  });

  it('makes a downloaded entry durable when the download is retried after a failed write', async () => {
    const adapter = createMemoryAdapter();
    const store = await openSeeded(adapter);
    const red = idOf(store, 'mephiston');
    const oil = idOf(store, 'nuln oil');
    const original = adapter.putStash.bind(adapter);
    let fail = true;
    adapter.putStash = (entries) => (fail ? Promise.reject(new Error('disk full')) : original(entries));
    const download: RemoteStashEntry[] = [{ itemId: red, quantity: 2, updatedAt: 5000, deleted: false }];

    await expect(store.applyRemote(download)).rejects.toThrow('disk full');
    expect(store.hasUnpersistedChanges).toBe(true);
    expect(await adapter.loadStash()).toEqual([]);

    fail = false;
    await store.applyRemote(download);
    expect(store.hasUnpersistedChanges).toBe(false);
    expect(await adapter.loadStash()).toEqual([
      { itemId: red, quantity: 2, updatedAt: 5000, deleted: false, dirty: false },
    ]);

    // A failed local edit is carried along by the next successful write of anything.
    fail = true;
    await expect(store.setOwned(oil, true)).rejects.toThrow('disk full');
    fail = false;
    await store.setOwned(red, true, { quantity: 3 });
    const stored = await adapter.loadStash();
    expect(stored.find((entry) => entry.itemId === oil)).toMatchObject({ deleted: false, dirty: true });
    expect(stored.find((entry) => entry.itemId === red)?.quantity).toBe(3);

    // And can be retried explicitly.
    fail = true;
    await expect(store.setOwned(oil, false)).rejects.toThrow('disk full');
    fail = false;
    await store.retryPersistence();
    expect(store.hasUnpersistedChanges).toBe(false);
    expect((await adapter.loadStash()).find((entry) => entry.itemId === oil)?.deleted).toBe(true);
  });

  it('replaces the stored catalogue atomically and keeps databases separate', async () => {
    const factory = new IDBFactory();
    const adapter = await createIndexedDbAdapter({ factory, name: 'a' });
    await adapter.replaceCatalog(seed.items, 1);
    await adapter.replaceCatalog([item('only', '#abcdef')], 7);
    expect((await adapter.loadCatalog()).map((entry) => entry.id)).toEqual(['only']);
    expect(await adapter.loadCatalogRevision()).toBe(7);
    adapter.close();

    const other = await createIndexedDbAdapter({ factory, name: 'b' });
    expect(await other.loadCatalog()).toEqual([]);
    expect(await other.loadCatalogRevision()).toBe(0);
    expect(await other.loadStash()).toEqual([]);
    other.close();
  });

  it('reports a clear error when IndexedDB is unavailable', async () => {
    await expect(createIndexedDbAdapter()).rejects.toThrow(/not available/);
  });
});

describe('StashStore: performance', () => {
  it('filters a 6,000-item catalogue in under 15 ms', async () => {
    const catalog = syntheticCatalog(6000);
    const store = await StashStore.open(createMemoryAdapter());
    await store.importCatalog(catalog, 1);
    await store.setOwnedMany(
      catalog.filter((_, index) => index % 20 === 0).map((entry) => entry.id),
      true,
    );
    const target = colorFromHex('#7a8f5c').lab;

    const queries: Array<[string, Parameters<StashStore['queryCatalog']>[0]]> = [
      ['no filter', {}],
      ['text, two words', { text: 'dark red' }],
      ['brand + medium + finish', { brand: 'Citadel', medium: 'acrylic_paint', finish: 'matte' }],
      ['owned only', { owned: true }],
      ['text + owned + not discontinued', { text: 'grey', owned: true, includeDiscontinued: false }],
      ['nearest colours, whole catalogue', { near: { lab: target }, sort: 'deltaE', limit: 20 }],
      ['within 10 dE, paints only', { near: { lab: target, maxDeltaE: 10 }, finishClass: 'solid', sort: 'deltaE' }],
    ];

    for (const [label, query] of queries) {
      for (let warm = 0; warm < 5; warm++) store.queryCatalog(query);
      const timings: number[] = [];
      for (let run = 0; run < 25; run++) {
        const start = performance.now();
        store.queryCatalog(query);
        timings.push(performance.now() - start);
      }
      timings.sort((a, b) => a - b);
      const median = timings[12] as number;
      console.info(`${label}: median ${median.toFixed(2)} ms, worst ${(timings[24] as number).toFixed(2)} ms`);
      expect(median).toBeLessThan(15);
    }
    expect(store.queryCatalog({ text: 'dark red' }).total).toBeGreaterThan(0);
  });
});
