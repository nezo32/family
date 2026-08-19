import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meResponseSchema } from '@family/shared';
import { clearAccessToken } from '@/shared/api/token-store';
import { makeMe } from '@/test/me';
import { useMe } from './use-me';
import { useCan } from './use-can';
import { RequireAuth } from './require-auth';
import { toDayPickerWeekStart } from './week-start';

/**
 * The `/api/me` contract, tested where it actually breaks.
 *
 * ## The bug this file exists to prevent
 *
 * The frontend used to keep its own **flat** mirror of `GET /api/me`
 * (`shared/auth/types.ts`) while the server returned the **nested**
 * `meResponseSchema` from `@family/shared`. `use-me.ts` parses rather than
 * casts, so every single call threw a `ZodError`, `RequireAuth` gated all 21
 * routes on it, and every authenticated screen rendered an error state. The app
 * did not boot.
 *
 * 130 tests passed throughout. They passed because every one of them seeded the
 * cache directly — `queryClient.setQueryData(meKeys.detail(), <hand-built flat
 * object>)` — which writes *past* the query function, so the real parser never
 * ran in a test even once.
 *
 * So the tests below deliberately do the two things the old suite never did:
 *
 *  1. they let a **real `fetch`** answer with a real server payload and go
 *     through the real `queryFn`, i.e. through `meResponseSchema.parse`;
 *  2. they assert the shared fixture is itself contract-valid, so that seeding
 *     the cache can never again mean "seed a shape that does not exist".
 */

/** A verbatim `GET /api/me` body, as the backend's route composes it. */
const SERVER_ME_RESPONSE = {
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'Аня',
    avatarUrl: null,
    color: '#C2703D',
    role: 'adult',
    status: 'active',
    email: 'anya@example.com',
    birthDate: '1989-04-12',
    // Nullable in `selfUserSchema`: NULL means "inherit `family.timezone`".
    timezone: null,
    locale: 'ru-RU',
  },
  permissions: ['task:read:any', 'event:read', 'notification:manage:own'],
  family: {
    name: 'Ивановы',
    timezone: 'Europe/Moscow',
    // ISO-8601 weekday: 1 = понедельник. Never the 0-based day-picker axis.
    weekStartsOn: 1,
    currency: 'RUB',
  },
  permissionsVersion: 'pv-7f3a',
};

/** The shape the frontend used to insist on. Kept as the regression guard. */
const LEGACY_FLAT_ME = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'anya@example.com',
  displayName: 'Аня',
  avatarUrl: null,
  role: 'adult',
  status: 'active',
  timezone: 'Europe/Moscow',
  permissions: ['task:read:any'],
  providers: [],
  family: { name: 'Ивановы', timezone: 'Europe/Moscow', currency: 'RUB', weekStartsOn: 1 },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function wrapper(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

/** Renders whatever `useMe()` gives us, straight from the nested contract. */
function MeProbe() {
  const { data, isPending, isError } = useMe();
  const { can, userId } = useCan();
  if (isPending) return <p>загрузка</p>;
  if (isError || !data) return <p>ошибка</p>;
  return (
    <dl>
      <dd data-testid="name">{data.user.displayName}</dd>
      <dd data-testid="family">{data.family.name}</dd>
      <dd data-testid="week-start">{String(data.family.weekStartsOn)}</dd>
      <dd data-testid="user-id">{userId ?? '—'}</dd>
      <dd data-testid="can-read-tasks">{can('task:read') ? 'да' : 'нет'}</dd>
      <dd data-testid="version">{data.permissionsVersion}</dd>
    </dl>
  );
}

describe('GET /api/me — the real response through the real parser', () => {
  beforeEach(() => {
    clearAccessToken();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the nested server payload and feeds the whole shell from it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/me')) return Promise.resolve(jsonResponse(200, SERVER_ME_RESPONSE));
        return Promise.resolve(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'no' } }));
      }),
    );

    render(wrapper(<MeProbe />));

    // With the old flat schema this never resolves: `parse()` throws and the
    // probe renders «ошибка» — which is what every screen in the app did.
    await waitFor(() => {
      expect(screen.getByTestId('name')).toHaveTextContent('Аня');
    });
    expect(screen.getByTestId('family')).toHaveTextContent('Ивановы');
    expect(screen.getByTestId('week-start')).toHaveTextContent('1');
    expect(screen.getByTestId('version')).toHaveTextContent('pv-7f3a');
    // `useCan()` reads `permissions` and `user.id` — the two fields the flat
    // shape put in different places.
    expect(screen.getByTestId('user-id')).toHaveTextContent(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(screen.getByTestId('can-read-tasks')).toHaveTextContent('да');
  });

  it('lets RequireAuth render its children for an active session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(200, SERVER_ME_RESPONSE))),
    );

    render(
      wrapper(
        <RequireAuth>
          <p>защищённый экран</p>
        </RequireAuth>,
      ),
    );

    // The guard reads `me.user.status`. On the flat shape `status` was
    // `undefined`, the parse threw first, and all 21 routes showed an error.
    await waitFor(() => {
      expect(screen.getByText('защищённый экран')).toBeInTheDocument();
    });
  });

  it('rejects the legacy flat shape — the drift must fail loudly, not silently', () => {
    expect(meResponseSchema.safeParse(LEGACY_FLAT_ME).success).toBe(false);
    expect(meResponseSchema.safeParse(SERVER_ME_RESPONSE).success).toBe(true);
  });

  it('keeps the shared test fixture contract-valid', () => {
    // `makeMe` parses through `meResponseSchema` itself, so this asserts the
    // helper cannot go back to hand-building a shape the server never sends.
    const me = makeMe({ permissions: ['task:read:any'] });
    expect(meResponseSchema.safeParse(me).success).toBe(true);
    expect(me.user.displayName).toBeTypeOf('string');
    expect(me.family.weekStartsOn).toBeGreaterThanOrEqual(1);
    expect(me.family.weekStartsOn).toBeLessThanOrEqual(7);
    // The nullable fields are nullable on purpose (Telegram has no email, and a
    // NULL timezone means "inherit the family's").
    expect(makeMe({ email: null }).user.email).toBeNull();
    expect(makeMe({ timezone: null }).user.timezone).toBeNull();
    // `avatarUrl` is a bare nullable string server-side, not a `.url()`.
    expect(makeMe({ avatarUrl: '/uploads/a.png' }).user.avatarUrl).toBe('/uploads/a.png');
  });
});

describe('weekStartsOn axis conversion', () => {
  /**
   * The contract is ISO (1 = Monday … 7 = Sunday); react-day-picker and date-fns
   * are 0-based (0 = Sunday … 6 = Saturday). They agree on 1–6, which is why a
   * Monday-start family never reveals the bug and a Sunday-start one silently
   * gets a Monday grid.
   */
  it('maps ISO Sunday (7) onto the day-picker Sunday (0)', () => {
    expect(toDayPickerWeekStart(7)).toBe(0);
  });

  it('leaves 1–6 alone and falls back to Monday for anything out of range', () => {
    for (const iso of [1, 2, 3, 4, 5, 6]) {
      expect(toDayPickerWeekStart(iso)).toBe(iso);
    }
    expect(toDayPickerWeekStart(undefined)).toBe(1);
    // `0` is not a valid ISO weekday — a caller passing the day-picker axis by
    // mistake gets Monday rather than an out-of-range index.
    expect(toDayPickerWeekStart(0)).toBe(1);
    expect(toDayPickerWeekStart(8)).toBe(1);
    expect(toDayPickerWeekStart(1.5)).toBe(1);
  });
});
