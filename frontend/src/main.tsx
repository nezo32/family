import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { primeVapidKey } from '@/features/settings/push/push';
import { registerServiceWorker } from './app/pwa/register-sw';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registered after the first render so the SW install never competes with the
// initial paint. `registerType: 'prompt'` means this cannot swap assets under
// the user without asking.
registerServiceWorker();

// Cache the Web Push application server key well before anybody taps
// «Включить уведомления». It cannot be fetched inside that click handler --
// the round trip spends the user-activation token and Safari then refuses to
// subscribe -- so it is primed here, at boot, outside any gesture.
void primeVapidKey();
