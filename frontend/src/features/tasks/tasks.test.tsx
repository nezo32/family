import { useState, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Permission,
  RecurrenceView,
  TaskOccurrenceResponse,
  TaskSeriesResponse,
} from '@family/shared';

/**
 * The five rules of this feature that are expensive to get wrong:
 *
 *  1. the builder can only ever emit the restricted grammar,
 *  2. a rule outside that grammar is never silently rewritten,
 *  3. a recurring edit always asks which instances it touches,
 *  4. an optimistic completion that fails puts the tick back,
 *  5. assignee controls are gated by a permission, not by a role.
 */

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));

vi.mock('@/shared/api/client', () => ({ api: apiMock }));

import { ApiError } from '@/shared/api/errors';
import TaskDetailPage from './pages/TaskDetailPage';
import { RecurrenceBuilder } from './components/RecurrenceBuilder';
import { ScheduleRepeatRow } from './components/ScheduleField';
import { TaskEditor } from './components/TaskEditor';
import { AssigneeControl } from './components/AssigneeControl';
import { ReminderSheet, reminderSummary } from './components/ReminderField';
import { useCompleteOccurrence } from './hooks';
import { makeMe } from '@/test/me';
import { taskKeys } from './api';
import { ONCE, type ScheduleValue } from './recurrence';

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const ME_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const OCCURRENCE_ID = '33333333-3333-4333-8333-333333333333';
const SERIES_ID = '44444444-4444-4444-8444-444444444444';

const DTSTART = '2026-09-08T09:00:00'; // a Tuesday

function me(permissions: Permission[]) {
  return makeMe({ id: ME_ID, email: null, displayName: 'Аня', permissions });
}

