import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { Permission } from '@family/shared';
import { ERROR_MESSAGES_RU } from '@/shared/api/errors-ru';
import { clearAccessToken } from '@/shared/api/token-store';
import { makeMe } from '@/test/me';
import TodayPage from './pages/TodayPage';
import { TODAY_RU, taskCount } from './locale';
import type { DashboardEvent, DashboardTask, TodayResponse, WeekResponse } from './types';

/**
 * What is worth testing on this screen (and what is not).
 *
 * Not tested: that a `<Card>` renders, that TanStack Query caches. Tested: the
 * four rules that would be a real incident if they broke —
 *
 *   1. a widget the user has no permission for must not reach the DOM,
 *   2. a failed completion must roll the optimistic tick back and say so in
 *      Russian,
 *   3. an empty day must look deliberate, not broken,
 *   4. Russian plurals, including the 11–14 exception.
 */

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const ME_ID = '11111111-1111-4111-8111-111111111111';
const TASK_TITLE = 'Вынести мусор';

const ADULT_PERMISSIONS: Permission[] = [
  'task:read:any',
  'task:complete:own',
  'task:complete:any',
  'event:read',
  'shopping:read',
  'goal:read',
  'member:approve',
];

/** A child holds no `goal:*` and no `member:approve` at all (D4). */
const CHILD_PERMISSIONS: Permission[] = [
  'task:read:own',
  'task:complete:own',
  'event:read',
  'shopping:read',
];

/** The `/api/me` body this screen is rendered against. */
function meBody(permissions: Permission[]) {
  return makeMe({
    id: ME_ID,
    email: 'pasha@example.com',
    displayName: 'Паша Иванов',
    permissions,
    family: { name: 'Ивановы' },
  });
}

function makeTask(overrides: Partial<DashboardTask> = {}): DashboardTask {
  return {
    id: 'task-1',
    seriesId: 'series-1',
    title: TASK_TITLE,
    dueAt: '2026-08-19T16:00:00.000Z',
    dueDate: '2026-08-19',
    dueTime: '19:00',
    category: null,
    assigneeId: ME_ID,
    isOverdue: false,
    overdueByMinutes: 0,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<DashboardEvent> = {}): DashboardEvent {
  return {
    id: 'event-1',
    seriesId: 'event-series-1',
    title: 'Тренировка Лизы',
    startsAt: '2026-08-19T15:00:00.000Z',
    endsAt: '2026-08-19T16:00:00.000Z',
    date: '2026-08-19',
    time: '18:00',
    isAllDay: false,
    location: null,
    color: null,
    ...overrides,
  };
}

function makeToday(overrides: Partial<TodayResponse> = {}): TodayResponse {
  return {
    generatedAt: '2026-08-19T06:00:00.000Z',
    timezone: 'Europe/Moscow',
    today: '2026-08-19',
    tomorrow: '2026-08-20',
    tasks: { dueToday: [makeTask()], overdue: [], doneTodayCount: 1 },
    events: { today: [makeEvent()], tomorrow: [] },
    shopping: {
      urgent: [
        {
          id: 'item-1',
          listId: 'list-1',
          listName: 'Продукты',
          name: 'Молоко',
          quantity: '2',
          unit: 'л',
          requestedById: ME_ID,
        },
      ],
      neededCount: 7,
      urgentCount: 1,
    },
    goals: {
      nearestMilestone: {
        goalId: 'goal-1',
        goalTitle: 'Поездка на море',
        milestoneId: 'ms-1',
        title: 'Билеты',
        targetAmount: 5_000_000,
        savedAmount: 3_250_000,
        remainingAmount: 1_750_000,
        progressPercent: 65,
        currency: 'RUB',
        deadline: '2026-12-01',
      },
    },
    unreadNotifications: 0,
    fairness: {
      weekStart: '2026-08-17',
      weekEnd: '2026-08-24',
      me: {
        userId: ME_ID,
        displayName: 'Паша Иванов',
        doneCount: 3,
        weight: '1.00',
        sharePercent: 40,
      },
      members: [],
      note: 'Неделя идёт ровно.',
    },
    pendingApprovals: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        displayName: 'Лиза',
        email: null,
        requestedAt: '2026-08-18T20:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

const WEEK: WeekResponse = {
  generatedAt: '2026-08-19T06:00:00.000Z',
  timezone: 'Europe/Moscow',
  weekStart: '2026-08-17',
  weekEnd: '2026-08-24',
  days: [],
  totals: { tasks: 11, events: 2, overdue: 0 },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface StubOptions {
  permissions?: Permission[];
  today?: TodayResponse;
  /** Status returned by the completion endpoint. */
  completeStatus?: number;
  /**
   * Holds the completion response until the test releases it. Without a gate
   * the mocked fetch settles in the same tick as the click, and the optimistic
   * state is never observable — which would make the assertion pass for the
   * wrong reason.
   */
  completeGate?: Promise<void>;
}

function stubApi(options: StubOptions = {}): void {
  const permissions = options.permissions ?? ADULT_PERMISSIONS;
  const today = options.today ?? makeToday();
  const completeStatus = options.completeStatus ?? 200;
  const gate = options.completeGate;

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/me')) return Promise.resolve(jsonResponse(200, meBody(permissions)));
      if (url.includes('/api/dashboard/today')) return Promise.resolve(jsonResponse(200, today));
      if (url.includes('/api/dashboard/week')) return Promise.resolve(jsonResponse(200, WEEK));
      if (url.includes('/complete')) {
        const response =
          completeStatus === 200
            ? jsonResponse(200, { ok: true })
            : jsonResponse(completeStatus, {
                error: { code: 'INTERNAL_ERROR', message: 'boom' },
              });
        return gate ? gate.then(() => response) : Promise.resolve(response);
      }
      return Promise.resolve(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'no' } }));
    }),
  );
}

