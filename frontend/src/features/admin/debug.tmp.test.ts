import { describe, it, vi } from 'vitest';
import { api } from '@/shared/api/client';
import { fetchPendingMembers } from './api';

describe('debug client', () => {
  it('parses body with a signal', async () => {
    const stub = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ items: [], pendingCount: 0 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })),
    );
    vi.stubGlobal('fetch', stub);
    const ctrl = new AbortController();
    const raw = await api.get<unknown>('/members/pending', { signal: ctrl.signal });
    console.warn('RAW-SIGNAL', JSON.stringify(raw));
    const parsed = await fetchPendingMembers(ctrl.signal);
    console.warn('PARSED', JSON.stringify(parsed));
    console.warn('CALL-ARGS', JSON.stringify(stub.mock.calls[0]?.[0]));
  });
});
