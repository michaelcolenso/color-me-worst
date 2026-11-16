import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { StoreProvider } from './store';
import './styles.css';

/**
 * Last resort: an unexpected error anywhere below shows a recovery screen
 * instead of a blank page. Known failure cases are handled where they occur;
 * this only catches what slipped through. The stash is in IndexedDB, so a
 * reload loses nothing that was saved.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Unhandled error in the interface', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="boot" role="alert">
        <h1>Something went wrong</h1>
        <p>Your saved stash is safe. Reloading usually fixes this; an open photo and its pins will need to be added again.</p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <StoreProvider>
        <App />
      </StoreProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// Offline support. Only in production builds: during development a service
// worker would serve stale modules.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline support is an enhancement; the app works without it.
    });
  });
}
