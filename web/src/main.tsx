import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './index.css';

// This app used to ship a service worker. Removing the plugin stops new ones
// from being created but does nothing about workers already installed in a
// browser, which would keep serving the old precached shell forever. Tear any
// leftover down and drop its caches.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) void reg.unregister();
    if (regs.length && 'caches' in window) {
      void caches.keys().then((keys) => keys.forEach((k) => void caches.delete(k)));
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
