/**
 * Local-first catalogue and stash store.
 *
 * DESIGN
 * IndexedDB is the durable copy; an in-memory index is what queries read.
 * Reading thousands of rows out of IndexedDB takes tens of milliseconds, so
 * the store loads everything once at start-up and afterwards answers every
 * query from flat arrays with no I/O. Writes update memory first, so the UI is
 * instant, and are then persisted.
 *
 * SYNC
 * The store never talks to a server itself. Each stash entry carries a
 * timestamp, a tombstone flag and a `dirty` flag, which is everything a sync
 * layer needs:
 *   pendingChanges()  -> entries to upload
 *   markSynced()      -> the server accepted them
 *   applyRemote()     -> merge entries downloaded from the server
 * Conflicts resolve last-write-wins per item.
 *
 * No runtime dependencies. Storage is behind {@link StorageAdapter}, so the
 * same store runs on IndexedDB in the browser and on memory in tests.
 */

import { deltaE2000Components } from '../color/deltaE2000';
import { createMatchSolver, type MatchSolver } from '../color/matchSolver';
import { finishClassOf, type FinishClass, type PigmentOverrides } from '../color/pigmentMixer';
import type { CatalogItem, FinishType, MediumType, ReadonlyVec3 } from '../color/types';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One item in the user's inventory, as stored and synced. */
export interface StashEntry {
  itemId: string;
  /** Units owned. Zero is allowed ("ran out, keep it on my list"). */
  quantity: number;
  note?: string;
  /** Milliseconds since the Unix epoch when this entry last changed. */
  updatedAt: number;
  /** Tombstone: the user removed the item. Kept so the removal can sync. */
  deleted: boolean;
  /** True until a sync layer confirms the server has this version. */
  dirty: boolean;
}

/** A stash entry as exchanged with a server: everything except the local `dirty` flag. */
export type RemoteStashEntry = Omit<StashEntry, 'dirty'>;

// ---------------------------------------------------------------------------
// Storage adapters
// ---------------------------------------------------------------------------

/** Durable storage behind the store. All methods resolve once the data is safely written. */
export interface StorageAdapter {
  loadCatalog(): Promise<CatalogItem[]>;
  /** Replace the whole catalogue atomically and record its revision. */
  replaceCatalog(items: readonly CatalogItem[], revision: number): Promise<void>;
  loadCatalogRevision(): Promise<number>;
  loadStash(): Promise<StashEntry[]>;
  /** Insert or overwrite the given entries atomically. */
  putStash(entries: readonly StashEntry[]): Promise<void>;
  close(): void;
}

/** Volatile adapter for tests, server rendering and private-browsing fallbacks. */
export function createMemoryAdapter(): StorageAdapter {
  let catalog: CatalogItem[] = [];
  let revision = 0;
  const stash = new Map<string, StashEntry>();
  return {
    loadCatalog: () => Promise.resolve(catalog.slice()),
    replaceCatalog(items, nextRevision) {
      catalog = items.slice();
      revision = nextRevision;
      return Promise.resolve();
    },
    loadCatalogRevision: () => Promise.resolve(revision),
    loadStash: () => Promise.resolve([...stash.values()].map((entry) => ({ ...entry }))),
    putStash(entries) {
      for (const entry of entries) stash.set(entry.itemId, { ...entry });
      return Promise.resolve();
    },
    close() {},
  };
}

const DB_VERSION = 1;
const CATALOG_STORE = 'catalog';
const STASH_STORE = 'stash';
const META_STORE = 'meta';
const REVISION_KEY = 'catalogRevision';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export interface IndexedDbAdapterOptions {
  /** Database name. Default `color-me-worst`. */
  name?: string;
  /** IndexedDB implementation. Default `globalThis.indexedDB`. */
  factory?: IDBFactory;
}

/**
 * IndexedDB-backed adapter.
 * @throws {Error} when IndexedDB is unavailable (some private-browsing modes);
 *   callers can fall back to {@link createMemoryAdapter}.
 */
