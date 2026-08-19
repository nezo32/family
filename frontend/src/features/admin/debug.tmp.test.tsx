import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { describe, it, vi } from 'vitest';
import MembersPage from './pages/MembersPage';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('debug page', () => {
  it('logs query errors', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/me')) {
        return Promise.resolve(json(200, {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'm@example.com', displayName: 'Мама', avatarUrl: null,
          role: 'admin', status: 'active', timezone: 'Europe/Moscow',
          permissions: ['member:read', 'member:approve', 'member:update:any', 'member:remove', 'member:role:assign'],
          providers: ['google'],
        }));
      }
      return Promise.resolve(json(200, { items: [], pendingCount: 0 }));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MembersPage /></QueryClientProvider>);
    await waitFor(() => {
      const errs = client.getQueryCache().getAll().map((q) => [JSON.stringify(q.queryKey), q.state.status, String(q.state.error)]);
      console.warn('QUERIES', JSON.stringify(errs));
      if (errs.some((e) => e[1] === 'pending')) throw new Error('wait');
    }, { timeout: 3000 });
  });
});
