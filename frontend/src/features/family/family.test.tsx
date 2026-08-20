import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission, Role } from '@family/shared';
import { clearAccessToken } from '@/shared/api/token-store';
import { makeMe } from '@/test/me';
import FamilyPage from './pages/FamilyPage';

/**
 * Behaviour tests for the «Семья» roster.
 *
 * The rules under test are the ones that would quietly rot:
 *
 *  - the weekly load renders as a **neutral bar**, and the roster is never
 *    re-ordered by it — D5's "no sibling leaderboard" is a property of the DOM,
 *    not of a comment;
 *  - the role picker offers exactly `assignableRoles(me.user.role)`;
 *  - without the permission the controls **do not render** — not disabled,
 *    absent;
 *  - suspending asks first and says that every session ends.
 */

const ME_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const TEEN_ID = '33333333-3333-4333-8333-333333333333';

const ADMIN_PERMISSIONS: Permission[] = [
  'member:read',
  'member:update:any',
  'member:remove',
  'member:role:assign',
  'task:read:any',
];

function meBody(permissions: Permission[], role: Role = 'admin') {
  return makeMe({ id: ME_ID, displayName: 'Мама', role, permissions });
}

function member(overrides: Record<string, unknown>) {
  return {
    id: CHILD_ID,
    displayName: 'Петя',
    avatarUrl: null,
    color: null,
    role: 'child',
    status: 'active',
    email: null,
    emailVerified: false,
    choreWeight: 1,
    sortOrder: 0,
    permissionGrants: [],
    permissionDenies: [],
    createdAt: '2026-01-01T09:00:00.000Z',
    approvedAt: '2026-01-02T09:00:00.000Z',
    approvedById: ME_ID,
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

interface Scenario {
  me: ReturnType<typeof meBody>;
  members: unknown[];
}

const calls: { url: string; method: string }[] = [];

function installFetch(scenario: Scenario) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });

      // Exact match: `/api/members` also starts with `/api/me`.
      if (url.endsWith('/api/me')) return Promise.resolve(json(200, scenario.me));

      if (url.includes('/api/tasks/occurrences')) {
        return Promise.resolve(json(200, { items: [], nextCursor: null }));
      }

      if (url.includes('/suspend')) {
        return Promise.resolve(json(200, member({ status: 'suspended' })));
      }

      if (url.includes('/api/members')) {
        return Promise.resolve(json(200, { items: scenario.members, pendingCount: 0 }));
      }

      return Promise.resolve(json(404, { error: { code: 'NOT_FOUND', message: 'no route' } }));
    }),
  );
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FamilyPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  clearAccessToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('family roster', () => {
  it('shows who is in the family and attaches no number to anybody (D5)', async () => {
    installFetch({
      me: meBody(ADMIN_PERMISSIONS),
      members: [
        member({ id: CHILD_ID, displayName: 'Петя', sortOrder: 0 }),
        member({ id: TEEN_ID, displayName: 'Лиза', role: 'teen', sortOrder: 1 }),
      ],
    });
    const { container } = renderPage();

    expect(await screen.findByText('Петя')).toBeInTheDocument();
    expect(await screen.findByText('Лиза')).toBeInTheDocument();

    // Roster order is sortOrder — never load, never anything a child could read
    // as a placing.
    const names = [...container.querySelectorAll('li')].map(
      (item) => item.textContent?.slice(0, 40) ?? '',
    );
    expect(names[0]).toContain('Петя');
    expect(names[1]).toContain('Лиза');

    // The roster does not ask for the family's load at all any more. One bar
    // per person, stacked down a list of siblings, is the comparison the score
    // removal was about — the week's split lives on the chores screen instead.
    expect(calls.some((call) => call.url.includes('/chores/fairness'))).toBe(false);

    // No placing, no ranking vocabulary, no score anywhere on the screen.
    expect(screen.queryByText(/место|рейтинг|лучш|больше всех|балл/i)).not.toBeInTheDocument();
  });

  it('offers only the roles the current user may assign', async () => {
    installFetch({
      me: meBody(ADMIN_PERMISSIONS),
      members: [member({ displayName: 'Петя' })],
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Петя/ }));

    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('Роль')).toBeInTheDocument();

    // An admin may hand out adult and below — never their own rank or above.
    expect(within(sheet).getByText('Взрослый')).toBeInTheDocument();
    expect(within(sheet).getByText('Подросток')).toBeInTheDocument();
    expect(within(sheet).getByText('Гость')).toBeInTheDocument();
    expect(within(sheet).queryByText('Администратор')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('Владелец')).not.toBeInTheDocument();

    // Explained, not just labelled.
    expect(
      within(sheet).getByText('Ограниченный просмотр: календарь и экстренная информация.'),
    ).toBeInTheDocument();
  });

  it('renders no management controls at all without the permissions', async () => {
    installFetch({
      me: meBody(['member:read', 'task:read:any']),
      members: [member({ displayName: 'Петя' })],
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Петя/ }));

    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).queryByText('Роль')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('Вес в ротации дел')).not.toBeInTheDocument();
    expect(
      within(sheet).queryByRole('button', { name: 'Приостановить доступ' }),
    ).not.toBeInTheDocument();
  });

  it('asks for confirmation before suspending, and says the sessions end', async () => {
    installFetch({
      me: meBody(ADMIN_PERMISSIONS),
      members: [member({ displayName: 'Петя' })],
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Петя/ }));

    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Приостановить доступ' }));

    expect(await screen.findByText(/все сессии будут завершены/i)).toBeInTheDocument();
    expect(calls.filter((call) => call.url.includes('/suspend'))).toHaveLength(0);

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Приостановить доступ' }));

    await waitFor(() => {
      expect(calls.filter((call) => call.url.includes('/suspend'))).toHaveLength(1);
    });
  });
});
