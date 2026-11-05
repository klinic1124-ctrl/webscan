import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { registerSW } from 'virtual:pwa-register';

// Offline support / home-screen install. Not available everywhere (e.g. in
// embedded previews), which is fine: the app works without it.
if ('serviceWorker' in navigator && window.isSecureContext) {
  try {
    registerSW({ immediate: true, onRegisterError: () => undefined });
  } catch {
    /* ignore */
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
