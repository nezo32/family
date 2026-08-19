import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
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
