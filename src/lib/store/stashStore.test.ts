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

  it('keeps a zero-quantity item listed but never matches or mixes with it', async () => {
    const store = await openSeeded();
    const red = idOf(store, 'mephiston');
    await store.setOwned(red, true, { quantity: 0 });
    expect(store.isOwned(red)).toBe(true);
    expect(store.queryCatalog({ owned: true }).rows.map((row) => row.item.id)).toEqual([red]);
    expect(store.availableIds().has(red)).toBe(false);
    const solver = store.getSolver();
    expect(solver.ownedCount).toBe(0);
    expect(solver.solve(store.getItem(red)!.color).bestOwnedSingle).toBeUndefined();

    await store.setOwned(red, true, { quantity: 1 });
    expect(store.getSolver().ownedCount).toBe(1);
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

  it('tells subscribers when saving fails and when it recovers, and reports why', async () => {
    const adapter = createMemoryAdapter();
    const store = await openSeeded(adapter);
    const red = idOf(store, 'mephiston');
    const original = adapter.putStash.bind(adapter);
    let fail = true;
    adapter.putStash = (entries) => (fail ? Promise.reject(new Error('disk full')) : original(entries));
    const seen: Array<boolean> = [];
    store.subscribe(() => seen.push(store.hasUnpersistedChanges));

    await expect(store.setOwned(red, true)).rejects.toThrow('disk full');
    expect(store.hasUnpersistedChanges).toBe(true);
    expect(store.persistenceError).toBe('disk full');
    // One notification for the edit itself, one for "now unsaved".
    expect(seen.at(-1)).toBe(true);

    fail = false;
    const before = seen.length;
    await store.retryPersistence();
    expect(store.hasUnpersistedChanges).toBe(false);
    expect(store.persistenceError).toBeNull();
    expect(seen.length).toBe(before + 1);
    expect(seen.at(-1)).toBe(false);
  });

  it('keeps two tabs on one database in step', async () => {
    const factory = new IDBFactory();
    const sent: string[][] = [];
    const first = await StashStore.open(await createIndexedDbAdapter({ factory }), {
      onPersisted: (ids) => sent.push(ids),
    });
    await first.importCatalog(seed.items, seed.revision);
    const second = await StashStore.open(await createIndexedDbAdapter({ factory }));
    const red = idOf(first, 'mephiston');

    await first.setOwned(red, true);
    expect(sent).toEqual([[red]]);
    expect(second.isOwned(red)).toBe(false); // not yet told
    expect(await second.refreshFromStorage()).toBe(1);
    expect(second.isOwned(red)).toBe(true);
    expect(second.getSolver().ownedCount).toBe(1);

    // A removal travels the same way, and a refresh with nothing new changes nothing.
    await first.setOwned(red, false);
    await second.refreshFromStorage();
    expect(second.isOwned(red)).toBe(false);
    expect(await second.refreshFromStorage()).toBe(0);

    // Last write wins per item: a newer edit in the second tab is not undone by an older stored copy.
    let clock = 10_000;
    const third = await StashStore.open(await createIndexedDbAdapter({ factory }), { now: () => clock });
    await third.setOwned(red, true, { quantity: 4 });
    clock = 1; // the first tab's clock is behind
    await first.refreshFromStorage();
    expect(first.getStashEntry(red)?.quantity).toBe(4);
    first.close();
    second.close();
    third.close();
  });

  it('keeps ownership through a catalogue update, including renamed items', async () => {
    const factory = new IDBFactory();
    const v1 = [item('brand:line:old-red', '#aa0000'), item('brand:line:blue', '#0000aa')];
    let store = await StashStore.open(await createIndexedDbAdapter({ factory }));
    await store.importCatalog(v1, 1);
    await store.setOwnedMany(['brand:line:old-red', 'brand:line:blue'], true, { quantity: 2 });
    store.close();

    // v2 corrects the blue's colour and renames the red, keeping its old id as a former id.
    const v2 = [
      item('brand:line:new-red', '#ab0000', { formerIds: ['brand:line:old-red'] }),
      item('brand:line:blue', '#0000ab'),
    ];
    store = await StashStore.open(await createIndexedDbAdapter({ factory }));
    expect(store.catalogRevision).toBe(1);
    await store.importCatalog(v2, 2);
    store.close();

    store = await StashStore.open(await createIndexedDbAdapter({ factory }));
    expect(store.catalogRevision).toBe(2);
    expect(store.getItem('brand:line:blue')?.color.hex).toBe('#0000ab');
    expect(store.isOwned('brand:line:blue')).toBe(true);
    expect(store.isOwned('brand:line:new-red')).toBe(true);
    expect(store.getStashEntry('brand:line:new-red')?.quantity).toBe(2);
    expect(store.isOwned('brand:line:old-red')).toBe(false);
    expect(store.getStashEntry('brand:line:old-red')?.deleted).toBe(true);
    store.close();
  });

  it('round-trips a backup without undoing newer edits', async () => {
    let clock = 1000;
    const store = await openSeeded(createMemoryAdapter(), () => clock);
    const red = idOf(store, 'mephiston');
    const oil = idOf(store, 'nuln oil');
    await store.setOwned(red, true, { quantity: 2, note: 'half empty' });
    await store.setOwned(oil, true);
    const backup = JSON.parse(JSON.stringify(store.exportBackup()));

    const fresh = await openSeeded();
    expect(await fresh.restoreBackup(backup)).toBe(2);
    expect(fresh.getStashEntry(red)).toMatchObject({ quantity: 2, note: 'half empty', deleted: false, dirty: true });
    expect(fresh.isOwned(oil)).toBe(true);

    // A later removal survives restoring the older backup.
    clock = 5000;
    await store.setOwned(oil, false);
    await store.restoreBackup(backup);
    expect(store.isOwned(oil)).toBe(false);

    await expect(fresh.restoreBackup({ format: 'something-else', entries: [] })).rejects.toThrow(/not a Color Me Worst/);
    await expect(
      fresh.restoreBackup({ ...backup, entries: [{ itemId: red, quantity: -1, updatedAt: 1, deleted: false }] }),
    ).rejects.toThrow(/malformed/);
  });

  it('moves ownership onto a renamed item when restoring a backup made before the rename', async () => {
    const v1 = [item('brand:line:old', '#aa0000')];
    const v2 = [item('brand:line:new', '#aa0000', { formerIds: ['brand:line:old'] })];
    const before = await StashStore.open(createMemoryAdapter());
    await before.importCatalog(v1, 1);
    await before.setOwned('brand:line:old', true, { quantity: 3 });
    const backup = JSON.parse(JSON.stringify(before.exportBackup()));

    const after = await StashStore.open(createMemoryAdapter());
    await after.importCatalog(v2, 2);
    await after.restoreBackup(backup);
    expect(after.isOwned('brand:line:new')).toBe(true);
    expect(after.getStashEntry('brand:line:new')?.quantity).toBe(3);
    expect(after.isOwned('brand:line:old')).toBe(false);
  });

  it('does not resurrect an item removed after the backup it is restored from', async () => {
    let clock = 100;
    const store = await StashStore.open(createMemoryAdapter(), { now: () => clock });
    await store.importCatalog([item('brand:line:new', '#aa0000', { formerIds: ['brand:line:old'] })], 2);
    clock = 200;
    await store.setOwned('brand:line:new', true);
    clock = 300;
    await store.setOwned('brand:line:new', false); // removed at 300
    clock = 400;
    // An older backup (time 100) still lists the item under its former id.
    await store.restoreBackup({
      format: 'color-me-worst/stash-backup@1',
      exportedAt: new Date(100).toISOString(),
      catalogRevision: 1,
      entries: [{ itemId: 'brand:line:old', quantity: 1, updatedAt: 100, deleted: false }],
    });
    expect(store.isOwned('brand:line:new')).toBe(false);
    expect(store.isOwned('brand:line:old')).toBe(false);

    // A former-id entry newer than the removal does win.
    await store.restoreBackup({
      format: 'color-me-worst/stash-backup@1',
      exportedAt: new Date(500).toISOString(),
      catalogRevision: 1,
      entries: [{ itemId: 'brand:line:old', quantity: 2, updatedAt: 500, deleted: false }],
    });
    expect(store.getStashEntry('brand:line:new')).toMatchObject({ deleted: false, quantity: 2 });
  });

  it('keeps the newest entry when several former ids of one item are owned', async () => {
    const store = await StashStore.open(createMemoryAdapter(), { now: () => 1000 });
    await store.importCatalog([item('brand:line:new', '#aa0000', { formerIds: ['brand:line:old1', 'brand:line:old2'] })], 2);
    await store.restoreBackup({
      format: 'color-me-worst/stash-backup@1',
      exportedAt: new Date(300).toISOString(),
      catalogRevision: 1,
      entries: [
        { itemId: 'brand:line:old1', quantity: 8, note: 'newest', updatedAt: 300, deleted: false },
        { itemId: 'brand:line:old2', quantity: 1, note: 'oldest', updatedAt: 100, deleted: false },
      ],
    });
    expect(store.getStashEntry('brand:line:new')).toMatchObject({ deleted: false, quantity: 8, note: 'newest' });
    expect(store.isOwned('brand:line:old1')).toBe(false);
    expect(store.isOwned('brand:line:old2')).toBe(false);
  });

  it('applies a newer former-id edit to a live current entry, and keeps a newer current one', async () => {
    let clock = 100;
    const store = await StashStore.open(createMemoryAdapter(), { now: () => clock });
    await store.importCatalog([item('brand:line:new', '#aa0000', { formerIds: ['brand:line:old'] })], 2);
    await store.setOwned('brand:line:new', true, { quantity: 1 }); // live at 100
    clock = 1000;
    const backup = (entries: RemoteStashEntry[]) => ({
      format: 'color-me-worst/stash-backup@1',
      exportedAt: new Date(0).toISOString(),
      catalogRevision: 1,
      entries,
    });
    await store.restoreBackup(backup([{ itemId: 'brand:line:old', quantity: 8, updatedAt: 300, deleted: false }]));
    expect(store.getStashEntry('brand:line:new')?.quantity).toBe(8);

    await store.restoreBackup(backup([{ itemId: 'brand:line:old', quantity: 2, updatedAt: 200, deleted: false }]));
    expect(store.getStashEntry('brand:line:new')?.quantity).toBe(8); // older: ignored
  });

  it('lets a later restore supply a newer edit under a former id', async () => {
    const store = await StashStore.open(createMemoryAdapter(), { now: () => 1000 });
    await store.importCatalog([item('brand:line:new', '#aa0000', { formerIds: ['brand:line:old'] })], 2);
    const backup = (quantity: number, updatedAt: number) => ({
      format: 'color-me-worst/stash-backup@1',
      exportedAt: new Date(updatedAt).toISOString(),
      catalogRevision: 1,
      entries: [{ itemId: 'brand:line:old', quantity, updatedAt, deleted: false }],
    });
    await store.restoreBackup(backup(1, 100));
    expect(store.getStashEntry('brand:line:new')?.quantity).toBe(1);
    // Migration ran at clock 1000, but the edit it moved was made at 100: a 300 edit is newer.
    expect(await store.restoreBackup(backup(5, 300))).toBeGreaterThan(0);
    expect(store.getStashEntry('brand:line:new')?.quantity).toBe(5);
    expect(store.isOwned('brand:line:old')).toBe(false);
  });

  it('applies a newer removal recorded under a former id', async () => {
    let clock = 100;
    const store = await StashStore.open(createMemoryAdapter(), { now: () => clock });
    await store.importCatalog([item('brand:line:new', '#aa0000', { formerIds: ['brand:line:old'] })], 2);
    await store.setOwned('brand:line:new', true); // live at 100
    clock = 1000;
    const backup = (entries: RemoteStashEntry[]) => ({
      format: 'color-me-worst/stash-backup@1',
      exportedAt: new Date(0).toISOString(),
      catalogRevision: 1,
      entries,
    });
    // An older-catalogue device removed it at 300.
    await store.restoreBackup(backup([{ itemId: 'brand:line:old', quantity: 1, updatedAt: 300, deleted: true }]));
    expect(store.isOwned('brand:line:new')).toBe(false);

    // A later re-add under the former id wins again; re-running the migration changes nothing more.
    await store.restoreBackup(backup([{ itemId: 'brand:line:old', quantity: 4, updatedAt: 400, deleted: false }]));
    expect(store.getStashEntry('brand:line:new')).toMatchObject({ deleted: false, quantity: 4 });
    // Reopening (which re-runs the migration) must not undo it via the migration's own tombstone.
    await store.restoreBackup(backup([]));
    expect(store.isOwned('brand:line:new')).toBe(true);
  });

  it('applies former-id edits made in a tab still on the older catalogue', async () => {
    const factory = new IDBFactory();
    let clock = 100;
    const now = () => clock;
    const oldTab = await StashStore.open(await createIndexedDbAdapter({ factory }), { now });
    await oldTab.importCatalog([item('brand:line:old', '#aa0000')], 1);
    await oldTab.setOwned('brand:line:old', true); // 100

    const newTab = await StashStore.open(await createIndexedDbAdapter({ factory }), { now });
    await newTab.importCatalog([item('brand:line:new', '#aa0000', { formerIds: ['brand:line:old'] })], 2);
    expect(newTab.isOwned('brand:line:new')).toBe(true);

    clock = 200;
    await oldTab.setOwned('brand:line:old', false); // removed in the old tab at 200
    await newTab.refreshFromStorage();
    expect(newTab.isOwned('brand:line:new')).toBe(false);

    clock = 300;
    await oldTab.setOwned('brand:line:old', true, { quantity: 6 });
    await newTab.refreshFromStorage();
    expect(newTab.getStashEntry('brand:line:new')).toMatchObject({ deleted: false, quantity: 6 });
    oldTab.close();
    newTab.close();
  });

  it('finishes a rename migration on the next start if its save failed', async () => {
    const factory = new IDBFactory();
    let store = await StashStore.open(await createIndexedDbAdapter({ factory }));
    await store.importCatalog([item('brand:line:old', '#aa0000')], 1);
    await store.setOwned('brand:line:old', true);
    store.close();

    const failing = await createIndexedDbAdapter({ factory });
    failing.putStash = () => Promise.reject(new Error('disk full'));
    store = await StashStore.open(failing);
    // The catalogue itself is saved; only the ownership move fails. That must not fail the import.
    await store.importCatalog([item('brand:line:new', '#aa0000', { formerIds: ['brand:line:old'] })], 2);
    expect(store.isOwned('brand:line:new')).toBe(true);
    expect(store.hasUnpersistedChanges).toBe(true);
    store.close();

    // Storage has recovered; the catalogue is already current, so no import runs.
    store = await StashStore.open(await createIndexedDbAdapter({ factory }));
    expect(store.catalogRevision).toBe(2);
    expect(store.isOwned('brand:line:new')).toBe(true);
    expect(store.isOwned('brand:line:old')).toBe(false);
    store.close();
    store = await StashStore.open(await createIndexedDbAdapter({ factory }));
    expect(store.isOwned('brand:line:new')).toBe(true); // and it was written, not just redone in memory
    store.close();
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
