import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type {
  EventOccurrenceResponse,
  Permission,
  ShoppingItemResponse,
  TaskOccurrenceResponse,
} from '@family/shared';
import { ERROR_MESSAGES_RU } from '@/shared/api/errors-ru';
import { clearAccessToken } from '@/shared/api/token-store';
import TodayPage from './pages/TodayPage';
import { TODAY_RU, taskCount } from './locale';
import type { DashboardTodayResponse, DashboardWeekResponse } from './types';

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

const ADULT_PERMISSIONS: Permission[] = [
  'task:read:any',
  'task:complete:own',
  'task:complete:any',
  'event:read',
  'shopping:read',
  'goal:read',
  'member:approve',
];

const CHILD_PERMISSIONS: Permission[] = [
  'task:read:own',
  'task:complete:own',
  'event:read',
  'shopping:read',
];

function makeMe(permissions: Permission[]) {
  return {
    id: ME_ID,
    email: 'pasha@example.com',
    displayName: 'Паша Иванов',
    avatarUrl: null,
    role: 'adult',
    status: 'active',
    timezone: 'Europe/Moscow',
    permissions,
    providers: [],
    family: { name: 'Ивановы', timezone: 'Europe/Moscow', currency: 'RUB', weekStartsOn: 1 },
  };
}

