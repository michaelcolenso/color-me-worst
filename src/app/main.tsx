import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { StoreProvider } from './store';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
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
