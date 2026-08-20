import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatusResponse, UserStatus } from '@family/shared';
import { PendingApprovalPage } from './AccountStatusPages';
import { AUTH_RU } from '../locale';

/**
 * «Ожидание решения» — the screen an applicant is left staring at.
 *
 * ## Why this is worth a test
 *
 * The half of the 20 August incident that nobody was looking at. Even once the
 * owner's side was fixed, this screen would have kept saying «Почти готово»:
 * `useAccountStatus` has a 15-second stale time and refetches on window focus,
 * and neither ever fires on the device that matters — the applicant's phone,
 * with the tab already open and already focused, waiting. The «Проверить
 * статус» button worked perfectly, which is exactly why the gap survived: every
 * manual test pressed the button.
 *
 * So the rule under test is "the screen notices on its own", and the only
 * honest way to assert it is to change what the server says and then touch
 * nothing but the clock.
 *
 * A `pending_approval` user holds no session, so `GET /api/auth/status?ticket=`
 * is the whole conversation — no `/api/me`, no bearer token. A 401 here would
 * bounce them to `/login`, which is the loop these screens exist to break.
 */

const TICKET = 'v1.ticket.for.a.waiting.applicant';

/** What the server currently says. Reassigned mid-test to simulate a decision. */
let currentStatus: UserStatus = 'pending_approval';
let statusCalls = 0;

function statusBody(): AccountStatusResponse {
  return {
    status: currentStatus,
    displayName: 'дарья кислякова',
    submittedAt: '2026-08-20T05:07:56.000Z',
    reason: currentStatus === 'rejected' ? 'Не узнали' : null,
  };
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/status')) {
        statusCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify(statusBody()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'unstubbed' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

function renderWaitingScreen(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/auth/pending?ticket=${TICKET}`]}>
        <PendingApprovalPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Let timers fire and every promise they started settle. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  currentStatus = 'pending_approval';
  statusCalls = 0;
  vi.useFakeTimers();
  installFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the applicant waiting for a decision', () => {
  it('notices an approval without being touched', async () => {
    renderWaitingScreen();
    await tick(50);

    expect(screen.getByText(AUTH_RU.status.pendingTitle)).toBeInTheDocument();
    const callsWhileWaiting = statusCalls;

    // The owner approves. Nothing happens on this device: no tap, no focus
    // event, no reload. Only time passes.
    currentStatus = 'active';
    await tick(15_000);

    expect(screen.getByText(AUTH_RU.status.pendingApproved)).toBeInTheDocument();
    expect(statusCalls).toBeGreaterThan(callsWhileWaiting);

    // «Почти готово» and «скоро откроет доступ» would both now be false, and
    // both invite the person to keep waiting on a screen they are done with.
    expect(screen.queryByText(AUTH_RU.status.pendingTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(AUTH_RU.status.pendingDescription)).not.toBeInTheDocument();
  });

  it('stops asking once the answer has arrived', async () => {
    renderWaitingScreen();
    await tick(50);

    currentStatus = 'active';
    await tick(15_000);
    expect(screen.getByText(AUTH_RU.status.pendingApproved)).toBeInTheDocument();

    // The poll exists to catch a decision. Once there is one, a screen nobody
    // has closed must not keep the phone talking to the server forever.
    const settled = statusCalls;
    await tick(60_000);
    expect(statusCalls).toBe(settled);
  });

  it('shows a rejection instead of waiting for an answer that already came', async () => {
    renderWaitingScreen();
    await tick(50);

    currentStatus = 'rejected';
    await tick(15_000);

    expect(screen.getByText(AUTH_RU.status.rejectedTitle)).toBeInTheDocument();
    // The reason is the only thing that makes a rejection actionable.
    expect(screen.getByText('Не узнали')).toBeInTheDocument();
  });
});
