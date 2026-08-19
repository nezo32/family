import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from './providers';
import { resetRefreshState } from '@/shared/api/refresh';
import { clearAccessToken } from '@/shared/api/token-store';

/**
 * Shell smoke test.
 *
 * Not a UI test — it exists to catch the class of breakage that a type check
 * cannot see: a provider in the wrong order, a lazy route that fails to
 * resolve, a context read outside its provider. It walks the real unauthorised
 * path: `/` → `/api/me` 401 → refresh 401 → session ends → `/login`.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('application shell', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    clearAccessToken();
    resetRefreshState();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/refresh')) {
          return Promise.resolve(
            jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'no session' } }),
          );
        }
        return Promise.resolve(
          jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'no session' } }),
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('boots and sends an unauthenticated visitor to the login screen', async () => {
    render(<Providers />);

    await waitFor(
      () => {
        expect(screen.getByText('Войти через Google')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    expect(window.location.pathname).toBe('/login');
  });
});