function renderToday() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TodayPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TodayPage', () => {
  beforeEach(() => {
    clearAccessToken();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hides the finance and approval widgets when the permission is absent', async () => {
    stubApi({ permissions: CHILD_PERMISSIONS });
    renderToday();

    // The «Мои дела» section proves the screen rendered at all.
    await screen.findByText(TODAY_RU.tasksTitle);

    // No `goal:read` — no goal card and no rouble figure anywhere.
    expect(screen.queryByText(TODAY_RU.goalTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(/Поездка на море/)).not.toBeInTheDocument();
    expect(screen.queryByText(/₽/)).not.toBeInTheDocument();
    // No `member:approve` — the signup queue is invisible.
    expect(screen.queryByText(TODAY_RU.approvalsTitle)).not.toBeInTheDocument();
  });

  it('shows the same widgets to a member who holds the permissions', async () => {
    stubApi({ permissions: ADULT_PERMISSIONS });
    renderToday();

    expect(await screen.findByText(TODAY_RU.goalTitle)).toBeInTheDocument();
    // The pending signup is the *attention* block here (nothing is overdue in
    // the fixture), so its heading is what proves the section reached the DOM.
    expect(screen.getByText(TODAY_RU.approvalsTitle)).toBeInTheDocument();
  });

  it('rolls the optimistic completion back and explains the failure in Russian', async () => {
    const gate = deferred();
    stubApi({ completeStatus: 500, completeGate: gate.promise });
    const user = userEvent.setup();
    renderToday();

    const tick = await screen.findByRole('button', {
      name: `${TODAY_RU.complete}: ${TASK_TITLE}`,
    });

    await user.click(tick);

    // Optimistic: the row leaves the list before the server has answered.
    await waitFor(() => {
      expect(screen.queryByText(TASK_TITLE)).not.toBeInTheDocument();
    });

    // Let the request fail.
    gate.release();

    // Rolled back: the chore is back, exactly as it was.
    await waitFor(() => {
      expect(screen.getByText(TASK_TITLE)).toBeInTheDocument();
    });

    // The user sees the mapped `ErrorCode`, never the server's English message.
    expect(toast.error).toHaveBeenCalledWith(TODAY_RU.completeErrorTitle, {
      description: ERROR_MESSAGES_RU.INTERNAL_ERROR,
    });
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('boom');
  });

  it('renders a warm empty state for a day with nothing on it', async () => {
    stubApi({
      today: makeToday({
        tasks: { dueToday: [], overdue: [], doneTodayCount: 0 },
        events: { today: [], tomorrow: [] },
        shopping: { urgent: [], neededCount: 0, urgentCount: 0 },
        pendingApprovals: [],
      }),
    });
    renderToday();

    expect(await screen.findByText(TODAY_RU.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(TODAY_RU.emptyDescription)).toBeInTheDocument();
    // An empty day is not an error: nothing on screen may claim otherwise.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Russian plurals', () => {
  it('picks the right form, including the 11–14 exception', () => {
    expect(taskCount(1)).toBe('1 задача');
    expect(taskCount(2)).toBe('2 задачи');
    expect(taskCount(5)).toBe('5 задач');
    // The one naive implementations get wrong: 11 is `many`, not `one`.
    expect(taskCount(11)).toBe('11 задач');
    expect(taskCount(21)).toBe('21 задача');
  });
});
