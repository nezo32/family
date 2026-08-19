import { Providers } from '@/app/providers';

/**
 * Application root.
 *
 * Intentionally almost empty: everything that could be a provider is one, and
 * they all live in `app/providers.tsx`. Routing starts there too, so this file
 * should never need to change.
 */
export default function App() {
  return <Providers />;
}
