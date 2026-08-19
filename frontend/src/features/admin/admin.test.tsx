import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '@family/shared';
import { clearAccessToken } from '@/shared/api/token-store';
import MembersPage from './pages/MembersPage';

/**
 * Behaviour tests for the approval queue.
 *
 * What is worth testing here is the handful of rules that a type check cannot
 * see and that would each be a real incident in a real family:
 *
 *  - a `409` (two admins tapping at once) must read as «Уже обработано» and
 *    refresh the queue, never as an error;
 *  - the role picker must offer only roles the actor may actually assign;
 *  - a member without `member:approve` must not see the queue *at all* — not a
 *    redirect, not a disabled button;
 *  - suspending somebody must ask first, and must say what it costs.
 */

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const PENDING_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';

const ADMIN_PERMISSIONS: Permission[] = [
  'member:read',
  'member:approve',
  'member:update:any',
  'member:remove',
  'member:role:assign',
];

function meBody(permissions: Permission[], role = 'admin') {
  return {
    id: ADMIN_ID,
    email: 'mama@example.com',
    displayName: 'Мама',
    avatarUrl: null,
    role,
    status: 'active',
    timezone: 'Europe/Moscow',
    permissions,
    providers: ['google'],
  };
}

function pendingMember(overrides: Record<string, unknown> = {}) {
  return {
    id: PENDING_ID,
    displayName: 'Лиза',
    avatarUrl: null,
    color: null,
    role: 'guest',
    status: 'pending_approval',
    email: 'liza@example.com',
    emailVerified: true,
    choreWeight: 1,
    sortOrder: 0,
    permissionGrants: [],
    permissionDenies: [],
    createdAt: '2026-08-19T09:00:00.000Z',
    approvedAt: null,
    approvedById: null,
    rejectedReason: null,
    lastSeenAt: null,
    // Keeps the card free of a role badge, so role labels in the assertions can
    // only have come from the picker.
    providers: ['telegram'],
    ...overrides,
  };
}

function activeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBER_ID,
    displayName: 'Петя',
    avatarUrl: null,
    color: null,
    role: 'child',
    status: 'active',
    email: null,
    emailVerified: false,
    choreWeight: 1,
    sortOrder: 1,
    permissionGrants: [],
    permissionDenies: [],
    createdAt: '2026-01-01T09:00:00.000Z',
    approvedAt: '2026-01-02T09:00:00.000Z',
    approvedById: ADMIN_ID,
    rejectedReason: null,
    lastSeenAt: null,
    ...overrides,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  url: string;
  method: string;
}

interface Scenario {
  me: ReturnType<typeof meBody>;
  pending?: unknown[];
  members?: unknown[];
  /** Status returned by `POST /members/:id/approve`. */
  approveStatus?: number;
}

const calls: Call[] = [];

function installFetch(scenario: Scenario) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });

      // `/api/me` must be matched exactly: `/api/members` starts with it.
      if (url.endsWith('/api/me')) return Promise.resolve(json(200, scenario.me));

      if (url.includes('/api/members/pending')) {
        const items = scenario.pending ?? [];
        return Promise.resolve(json(200, { items, pendingCount: items.length }));
      }

      if (url.includes('/approve')) {
        const status = scenario.approveStatus ?? 200;
        if (status === 409) {
          return Promise.resolve(
            json(409, { error: { code: 'CONFLICT', message: 'already decided' } }),
          );
        }
        return Promise.resolve(json(200, activeMember({ id: PENDING_ID })));
      }

      if (url.includes('/suspend')) {
        return Promise.resolve(json(200, activeMember({ status: 'suspended' })));
      }

      if (url.includes('/api/members')) {
        const items = scenario.members ?? [];
        return Promise.resolve(json(200, { items, pendingCount: 0 }));
      }

      return Promise.resolve(json(404, { error: { code: 'NOT_FOUND', message: 'no route' } }));
    }),
  );
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MembersPage />
    </QueryClientProvider>,
  );
}

function countCalls(fragment: string): number {
  return calls.filter((call) => call.url.includes(fragment)).length;
}

beforeEach(() => {
  calls.length = 0;
  clearAccessToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('approval queue', () => {
  it('treats a 409 as «Уже обработано» and refetches the queue', async () => {
    installFetch({
      me: meBody(ADMIN_PERMISSIONS),
      pending: [pendingMember()],
      approveStatus: 409,
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Одобрить' }));

    const childOption = await screen.findByText('Ребёнок');
    const before = countCalls('/members/pending');
    fireEvent.click(childOption);

    // The loser of the race is told what happened, in Russian, mapped from the
    // ErrorCode — never from the server's English `message`.
    expect(await screen.findByText('Уже обработано')).toBeInTheDocument();

    await waitFor(() => {
      expect(countCalls('/members/pending')).toBeGreaterThan(before);
    });
  });

  it('offers only the roles the current user may assign', async () => {
    installFetch({ me: meBody(ADMIN_PERMISSIONS), pending: [pendingMember()] });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Одобрить' }));

    // An admin outranks adult and below, and nothing above.
    expect(await screen.findByText('Взрослый')).toBeInTheDocument();
    expect(screen.getByText('Подросток')).toBeInTheDocument();
    expect(screen.getByText('Ребёнок')).toBeInTheDocument();
    expect(screen.getByText('Гость')).toBeInTheDocument();
    expect(screen.queryByText('Администратор')).not.toBeInTheDocument();
    expect(screen.queryByText('Владелец')).not.toBeInTheDocument();

    // And the choice is explained, not just labelled (ROLE_DESCRIPTIONS_RU).
    expect(screen.getByText('Свои задачи, общий календарь и список покупок.')).toBeInTheDocument();
  });

  it('renders no queue at all for a member without member:approve', async () => {
    installFetch({ me: meBody(['member:read']), pending: [pendingMember()] });
    renderPage();

    expect(await screen.findByText('Нет доступа')).toBeInTheDocument();
    expect(screen.queryByText('Ждут решения')).not.toBeInTheDocument();
    expect(screen.queryByText('Лиза')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Одобрить' })).not.toBeInTheDocument();
    // Not merely hidden: the moderation request is never issued.
    expect(countCalls('/members/pending')).toBe(0);
  });

  it('asks for confirmation before suspending, and spells out the consequence', async () => {
    installFetch({ me: meBody(ADMIN_PERMISSIONS), members: [activeMember()] });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Приостановить' }));

    expect(await screen.findByText(/все сессии будут завершены/i)).toBeInTheDocument();
    expect(countCalls('/suspend')).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Приостановить доступ' }));

    await waitFor(() => {
      expect(countCalls('/suspend')).toBe(1);
    });
  });
});
