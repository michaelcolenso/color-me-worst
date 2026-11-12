import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { CatalogBundle } from '../lib/catalog/seedBuilder';
import { StashStore, createIndexedDbAdapter, createMemoryAdapter } from '../lib/store/stashStore';
import seedJson from '../data/catalogSeed.json';

const seed = seedJson as unknown as CatalogBundle;

interface StoreState {
  store: StashStore;
  /** False when IndexedDB is unavailable and the stash lives only in memory. */
  persistent: boolean;
}

const StoreContext = createContext<StoreState | null>(null);

async function openStore(): Promise<StoreState> {
  let persistent = true;
  let adapter;
  try {
    adapter = await createIndexedDbAdapter();
  } catch {
    // Private browsing, or storage blocked: keep working, but say so.
    persistent = false;
    adapter = createMemoryAdapter();
  }
  const store = await StashStore.open(adapter);
  if (store.catalogRevision < seed.revision) await store.importCatalog(seed.items, seed.revision);
  return { store, persistent };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: StoreState | undefined;
    openStore().then(
      (result) => {
        if (cancelled) result.store.close();
        else {
          opened = result;
          setState(result);
        }
      },
      (reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      cancelled = true;
      opened?.store.close();
    };
  }, []);

  if (error !== null) {
    return (
      <main className="boot" role="alert">
        <h1>Couldn’t open your stash</h1>
        <p>{error}</p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>
    );
  }
  if (state === null) {
    return (
      <main className="boot" aria-busy="true">
        <p>Loading catalogue…</p>
      </main>
    );
  }
  return <StoreContext.Provider value={state}>{children}</StoreContext.Provider>;
}

/**
 * The stash store, re-rendering the caller whenever the catalogue or stash
 * changes. `version` is a number that changes with every such change, for use
 * in dependency lists.
 */
export function useStore(): { store: StashStore; version: number; persistent: boolean } {
  const state = useContext(StoreContext);
  if (state === null) throw new Error('useStore must be used inside <StoreProvider>');
  const { store, persistent } = state;
  const subscribe = useMemo(() => (listener: () => void) => store.subscribe(listener), [store]);
  const version = useSyncExternalStore(subscribe, () => store.version);
  return { store, version, persistent };
}
