import { useState } from 'react';

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