export async function createIndexedDbAdapter(options: IndexedDbAdapterOptions = {}): Promise<StorageAdapter> {
  const factory = options.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (factory === undefined) throw new Error('IndexedDB is not available in this environment');

  const open = factory.open(options.name ?? 'color-me-worst', DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(CATALOG_STORE)) db.createObjectStore(CATALOG_STORE, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STASH_STORE)) db.createObjectStore(STASH_STORE, { keyPath: 'itemId' });
    if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
  };
  const db = await requestToPromise(open);
  // Another tab upgrading the schema must not be blocked by this connection.
  db.onversionchange = () => db.close();

  return {
    loadCatalog() {
      return requestToPromise(
        db.transaction(CATALOG_STORE, 'readonly').objectStore(CATALOG_STORE).getAll() as IDBRequest<CatalogItem[]>,
      );
    },
    async replaceCatalog(items, revision) {
      const transaction = db.transaction([CATALOG_STORE, META_STORE], 'readwrite');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(CATALOG_STORE);
      store.clear();
      for (const item of items) store.put(item);
      transaction.objectStore(META_STORE).put(revision, REVISION_KEY);
      await done;
    },
    async loadCatalogRevision() {
      const value: unknown = await requestToPromise(
        db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(REVISION_KEY),
      );
      return typeof value === 'number' ? value : 0;
    },
    loadStash() {
      return requestToPromise(
        db.transaction(STASH_STORE, 'readonly').objectStore(STASH_STORE).getAll() as IDBRequest<StashEntry[]>,
      );
    },
    async putStash(entries) {
      if (entries.length === 0) return;
      const transaction = db.transaction(STASH_STORE, 'readwrite');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(STASH_STORE);
      for (const entry of entries) store.put(entry);
      await done;
    },
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface CatalogQuery {
  /**
   * Free text. Split on whitespace; every word must appear somewhere in the
   * brand, line, SKU or name. Case- and accent-insensitive.
   */
  text?: string;
  /** Exact brand name(s). */
  brand?: string | readonly string[];
  /** Exact line name. */
  line?: string;
  medium?: MediumType | readonly MediumType[];
  finish?: FinishType | readonly FinishType[];
  finishClass?: FinishClass;
  /** `true`: only owned items. `false`: only items not owned. Omit for both. */
  owned?: boolean;
  /** Include discontinued items. Default true (this is a browse, not a recommendation). */
  includeDiscontinued?: boolean;
  /** Keep only items within `maxDeltaE` (CIEDE2000) of a colour, and report each distance. */
  near?: { lab: ReadonlyVec3; maxDeltaE?: number };
  /**
   * `name` (default): brand, then line, then name.
   * `deltaE`: closest first; requires `near`.
   */
  sort?: 'name' | 'deltaE';
  /** Maximum rows to return. Default 100. */
  limit?: number;
  /** Rows to skip, for paging. Default 0. */
  offset?: number;
}

export interface CatalogQueryRow {
  item: CatalogItem;
  owned: boolean;
  /** Present only when the query used `near`. */
  deltaE00?: number;
}

export interface CatalogQueryResult {
  /** The requested page. */
  rows: CatalogQueryRow[];
  /** Number of items matching the filters, before `limit` and `offset`. */
  total: number;
}

function normaliseText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function toSet<T>(value: T | readonly T[] | undefined): ReadonlySet<T> | undefined {
  if (value === undefined) return undefined;
  return new Set(Array.isArray(value) ? (value as readonly T[]) : [value as T]);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StashStoreOptions {
  /** Clock used to stamp changes. Default `Date.now`. Injectable for tests. */
  now?: () => number;
  /** Measured spectra and tint strengths passed through to the match solver. */
  overrides?: PigmentOverrides;
}

export interface SetOwnedOptions {
  quantity?: number;
  note?: string;
}

export class StashStore {
  /** Catalogue sorted by brand, line, name: the default display order. */
  private catalog: CatalogItem[] = [];
  private indexById = new Map<string, number>();
  /** Normalised "brand line sku name" per item, for text search. */
  private searchText: string[] = [];
  private lab = new Float64Array(0);
  private ownedFlags = new Uint8Array(0);
  private catalogRevisionValue = 0;
  private readonly stash = new Map<string, StashEntry>();
  private readonly listeners = new Set<() => void>();
  private solver: MatchSolver | undefined;
  private versionValue = 0;
  /** Tail of the storage write queue; see {@link StashStore.enqueueWrite}. */
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly adapter: StorageAdapter,
    private readonly now: () => number,
    private readonly overrides: PigmentOverrides | undefined,
  ) {}

  /** Open a store: loads the catalogue and stash from the adapter into memory. */
  static async open(adapter: StorageAdapter, options: StashStoreOptions = {}): Promise<StashStore> {
    const store = new StashStore(adapter, options.now ?? Date.now, options.overrides);
    const [catalog, revision, stash] = await Promise.all([
      adapter.loadCatalog(),
      adapter.loadCatalogRevision(),
      adapter.loadStash(),
    ]);
    for (const entry of stash) store.stash.set(entry.itemId, entry);
    store.indexCatalog(catalog, revision);
    return store;
  }

  // -- catalogue ------------------------------------------------------------

  /** Number of catalogue items held. */
  get catalogSize(): number {
    return this.catalog.length;
  }

  /** Revision of the catalogue held, or 0 when none has been imported. */
  get catalogRevision(): number {
    return this.catalogRevisionValue;
  }

  /**
   * Increases on every change to the catalogue or stash. Suitable as the
   * snapshot for React's `useSyncExternalStore`.
   */
  get version(): number {
    return this.versionValue;
  }

  /**
   * Replace the catalogue, e.g. from the bundled seed or a server download.
   * Stash entries are kept, including ones whose item is no longer listed, so
   * nothing the user recorded is lost if an item is temporarily missing.
   * @throws {Error} when two items share an id.
   */
  async importCatalog(items: readonly CatalogItem[], revision: number): Promise<void> {
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id)) throw new Error(`Duplicate catalogue id "${item.id}"`);
      ids.add(item.id);
    }
    await this.enqueueWrite(() => this.adapter.replaceCatalog(items, revision));
    this.indexCatalog(items, revision);
    this.changed();
  }

  getItem(id: string): CatalogItem | undefined {
    const index = this.indexById.get(id);
    return index === undefined ? undefined : this.catalog[index];
  }

  /** Distinct brand names, alphabetical. */
  brands(): string[] {
    return [...new Set(this.catalog.map((item) => item.brand))].sort((a, b) => a.localeCompare(b));
  }

  /** Distinct line names, optionally within one brand, alphabetical. */
  lines(brand?: string): string[] {
    const lines = new Set<string>();
    for (const item of this.catalog) if (brand === undefined || item.brand === brand) lines.add(item.line);
    return [...lines].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Filter the catalogue. Runs entirely in memory: a linear scan over
   * pre-normalised fields, so it stays in the low milliseconds for
   * catalogues of several thousand items.
   * @throws {RangeError} when `sort` is `deltaE` without `near`.
   */
  queryCatalog(query: CatalogQuery = {}): CatalogQueryResult {
    if (query.sort === 'deltaE' && query.near === undefined) {
      throw new RangeError('sort "deltaE" requires a "near" colour');
    }
    const words = query.text === undefined ? [] : normaliseText(query.text).split(/\s+/).filter(Boolean);
    const brands = toSet(query.brand);
    const media = toSet(query.medium);
    const finishes = toSet(query.finish);
    const includeDiscontinued = query.includeDiscontinued !== false;
    const near = query.near;
    const maxDeltaE = near?.maxDeltaE ?? Number.POSITIVE_INFINITY;
    const limit = Math.max(0, Math.floor(query.limit ?? 100));
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const sortByDistance = query.sort === 'deltaE';

    const matches: number[] = [];
    const distances: number[] = [];
    const count = this.catalog.length;
    scan: for (let index = 0; index < count; index++) {
      const item = this.catalog[index] as CatalogItem;
      const isOwned = this.ownedFlags[index] === 1;
      if (query.owned !== undefined && query.owned !== isOwned) continue;
      if (!includeDiscontinued && item.discontinued) continue;
      if (brands !== undefined && !brands.has(item.brand)) continue;
      if (query.line !== undefined && item.line !== query.line) continue;
      if (media !== undefined && !media.has(item.medium)) continue;
      if (finishes !== undefined && !finishes.has(item.finish)) continue;
      if (query.finishClass !== undefined && finishClassOf(item.finish) !== query.finishClass) continue;
      if (words.length > 0) {
        const haystack = this.searchText[index] as string;
        for (const word of words) if (!haystack.includes(word)) continue scan;
      }
      if (near !== undefined) {
        const distance = deltaE2000Components(
          near.lab[0],
          near.lab[1],
          near.lab[2],
          this.lab[index * 3] as number,
          this.lab[index * 3 + 1] as number,
          this.lab[index * 3 + 2] as number,
        );
        if (distance > maxDeltaE) continue;
        distances.push(distance);
      }
      matches.push(index);
    }

    let order = matches.map((_, position) => position);
    if (sortByDistance) {
      order.sort((p, q) => (distances[p] as number) - (distances[q] as number) || p - q);
    }
    order = order.slice(offset, offset + limit);

    const rows = order.map((position): CatalogQueryRow => {
      const index = matches[position] as number;
      const row: CatalogQueryRow = {
        item: this.catalog[index] as CatalogItem,
        owned: this.ownedFlags[index] === 1,
      };
      if (near !== undefined) row.deltaE00 = distances[position] as number;
      return row;
    });
    return { rows, total: matches.length };
  }

  // -- stash ----------------------------------------------------------------

  isOwned(itemId: string): boolean {
    const entry = this.stash.get(itemId);
    return entry !== undefined && !entry.deleted;
  }

  /** Ids of every item the user currently owns, including ones missing from the catalogue. */
  ownedIds(): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.stash.values()) if (!entry.deleted) ids.add(entry.itemId);
    return ids;
  }

  /** Number of items the user currently owns. */
  get ownedCount(): number {
    let count = 0;
    for (const entry of this.stash.values()) if (!entry.deleted) count += 1;
    return count;
  }

  getStashEntry(itemId: string): StashEntry | undefined {
    const entry = this.stash.get(itemId);
    return entry === undefined ? undefined : { ...entry };
  }

  /**
   * Add an item to the stash or remove it. Removing keeps a tombstone so the
   * removal reaches the user's other devices.
   * @throws {RangeError} when adding an id that is not in the catalogue, or a negative quantity.
   */
  async setOwned(itemId: string, owned: boolean, options: SetOwnedOptions = {}): Promise<void> {
    await this.setOwnedMany([itemId], owned, options);
  }

  /** Bulk form of {@link setOwned}: one storage transaction, one change notification. */
  async setOwnedMany(itemIds: readonly string[], owned: boolean, options: SetOwnedOptions = {}): Promise<void> {
    const quantity = options.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new RangeError('quantity must be a non-negative whole number');
    }
    const timestamp = this.now();
    const changed: StashEntry[] = [];
    for (const itemId of new Set(itemIds)) {
      const existing = this.stash.get(itemId);
      if (owned) {
        if (!this.indexById.has(itemId)) throw new RangeError(`Unknown catalogue item "${itemId}"`);
        const note = options.note ?? existing?.note;
        changed.push({
          itemId,
          quantity: options.quantity ?? (existing !== undefined && !existing.deleted ? existing.quantity : 1),
          ...(note !== undefined ? { note } : {}),
          updatedAt: this.stamp(timestamp, existing),
          deleted: false,
          dirty: true,
        });
      } else if (existing !== undefined && !existing.deleted) {
        changed.push({ ...existing, updatedAt: this.stamp(timestamp, existing), deleted: true, dirty: true });
      }
    }
    await this.commit(changed);
  }

  // -- sync -----------------------------------------------------------------

  /** Entries changed locally that a server has not yet confirmed. */
  pendingChanges(): RemoteStashEntry[] {
    const pending: RemoteStashEntry[] = [];
    for (const entry of this.stash.values()) {
      if (!entry.dirty) continue;
      const { dirty: _dirty, ...remote } = entry;
      pending.push(remote);
    }
    return pending;
  }

  /**
   * Record that the server accepted these versions. An entry edited again
   * since it was sent has a newer timestamp and stays pending.
   */
  async markSynced(sent: readonly Pick<StashEntry, 'itemId' | 'updatedAt'>[]): Promise<void> {
    const cleared: StashEntry[] = [];
    for (const { itemId, updatedAt } of sent) {
      const entry = this.stash.get(itemId);
      if (entry !== undefined && entry.dirty && entry.updatedAt === updatedAt) {
        cleared.push({ ...entry, dirty: false });
      }
    }
    await this.commit(cleared, false);
  }

  /**
   * Merge entries downloaded from the server. Per item the newer timestamp
   * wins; on an exact tie the server's copy wins, so every device converges
   * on the same answer.
   * @returns how many local entries changed.
   */
  async applyRemote(remote: readonly RemoteStashEntry[]): Promise<number> {
    // Keyed by item so a batch holding several versions of one item resolves
    // to the newest of them, whatever order they arrive in.
    const accepted = new Map<string, StashEntry>();
    for (const incoming of remote) {
      const local = accepted.get(incoming.itemId) ?? this.stash.get(incoming.itemId);
      if (local !== undefined && local.updatedAt > incoming.updatedAt) continue;
      if (
        local !== undefined &&
        !local.dirty &&
        local.updatedAt === incoming.updatedAt &&
        local.deleted === incoming.deleted &&
        local.quantity === incoming.quantity &&
        local.note === incoming.note
      ) {
        continue;
      }
      accepted.set(incoming.itemId, { ...incoming, dirty: false });
    }
    await this.commit([...accepted.values()]);
    return accepted.size;
  }

  // -- matching -------------------------------------------------------------

  /**
   * A match solver over the current catalogue and stash. Built on first use
   * and reused until either changes, so call this freely.
   */
  getSolver(): MatchSolver {
    this.solver ??= createMatchSolver({
      catalog: this.catalog,
      ownedIds: this.ownedIds(),
      ...(this.overrides !== undefined ? { overrides: this.overrides } : {}),
    });
    return this.solver;
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Be told after every change to the catalogue or stash.
   * @returns a function that stops the notifications.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Release the underlying storage connection. */
  close(): void {
    this.listeners.clear();
    this.adapter.close();
  }

  // -- internals ------------------------------------------------------------

  /** A new timestamp that is strictly newer than the entry it replaces, even if the clock went backwards. */
  private stamp(timestamp: number, existing: StashEntry | undefined): number {
    return existing !== undefined && existing.updatedAt >= timestamp ? existing.updatedAt + 1 : timestamp;
  }

  private indexCatalog(items: readonly CatalogItem[], revision: number): void {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    this.catalog = items
      .slice()
      .sort(
        (a, b) =>
          collator.compare(a.brand, b.brand) ||
          collator.compare(a.line, b.line) ||
          collator.compare(a.name, b.name) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const count = this.catalog.length;
    this.indexById = new Map();
    this.searchText = new Array<string>(count);
    this.lab = new Float64Array(count * 3);
    this.ownedFlags = new Uint8Array(count);
    for (let index = 0; index < count; index++) {
      const item = this.catalog[index] as CatalogItem;
      this.indexById.set(item.id, index);
      this.searchText[index] = normaliseText(`${item.brand} ${item.line} ${item.sku} ${item.name}`);
      this.lab[index * 3] = item.color.lab[0];
      this.lab[index * 3 + 1] = item.color.lab[1];
      this.lab[index * 3 + 2] = item.color.lab[2];
      if (this.isOwned(item.id)) this.ownedFlags[index] = 1;
    }
    this.catalogRevisionValue = revision;
    this.solver = undefined;
  }

  /**
   * Run storage writes strictly one after another, in the order they were
   * requested. Without this, a subscriber that edits the stash from inside a
   * change notification would reach storage before the edit that triggered
   * it, and the older write would land last. A failed write rejects for its
   * own caller only; later writes still run.
   */
  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(task);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  /** Apply entries to memory, queue the write, notify, then wait for the write. */
  private async commit(entries: readonly StashEntry[], affectsOwnership = true): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) {
      this.stash.set(entry.itemId, entry);
      const index = this.indexById.get(entry.itemId);
      if (index !== undefined) this.ownedFlags[index] = entry.deleted ? 0 : 1;
    }
    // Queue before notifying, so anything a subscriber does is written after this.
    const written = this.enqueueWrite(() => this.adapter.putStash(entries));
    if (affectsOwnership) {
      this.solver = undefined;
      try {
        this.changed();
      } catch (error) {
        await written.catch(() => undefined);
        throw error;
      }
    }
    await written;
  }

  private changed(): void {
    this.versionValue += 1;
    for (const listener of [...this.listeners]) listener();
  }
}
