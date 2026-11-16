import { useState } from 'react';

import { downloadBlob } from '../lib/export/recipeCard';

import type { MatchMode } from '../lib/color/matchSolver';
import { useStore } from './store';
import { RecipeView } from './views/RecipeView';
import { StashView } from './views/StashView';
import { WorkspaceView } from './views/WorkspaceView';

type Tab = 'photo' | 'recipe' | 'stash';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'photo', label: 'Photo' },
  { id: 'recipe', label: 'Recipe' },
  { id: 'stash', label: 'Stash' },
];

/**
 * Shown on every tab while some stash changes exist only in memory because a
 * write to this device's storage failed. Matches already use those changes;
 * a reload would lose them.
 */
function SaveProblem() {
  const { store } = useStore();
  const [retrying, setRetrying] = useState(false);
  const [failedAgain, setFailedAgain] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await store.retryPersistence();
      setFailedAgain(false);
    } catch {
      setFailedAgain(true);
    } finally {
      setRetrying(false);
    }
  };
  const backup = () =>
    downloadBlob(
      new Blob([JSON.stringify(store.exportBackup(), null, 1)], { type: 'application/json' }),
      `stash-backup-${new Date().toISOString().slice(0, 10)}.json`,
    );
  return (
    <div className="notice error banner save-status" role="alert">
      <span>
        Some stash changes aren’t saved on this device yet{store.persistenceError ? ` (${store.persistenceError})` : ''}.
        Matches already use them, but reloading now would lose them.
        {failedAgain && ' Saving failed again: free up space, or download a backup.'}
      </span>
      <button type="button" className="button small" onClick={() => void retry()} disabled={retrying}>
        {retrying ? 'Saving…' : 'Try saving again'}
      </button>
      <button type="button" className="button small" onClick={backup}>
        Download a backup
      </button>
    </div>
  );
}

export function App() {
  const { store, persistent } = useStore();
  const [tab, setTab] = useState<Tab>('photo');
  const [mode, setMode] = useState<MatchMode>('full_catalog');

  return (
    <div className="app">
      <header className="app-header">
        <h1>Color Me Worst</h1>
        <nav aria-label="Sections">
          {TABS.map(({ id, label }) => (
            <button key={id} type="button" className="tab" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
              {label}
              {id === 'stash' && <span className="count">{store.ownedCount}</span>}
            </button>
          ))}
        </nav>
      </header>

      {!persistent && (
        <p className="notice error banner" role="alert">
          This browser is blocking storage (private browsing?), so your stash will be forgotten when you close this tab.
        </p>
      )}
      {store.hasUnpersistedChanges && <SaveProblem />}
      {store.ownedCount === 0 && tab !== 'stash' && (
        <p className="notice info banner">
          Your stash is empty, so every colour will show as missing.{' '}
          <button type="button" className="link" onClick={() => setTab('stash')}>
            Add what you own
          </button>
        </p>
      )}

      {/* Views stay mounted so a photo and its pins survive a trip to another tab. */}
      <main>
        <div hidden={tab !== 'photo'}>
          <WorkspaceView mode={mode} onModeChange={setMode} />
        </div>
        <div hidden={tab !== 'recipe'}>
          <RecipeView />
        </div>
        <div hidden={tab !== 'stash'}>
          <StashView />
        </div>
      </main>

      <footer className="app-footer">
        <p>
          Colours come from community data and have not been checked against real paint or thread. Treat matches as a
          strong starting point and test before you commit.
        </p>
      </footer>
    </div>
  );
}