function makeTask(overrides: Partial<TaskOccurrenceResponse> = {}): TaskOccurrenceResponse {
  return {
    id: 'task-1',
    seriesId: 'series-1',
    occurrenceKey: '2026-08-19T19:00:00',
    startsAt: '2026-08-19T16:00:00.000Z',
    dueAt: '2026-08-19T16:00:00.000Z',
    localDate: '2026-08-19',
    startsLocal: '2026-08-19T19:00:00',
    timezone: 'Europe/Moscow',
    status: 'scheduled',
    isException: false,
    isOverdue: false,
    title: 'Вынести мусор',
    notes: null,
    points: 5,
    category: null,
    visibility: 'household',
    assigneeId: ME_ID,
    assignedVia: 'rotation',
    completedById: null,
    completedAt: null,
    skippedById: null,
    skipReason: null,
    pendingSwapId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventOccurrenceResponse> = {}): EventOccurrenceResponse {
  return {
    id: 'event-1',
    seriesId: 'event-series-1',
    occurrenceKey: '2026-08-19T18:00:00',
    startsAt: '2026-08-19T15:00:00.000Z',
    endsAt: '2026-08-19T16:00:00.000Z',
    localDate: '2026-08-19',
    startsLocal: '2026-08-19T18:00:00',
    timezone: 'Europe/Moscow',
    status: 'scheduled',
    isException: false,
    title: 'Тренировка Лизы',
    description: null,
    location: null,
    isAllDay: false,
    color: null,
    category: null,
    visibility: 'household',
    sourceKind: 'manual',
    attendees: [],
    myRsvp: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeShoppingItem(): ShoppingItemResponse {
  return {
    id: 'item-1',
    listId: 'list-1',
    name: 'Молоко',
    quantity: 2,
    unit: 'л',
    category: null,
    note: null,
    requestedById: ME_ID,
    state: 'needed',
    boughtById: null,
    boughtAt: null,
    isUrgent: true,
    sortOrder: 0,
    clientId: null,
    createdAt: '2026-08-19T06:00:00.000Z',
    updatedAt: '2026-08-19T06:00:00.000Z',
  };
}

function makeToday(overrides: Partial<DashboardTodayResponse> = {}): DashboardTodayResponse {
  return {
    date: '2026-08-19',
    timezone: 'Europe/Moscow',
    tasks: { mine: [makeTask()], overdue: [], unassigned: [], familyDoneToday: 2 },
    events: { today: [makeEvent()], tomorrow: [] },
    shopping: { urgent: [makeShoppingItem()], pendingCount: 7, listId: 'list-1' },
    goal: {
      goalId: 'goal-1',
      goalTitle: 'Поездка на море',
      currency: 'RUB',
      milestoneId: 'ms-1',
      milestoneTitle: 'Билеты',
      targetAmount: 5_000_000,
      currentAmount: 3_250_000,
      remainingAmount: 1_750_000,
      progressPercent: 65,
      deadline: '2026-12-01',
    },
    approvals: {
      pendingCount: 1,
      members: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          displayName: 'Лиза',
          avatarUrl: null,
          createdAt: '2026-08-18T20:00:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

const EMPTY_WEEK: DashboardWeekResponse = {
  from: '2026-08-17',
  to: '2026-08-23',
  timezone: 'Europe/Moscow',
  load: {
    userId: ME_ID,
    completed: 3,
    committed: 2,
    earned: 11,
    actualShare: 0.4,
    fairShare: 0.33,
  },
  familyTotal: 12,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface StubOptions {
  permissions?: Permission[];
  today?: DashboardTodayResponse;
  /** Status returned by the completion endpoint. */
  completeStatus?: number;
  /**
   * Holds the completion response until the test releases it. Without a gate
   * the mocked fetch settles in the same tick as the click and the optimistic
   * state is never observable — which would make the assertion below pass for
   * the wrong reason.
   */
  completeGate?: Promise<void>;
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
      if (url.includes('/api/me')) return Promise.resolve(jsonResponse(200, makeMe(permissions)));
      if (url.includes('/api/dashboard/today')) return Promise.resolve(jsonResponse(200, today));
      if (url.includes('/api/dashboard/week'))
        return Promise.resolve(jsonResponse(200, EMPTY_WEEK));
      if (url.includes('/complete')) {
        const response =
          completeStatus === 200
            ? jsonResponse(200, makeTask({ status: 'done' }))
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

    // The tasks widget proves the screen rendered at all.
    await screen.findByText(TODAY_RU.tasksTitle);

    // A child holds no `goal:*` permission (D4) — no goal card, no money.
    expect(screen.queryByText(TODAY_RU.goalTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(/Поездка на море/)).not.toBeInTheDocument();
    // …and no `member:approve`, so the approvals queue is invisible too.
    expect(screen.queryByText(TODAY_RU.approvalsTitle)).not.toBeInTheDocument();
  });

  it('shows the same widgets to a member who holds the permissions', async () => {
    stubApi({ permissions: ADULT_PERMISSIONS });
    renderToday();

    expect(await screen.findByText(TODAY_RU.goalTitle)).toBeInTheDocument();
    expect(screen.getByText(TODAY_RU.approvalsTitle)).toBeInTheDocument();
  });

  it('rolls the optimistic completion back and explains the failure in Russian', async () => {
    const gate = deferred();
    stubApi({ completeStatus: 500, completeGate: gate.promise });
    const user = userEvent.setup();
    renderToday();

    const tick = await screen.findByRole('button', {
      name: `${TODAY_RU.complete}: Вынести мусор`,
    });
    expect(tick).toHaveAttribute('aria-pressed', 'false');

    await user.click(tick);

    // Optimistic: the row reads as done before the server has answered.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: TODAY_RU.completed })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    // Let the request fail.
    gate.release();

    // Rolled back once the mutation fails.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: `${TODAY_RU.complete}: Вынести мусор` }),
      ).toHaveAttribute('aria-pressed', 'false');
    });

    // The user sees the mapped `ErrorCode`, never the server's English message.
    expect(toast.error).toHaveBeenCalledWith(TODAY_RU.completeErrorTitle, {
      description: ERROR_MESSAGES_RU.INTERNAL_ERROR,
    });
    expect(vi.mocked(toast.error).mock.calls.flat()).not.toContain('boom');
  });

  it('renders a warm empty state for a day with nothing on it', async () => {
    stubApi({
      today: makeToday({
        tasks: { mine: [], overdue: [], unassigned: [], familyDoneToday: 0 },
        events: { today: [], tomorrow: [] },
        shopping: { urgent: [], pendingCount: 0, listId: null },
        approvals: { pendingCount: 0, members: [] },
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