function occurrence(overrides: Partial<TaskOccurrenceResponse> = {}): TaskOccurrenceResponse {
  return {
    id: OCCURRENCE_ID,
    seriesId: SERIES_ID,
    occurrenceKey: DTSTART,
    startsAt: '2026-09-08T06:00:00.000Z',
    dueAt: '2026-09-08T18:00:00.000Z',
    localDate: '2026-09-08',
    startsLocal: DTSTART,
    timezone: 'Europe/Moscow',
    status: 'scheduled',
    isException: false,
    isOverdue: false,
    title: 'Вынести мусор',
    notes: null,
    category: 'Уборка',
    visibility: 'household',
    assigneeId: ME_ID,
    assignedVia: 'rotation',
    completedById: null,
    completedAt: null,
    skippedById: null,
    skipReason: null,
    pendingSwapId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function recurrenceView(overrides: Partial<RecurrenceView> = {}): RecurrenceView {
  return {
    rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
    dtstartLocal: DTSTART,
    timezone: 'Europe/Moscow',
    rdatesLocal: [],
    exdatesLocal: [],
    seriesEndsAt: null,
    materializedThrough: null,
    preset: { kind: 'weekly', interval: 1, weekdays: ['TU'] },
    ends: { type: 'never' },
    summary: 'Каждый вторник, 09:00',
    ...overrides,
  };
}

function series(overrides: Partial<TaskSeriesResponse> = {}): TaskSeriesResponse {
  return {
    id: SERIES_ID,
    title: 'Вынести мусор',
    notes: null,
    visibility: 'household',
    createdById: ME_ID,
    recurrence: recurrenceView(),
    dueOffsetMinutes: 0,
    graceMinutes: 0,
    rotationId: null,
    defaultAssigneeId: ME_ID,
    category: 'Уборка',
    autoCancelAfterDays: null,
    reminderOffsets: [],
    supersedesSeriesId: null,
    archivedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper(props: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>;
  };
}

/** Answers `/me` with the given permission list; everything else 404s loudly. */
function stubMe(permissions: Permission[]): void {
  apiMock.get.mockImplementation((path: string) => {
    if (path === '/me') return Promise.resolve(me(permissions));
    if (path === '/members') return Promise.resolve([]);
    return Promise.reject(new ApiError({ code: 'NOT_FOUND', status: 404 }));
  });
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.patch.mockReset();
  apiMock.del.mockReset();
  stubMe(['task:read:any', 'task:create', 'task:update:any', 'task:complete:any']);
});

/* -------------------------------------------------------------------------- */
/* 1. the restricted grammar                                                   */
/* -------------------------------------------------------------------------- */

function BuilderHarness(props: { onChange: (value: ScheduleValue) => void }) {
  const [value, setValue] = useState<ScheduleValue>(ONCE);
  return (
    <RecurrenceBuilder
      value={value}
      dtstartLocal={DTSTART}
      onChange={(next) => {
        setValue(next);
        props.onChange(next);
      }}
    />
  );
}

describe('recurrence builder', () => {
  it('emits the matching preset object for every arm of the grammar', () => {
    const onChange = vi.fn<(value: ScheduleValue) => void>();
    render(<BuilderHarness onChange={onChange} />);
    const last = (): ScheduleValue => onChange.mock.calls.at(-1)?.[0] as ScheduleValue;

    // ежедневно
    fireEvent.click(screen.getByRole('radio', { name: 'Ежедневно' }));
    expect(last()).toEqual({
      mode: 'preset',
      preset: { kind: 'daily', interval: 1 },
      ends: { type: 'never' },
    });

    // каждые N дней
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
    expect(last()).toEqual({
      mode: 'preset',
      preset: { kind: 'daily', interval: 3 },
      ends: { type: 'never' },
    });

    // по дням недели — seeded from the anchor weekday (2026-09-08 is Tuesday)
    fireEvent.click(screen.getByRole('radio', { name: 'По дням недели' }));
    expect(last()).toEqual({
      mode: 'preset',
      preset: { kind: 'weekly', interval: 1, weekdays: ['TU'] },
      ends: { type: 'never' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'четверг' }));
    expect(last()).toEqual({
      mode: 'preset',
      preset: { kind: 'weekly', interval: 1, weekdays: ['TU', 'TH'] },
      ends: { type: 'never' },
    });

    // раз в N недель is the same arm with an interval — no second preset kind
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } });
    expect(last()).toEqual({
      mode: 'preset',
      preset: { kind: 'weekly', interval: 2, weekdays: ['TU', 'TH'] },
      ends: { type: 'never' },
    });

    // N-е число месяца
    fireEvent.click(screen.getByRole('radio', { name: 'Число месяца' }));
    expect(last()).toEqual({
      mode: 'preset',
      preset: { kind: 'monthly_day', interval: 1, dayOfMonth: 8 },
      ends: { type: 'never' },
    });

    const [, dayOfMonth] = screen.getAllByRole('spinbutton');
    fireEvent.change(dayOfMonth as HTMLElement, { target: { value: '15' } });
    expect(last()).toEqual({
      mode: 'preset',
      preset: { kind: 'monthly_day', interval: 1, dayOfMonth: 15 },
      ends: { type: 'never' },
    });

    // последний день месяца — the steer away from BYMONTHDAY=31
    fireEvent.click(screen.getByRole('radio', { name: 'Последний день месяца' }));
    expect(last()).toEqual({
      mode: 'preset',
      preset: { kind: 'monthly_last_day', interval: 1 },
      ends: { type: 'never' },
    });

    // ends
    fireEvent.click(screen.getByRole('radio', { name: 'После' }));
    expect(last()).toEqual({
      mode: 'preset',
      preset: { kind: 'monthly_last_day', interval: 1 },
      ends: { type: 'after', count: 10 },
    });

    // and back to a one-off
    fireEvent.click(screen.getByRole('radio', { name: 'Не повторяется' }));
    expect(last()).toEqual({ mode: 'once' });
  });

  it('offers no free-text rule field', () => {
    render(<BuilderHarness onChange={vi.fn()} />);
    for (const input of screen.queryAllByRole('textbox')) {
      expect(input).not.toHaveValue(expect.stringContaining('FREQ='));
    }
    expect(screen.queryByText(/RRULE/i)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. rules outside the grammar                                                */
/* -------------------------------------------------------------------------- */

function ScheduleHarness(props: { view: RecurrenceView }) {
  const [value, setValue] = useState<ScheduleValue>(ONCE);
  return (
    <ScheduleRepeatRow dtstartLocal={DTSTART} value={value} onChange={setValue} view={props.view} />
  );
}

/** The builder now lives behind «Повторение ›» (§F5), so tests open it first. */
function openRecurrenceSheet(): void {
  fireEvent.click(screen.getByRole('button', { name: /Повторение/ }));
}

describe('a rule that does not decompile', () => {
  const imported = recurrenceView({
    rrule: 'FREQ=MONTHLY;BYDAY=2FR',
    preset: null,
    ends: null,
    summary: 'Каждую вторую пятницу месяца',
  });

  it('is read-only, shown by its Russian summary, and only offers a replacement', () => {
    render(<ScheduleHarness view={imported} />);

    expect(screen.getByText('Каждую вторую пятницу месяца')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Заменить расписание' })).toBeInTheDocument();
    // The builder is absent — nothing here can rewrite the imported rule.
    expect(screen.queryByRole('radio', { name: 'Ежедневно' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'По дням недели' })).toBeNull();
  });

  it('reveals the builder only after an explicit «Заменить расписание»', () => {
    render(<ScheduleHarness view={imported} />);
    fireEvent.click(screen.getByRole('button', { name: 'Заменить расписание' }));
    openRecurrenceSheet();
    expect(screen.getByRole('radio', { name: 'Ежедневно' })).toBeInTheDocument();
  });

  it('still builds normally for a rule that does decompile', () => {
    render(<ScheduleHarness view={recurrenceView()} />);
    // The row states the rule in words and offers no replacement…
    expect(screen.queryByRole('button', { name: 'Заменить расписание' })).toBeNull();
    // …and the full grammar is one tap away, not gone.
    openRecurrenceSheet();
    expect(screen.getByRole('radio', { name: 'По дням недели' })).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. the edit-scope prompt                                                    */
/* -------------------------------------------------------------------------- */

describe('edit scope prompt', () => {
  it('asks which instances are affected before editing a recurring occurrence', async () => {
    const client = makeClient();
    render(
      <TaskEditor
        open
        onOpenChange={vi.fn()}
        series={series()}
        occurrence={occurrence()}
        members={[]}
      />,
      { wrapper: wrapperFor(client) },
    );

    expect(await screen.findByText('Что изменить?')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Только это/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Это и последующие/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Все/ })).toBeInTheDocument();

    // Nothing is preselected: «Продолжить» must not be reachable by a mis-tap.
    expect(screen.getByRole('button', { name: 'Продолжить' })).toBeDisabled();
    // The form itself is not on screen yet.
    expect(screen.queryByLabelText('Что нужно сделать')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /Только это/ }));
    expect(screen.getByRole('button', { name: 'Продолжить' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));

    expect(await screen.findByLabelText('Что нужно сделать')).toBeInTheDocument();
  });

  it('does not ask for a one-off task', async () => {
    const client = makeClient();
    render(
      <TaskEditor
        open
        onOpenChange={vi.fn()}
        series={series({ recurrence: recurrenceView({ rrule: null, preset: null, ends: null }) })}
        occurrence={occurrence()}
        members={[]}
      />,
      { wrapper: wrapperFor(client) },
    );

    expect(await screen.findByLabelText('Что нужно сделать')).toBeInTheDocument();
    expect(screen.queryByText('Что изменить?')).toBeNull();
    expect(screen.queryByRole('radio', { name: /Это и последующие/ })).toBeNull();
  });

  it('does not ask when creating a new task', async () => {
    const client = makeClient();
    render(<TaskEditor open onOpenChange={vi.fn()} members={[]} />, {
      wrapper: wrapperFor(client),
    });

    expect(await screen.findByLabelText('Что нужно сделать')).toBeInTheDocument();
    expect(screen.queryByText('Что изменить?')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. optimistic completion                                                    */
/* -------------------------------------------------------------------------- */

describe('one-tap completion', () => {
  const filters = { from: '2026-09-01', to: '2026-09-30' };

  it('rolls the list back when the request fails', async () => {
    const client = makeClient();
    client.setQueryData(taskKeys.list(filters), {
      items: [occurrence()],
      nextCursor: null,
    });

    let rejectRequest: (error: unknown) => void = () => undefined;
    apiMock.post.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );

    const { result } = renderHook(() => useCompleteOccurrence(), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current.mutate({ occurrenceId: OCCURRENCE_ID });
    });

    const statusNow = (): string | undefined =>
      client.getQueryData<{ items: TaskOccurrenceResponse[] }>(taskKeys.list(filters))?.items[0]
        ?.status;

    // Optimistic: the tick lands before the network does.
    await waitFor(() => {
      expect(statusNow()).toBe('done');
    });

    act(() => {
      rejectRequest(new ApiError({ code: 'CONFLICT', status: 409 }));
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    // …and is taken back, because a chore that only *looks* done is worse than
    // one that visibly failed.
    expect(statusNow()).toBe('scheduled');
    expect(
      client.getQueryData<{ items: TaskOccurrenceResponse[] }>(taskKeys.list(filters))?.items[0]
        ?.completedAt,
    ).toBeNull();
  });

  it('keeps the optimistic state when the request succeeds', async () => {
    const client = makeClient();
    client.setQueryData(taskKeys.list(filters), { items: [occurrence()], nextCursor: null });
    apiMock.post.mockResolvedValueOnce(occurrence({ status: 'done' }));

    const { result } = renderHook(() => useCompleteOccurrence(), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current.mutate({ occurrenceId: OCCURRENCE_ID });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(
      client.getQueryData<{ items: TaskOccurrenceResponse[] }>(taskKeys.list(filters))?.items[0]
        ?.status,
    ).toBe('done');
  });
});

/* -------------------------------------------------------------------------- */
/* 5. permission-gated assignee controls                                       */
/* -------------------------------------------------------------------------- */

describe('assignee controls', () => {
  const roster = [
    {
      id: OTHER_ID,
      displayName: 'Миша',
      avatarUrl: null,
      color: null,
      role: 'teen' as const,
      status: 'active' as const,
    },
  ];

  it('are hidden from a member without task:assign:any', async () => {
    stubMe(['task:read:own', 'task:complete:own', 'task:update:own']);
    const client = makeClient();

    render(<AssigneeControl occurrence={occurrence({ assigneeId: OTHER_ID })} members={roster} />, {
      wrapper: wrapperFor(client),
    });

    expect(await screen.findByText('Миша')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Сменить исполнителя/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Назначить/ })).toBeNull();
  });

  it('are shown to a member who holds task:assign:any', async () => {
    stubMe(['task:read:any', 'task:assign:any', 'task:complete:any']);
    const client = makeClient();

    render(<AssigneeControl occurrence={occurrence({ assigneeId: OTHER_ID })} members={roster} />, {
      wrapper: wrapperFor(client),
    });

    expect(await screen.findByRole('button', { name: /Сменить исполнителя/ })).toBeInTheDocument();
  });

  it('offers the unassigned chore to whoever may complete it', async () => {
    stubMe(['task:read:own', 'task:complete:own']);
    const client = makeClient();

    render(<AssigneeControl occurrence={occurrence({ assigneeId: null })} members={roster} />, {
      wrapper: wrapperFor(client),
    });

    expect(await screen.findByRole('button', { name: 'Возьму на себя' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Назначить/ })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* reminders                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The row states the plan in words and the sheet never offers a way to switch
 * the at-start notification off — those two together are the whole of «нужно
 * добавить напоминания … и обязательное оповещение прям во время начала дела»
 * as far as the client is concerned.
 */
describe('reminders', () => {
  it('says what will happen when nothing has been chosen', () => {
    // Not «—». An empty offsets array does not mean "no reminder": the at-start
    // one is not in the array and is never off.
    expect(reminderSummary([])).toBe('В момент начала');
  });

  it('reads two leads as one phrase, furthest first', () => {
    expect(reminderSummary([1440, 60])).toBe('За день и за час');
  });

  it('stops being a phrase and becomes a count past two', () => {
    expect(reminderSummary([10080, 1440, 60])).toBe('Напоминаний: 3');
  });

  function ReminderHarness({ initial = [] as number[] }) {
    const [value, setValue] = useState<number[]>(initial);
    return <ReminderSheet open onOpenChange={() => undefined} value={value} onChange={setValue} />;
  }

  it('offers no control at all for the at-start notification', () => {
    render(<ReminderHarness />);

    // It is stated, so nobody has to wonder whether it is on…
    expect(screen.getByText('В момент начала')).toBeInTheDocument();
    expect(screen.getByText('Всегда')).toBeInTheDocument();

    // …and every checkbox in the sheet is a lead time, none of them it. A
    // checkbox that cannot be unchecked invites a tap and then refuses it.
    const toggles = screen.getAllByRole('checkbox');
    expect(toggles).toHaveLength(8);
    for (const toggle of toggles) {
      expect(toggle.textContent).not.toBe('В момент начала');
    }
  });

  it('toggles a lead time on and off without disturbing the others', () => {
    render(<ReminderHarness initial={[1440]} />);

    const day = screen.getByRole('checkbox', { name: 'За день' });
    const hour = screen.getByRole('checkbox', { name: 'За час' });
    expect(day).toHaveAttribute('aria-checked', 'true');
    expect(hour).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(hour);
    expect(screen.getByRole('checkbox', { name: 'За час' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('checkbox', { name: 'За день' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'За день' }));
    expect(screen.getByRole('checkbox', { name: 'За день' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('checkbox', { name: 'За час' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('stops at five, and lets the five already chosen be undone', () => {
    // The cap mirrors `taskSeriesCreateSchema.reminderOffsets.max(5)`; without
    // it the form would let the user compose a body the server rejects.
    render(<ReminderHarness initial={[10080, 2880, 1440, 360, 180]} />);

    expect(screen.getByRole('checkbox', { name: 'За час' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'За день' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'За день' }));
    expect(screen.getByRole('checkbox', { name: 'За час' })).not.toBeDisabled();
  });

  it('groups the toggles as a group, never as a radiogroup', () => {
    // Announcing independent leads as radios would tell a screen-reader user
    // that picking «за день» drops «за час».
    render(<ReminderHarness />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getAllByRole('group').length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. the detail page follows the occurrence it was standing on                */
/* -------------------------------------------------------------------------- */

const SUCCESSOR_SERIES_ID = '55555555-5555-4555-8555-555555555555';
const SUCCESSOR_OCCURRENCE_ID = '66666666-6666-4666-8666-666666666666';

/**
 * A save can legitimately retire the row the detail page is routed by: a
 * `this_and_future` split moves that date to a successor series, and a schedule
 * change can drop the date entirely. Neither may end on «Задача не найдена» —
 * that screen means "deleted, or not yours", and this is neither.
 */
function renderDetail(client: QueryClient) {
  return render(
    <MemoryRouter initialEntries={[`/tasks/${OCCURRENCE_ID}`]}>
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
        <Route path="/tasks" element={<div>Список дел</div>} />
      </Routes>
    </MemoryRouter>,
    { wrapper: wrapperFor(client) },
  );
}

/** Answers everything the detail page reads; `sameDate` is the post-save lookup. */
function stubDetail(sameDate: TaskOccurrenceResponse[]): void {
  apiMock.get.mockImplementation((path: string, init?: { query?: Record<string, unknown> }) => {
    if (path === '/me') {
      return Promise.resolve(me(['task:read:any', 'task:update:any', 'task:complete:any']));
    }
    if (path === '/members') return Promise.resolve([]);
    if (path === '/chores/swaps') return Promise.resolve({ items: [], nextCursor: null });
    if (path === `/tasks/occurrences/${OCCURRENCE_ID}`) return Promise.resolve(occurrence());
    if (path === `/tasks/series/${SERIES_ID}`) return Promise.resolve(series());
    if (path === '/tasks/occurrences' && init?.query?.seriesId !== undefined) {
      return Promise.resolve({ items: sameDate, nextCursor: null });
    }
    return Promise.reject(new ApiError({ code: 'NOT_FOUND', status: 404 }));
  });
}

/** Открыть «Изменить» → выбрать «Все» → «Сохранить». */
async function saveWholeSeries(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
  fireEvent.click(await screen.findByRole('radio', { name: /^Все/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Продолжить' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }));
}

describe('detail page after a save', () => {
  it('follows the date to the successor a split created', async () => {
    stubDetail([occurrence({ id: SUCCESSOR_OCCURRENCE_ID, seriesId: SUCCESSOR_SERIES_ID })]);
    apiMock.patch.mockResolvedValue(series({ id: SUCCESSOR_SERIES_ID }));

    renderDetail(makeClient());
    await saveWholeSeries();

    // The old id no longer resolves, so the page moves to the row that
    // replaced it rather than refetching a 404.
    await waitFor(() => {
      const asked = apiMock.get.mock.calls.some(
        ([path]) => path === `/tasks/occurrences/${SUCCESSOR_OCCURRENCE_ID}`,
      );
      expect(asked).toBe(true);
    });
  });

  it('says the date left the schedule instead of claiming the task is missing', async () => {
    stubDetail([]);
    apiMock.patch.mockResolvedValue(series());

    renderDetail(makeClient());
    await saveWholeSeries();

    // Header and error state both carry it, hence `findAll`.
    expect(await screen.findAllByText('Этой даты больше нет в расписании')).not.toHaveLength(0);
    expect(screen.queryByText('Задача не найдена')).toBeNull();
  });

  it('stays put when the save left the occurrence where it was', async () => {
    stubDetail([occurrence()]);
    apiMock.patch.mockResolvedValue(series());

    renderDetail(makeClient());
    await saveWholeSeries();

    await waitFor(() => {
      expect(screen.queryByText('Этой даты больше нет в расписании')).toBeNull();
    });
    expect(await screen.findByRole('button', { name: 'Изменить' })).toBeInTheDocument();
  });
});
