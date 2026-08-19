import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { EventOccurrenceResponse, EventSeriesResponse, PublicUser } from '@family/shared';

/* -------------------------------------------------------------------------- */
/* API stub                                                                    */
/* -------------------------------------------------------------------------- */

const responses = new Map<string, unknown>();

vi.mock('@/shared/api/client', () => {
  const get = (path: string): Promise<unknown> => {
    if (responses.has(path)) return Promise.resolve(responses.get(path));
    return Promise.reject(new Error(`unstubbed GET ${path}`));
  };
  return {
    api: {
      get,
      post: () => Promise.resolve({}),
      patch: () => Promise.resolve({}),
      put: () => Promise.resolve({}),
      del: () => Promise.resolve(undefined),
    },
  };
});

import { setFamilyTimeZone } from '@/shared/lib/format';
import {
  birthdayAge,
  buildPreset,
  buildRecurrenceSpec,
  endDateKey,
  occurrenceDayKeys,
  startDateKey,
  type RecurrenceBuilderState,
} from './calendar-model';
import { AgendaList } from './components/AgendaList';
import { EventDetailSheet } from './components/EventDetailSheet';
import { RecurrenceBuilder } from './components/RecurrenceBuilder';
import CalendarPage from './pages/CalendarPage';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const TZ = 'Europe/Moscow';
const ME_ID = '11111111-1111-4111-8111-111111111111';
const ANNA_ID = '22222222-2222-4222-8222-222222222222';

const me = {
  id: ME_ID,
  email: 'me@example.com',
  displayName: 'Пётр',
  avatarUrl: null,
  role: 'adult',
  status: 'active',
  timezone: TZ,
  permissions: [
    'event:read',
    'event:create',
    'event:update:any',
    'event:delete:any',
    'member:read',
  ],
  providers: [],
  family: { name: 'Семья', timezone: TZ, currency: 'RUB', weekStartsOn: 1 },
};

const members: PublicUser[] = [
  {
    id: ME_ID,
    displayName: 'Пётр',
    avatarUrl: null,
    color: null,
    role: 'adult',
    status: 'active',
  },
  {
    id: ANNA_ID,
    displayName: 'Аня',
    avatarUrl: null,
    color: null,
    role: 'child',
    status: 'active',
  },
];

/**
 * An **all-day** event on 7 September 2026 in Europe/Moscow (UTC+3).
 *
 * The instants deliberately sit on 6 September and 7 September in UTC: any code
 * that reads `startsAt` through the device clock instead of `localDate` puts
 * this on the wrong day, which is exactly the bug this fixture exists to catch.
 */
const allDayOccurrence: EventOccurrenceResponse = {
  id: 'occ-all-day',
  seriesId: 'series-all-day',
  occurrenceKey: '2026-09-07T00:00:00',
  startsAt: '2026-09-06T21:00:00.000Z',
  endsAt: '2026-09-07T21:00:00.000Z',
  localDate: '2026-09-07',
  startsLocal: '2026-09-07T00:00:00',
  timezone: TZ,
  status: 'scheduled',
  isException: false,
  title: 'Поездка к бабушке',
  description: null,
  location: null,
  isAllDay: true,
  color: null,
  category: null,
  visibility: 'household',
  sourceKind: 'manual',
  attendees: [],
  myRsvp: null,
  createdAt: '2026-08-01T10:00:00.000Z',
};

const birthdayOccurrence: EventOccurrenceResponse = {
  ...allDayOccurrence,
  id: 'occ-birthday',
  seriesId: 'series-birthday',
  occurrenceKey: '2026-09-07T00:00:00',
  title: 'День рождения: Аня',
  sourceKind: 'user_birthday',
  attendees: [],
};

const timedOccurrence: EventOccurrenceResponse = {
  ...allDayOccurrence,
  id: 'occ-dinner',
  seriesId: 'series-dinner',
  occurrenceKey: '2026-09-08T19:00:00',
  startsAt: '2026-09-08T16:00:00.000Z',
  endsAt: '2026-09-08T18:00:00.000Z',
  localDate: '2026-09-08',
  startsLocal: '2026-09-08T19:00:00',
  title: 'Ужин',
  isAllDay: false,
  attendees: [{ userId: ME_ID, rsvp: 'pending', respondedAt: null }],
  myRsvp: 'pending',
};

function series(overrides: Partial<EventSeriesResponse> = {}): EventSeriesResponse {
  return {
    id: 'series-dinner',
    title: 'Ужин',
    description: null,
    location: null,
    visibility: 'household',
    createdById: ME_ID,
    recurrence: {
      rrule: null,
      dtstartLocal: '2026-09-08T19:00:00',
      timezone: TZ,
      rdatesLocal: [],
      exdatesLocal: [],
      seriesEndsAt: null,
      materializedThrough: null,
      preset: null,
      ends: null,
      summary: 'Не повторяется',
    },
    durationMinutes: 120,
    isAllDay: false,
    reminderOffsets: [],
    color: null,
    category: null,
    sourceKind: 'manual',
    isReadOnly: false,
    supersedesSeriesId: null,
    archivedAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

const birthdaySeries = series({
  id: 'series-birthday',
  title: 'День рождения: Аня',
  sourceKind: 'user_birthday',
  isReadOnly: true,
  isAllDay: true,
  recurrence: {
    rrule: 'FREQ=YEARLY',
    // Anchored at the birth year — the only place the age can come from.
    dtstartLocal: '2017-09-07T00:00:00',
    timezone: TZ,
    rdatesLocal: [],
    exdatesLocal: [],
    seriesEndsAt: null,
    materializedThrough: null,
    preset: null,
    ends: null,
    summary: 'Каждый год 7 сентября',
  },
});

const memberIndex = new Map(members.map((member) => [member.id, member]));
const birthdayAnchors = new Map([[birthdaySeries.id, birthdaySeries.recurrence.dtstartLocal]]);

function wrapper(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  setFamilyTimeZone(TZ);
  responses.clear();
  responses.set('/me', me);
  responses.set('/members', members);
  responses.set('/events/calendar', [allDayOccurrence, timedOccurrence]);
  responses.set('/events/series', [birthdaySeries]);
  responses.set('/events/feed', { url: 'https://family.example/api/events/feed.ics?token=abc' });
  window.localStorage.clear();
});

/* -------------------------------------------------------------------------- */
/* 1. All-day events do not shift a day                                       */
/* -------------------------------------------------------------------------- */

describe('all-day time correctness (D2)', () => {
  it('keeps an all-day event on its local date, not the UTC instant date', () => {
    // `startsAt` is 2026-09-06T21:00Z — the naive read lands on the 6th.
    expect(startDateKey(allDayOccurrence)).toBe('2026-09-07');
    expect(occurrenceDayKeys(allDayOccurrence, TZ)).toEqual(['2026-09-07']);
  });

  it('treats an end at local midnight as the exclusive boundary of the day before', () => {
    // 2026-09-07T21:00Z is 2026-09-08T00:00 in Moscow: the event must not paint
    // the 8th.
    expect(endDateKey(allDayOccurrence, TZ)).toBe('2026-09-07');
  });

  it('renders the all-day event under its own date heading in the agenda', async () => {
    render(
      wrapper(
        <AgendaList
          occurrences={[allDayOccurrence]}
          members={memberIndex}
          birthdayAnchors={birthdayAnchors}
          timeZone={TZ}
          onSelect={() => undefined}
        />,
      ),
    );

    const heading = await screen.findByRole('heading', { name: /7 сентября/ });
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getByText('Поездка к бабушке')).toBeInTheDocument();
    // No clock for an all-day event — «00:00» is how it starts drifting.
    expect(within(section as HTMLElement).getByText('Весь день')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /6 сентября/ })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The agenda is the default on a phone                                    */
/* -------------------------------------------------------------------------- */

describe('default view', () => {
  it('defaults to the agenda at a phone viewport', async () => {
    window.innerWidth = 390;

    render(wrapper(<CalendarPage />));

    expect(await screen.findByTestId('agenda-list')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Список/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryAllByTestId('month-cell')).toHaveLength(0);
  });

  it('defaults to the month grid on a desktop viewport', async () => {
    window.innerWidth = 1280;

    render(wrapper(<CalendarPage />));

    await waitFor(() => {
      expect(screen.getAllByTestId('month-cell').length).toBeGreaterThan(27);
    });
    expect(screen.getByRole('radio', { name: /Месяц/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('remembers an explicit choice across mounts', async () => {
    window.innerWidth = 390;
    const user = userEvent.setup();

    const { unmount } = render(wrapper(<CalendarPage />));
    await screen.findByTestId('agenda-list');
    await user.click(screen.getByRole('radio', { name: /Месяц/ }));
    unmount();

    render(wrapper(<CalendarPage />));
    await waitFor(() => {
      expect(screen.getAllByTestId('month-cell').length).toBeGreaterThan(27);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The edit-scope prompt is for recurring events only                      */
/* -------------------------------------------------------------------------- */

describe('edit-scope prompt', () => {
  function renderDetail(seriesResponse: EventSeriesResponse) {
    responses.set(`/events/series/${seriesResponse.id}`, seriesResponse);
    return render(
      wrapper(
        <EventDetailSheet
          occurrence={timedOccurrence}
          open
          onOpenChange={() => undefined}
          members={memberIndex}
          birthdayAnchors={birthdayAnchors}
          timeZone={TZ}
          onEdit={() => undefined}
        />,
      ),
    );
  }

  it('asks «Только это / Это и последующие / Все» for a recurring series', async () => {
    const user = userEvent.setup();
    renderDetail(
      series({
        recurrence: {
          ...series().recurrence,
          rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
          preset: { kind: 'weekly', interval: 1, weekdays: ['TU'] },
          ends: { type: 'never' },
          summary: 'Каждый вторник',
        },
      }),
    );

    await user.click(await screen.findByRole('button', { name: /Удалить/ }));

    const dialog = await screen.findByTestId('edit-scope-dialog');
    expect(within(dialog).getByRole('radio', { name: /Только это/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Это и последующие/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /^Все/ })).toBeInTheDocument();
  });

  it('does not ask for a one-off event', async () => {
    const user = userEvent.setup();
    renderDetail(series());

    await user.click(await screen.findByRole('button', { name: /Удалить/ }));

    expect(await screen.findByText('Удалить событие?')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-scope-dialog')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Birthdays: generated, non-editable, with the age                        */
/* -------------------------------------------------------------------------- */

describe('birthdays', () => {
  it('computes the age from the series birth-year anchor', () => {
    expect(birthdayAge('2026-09-07T00:00:00', '2017-09-07T00:00:00')).toBe(9);
    // No birth year on file: the job anchors at the current year, so there is
    // no age to show and we must not show "0".
    expect(birthdayAge('2026-09-07T00:00:00', '2026-09-07T00:00:00')).toBeNull();
  });

  it('renders the age and offers no edit or delete', async () => {
    responses.set(`/events/series/${birthdaySeries.id}`, birthdaySeries);

    render(
      wrapper(
        <EventDetailSheet
          occurrence={birthdayOccurrence}
          open
          onOpenChange={() => undefined}
          members={memberIndex}
          birthdayAnchors={birthdayAnchors}
          timeZone={TZ}
          onEdit={() => undefined}
        />,
      ),
    );

    const detail = await screen.findByTestId('event-detail');
    expect(within(detail).getByTestId('birthday-age')).toHaveTextContent('исполняется 9');
    expect(
      within(detail).getByText(/Дата рождения меняется в профиле участника/),
    ).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: /Изменить/ })).toBeNull();
    expect(within(detail).queryByRole('button', { name: /Удалить/ })).toBeNull();
  });

  it('marks a birthday row as a generated source in lists', async () => {
    render(
      wrapper(
        <AgendaList
          occurrences={[birthdayOccurrence]}
          members={memberIndex}
          birthdayAnchors={birthdayAnchors}
          timeZone={TZ}
          onSelect={() => undefined}
        />,
      ),
    );

    const row = await screen.findByTestId('event-row');
    expect(row).toHaveAttribute('data-source-kind', 'user_birthday');
    expect(within(row).getByTestId('birthday-age')).toHaveTextContent('исполняется 9');
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The restricted recurrence grammar                                       */
/* -------------------------------------------------------------------------- */

describe('recurrence builder grammar', () => {
  const base: RecurrenceBuilderState = {
    arm: 'once',
    interval: 3,
    weekdays: ['TU', 'MO'],
    dayOfMonth: 15,
    ends: { type: 'never' },
  };

  it('emits the right preset for every arm', () => {
    expect(buildPreset({ ...base, arm: 'once' })).toBeNull();

    expect(buildPreset({ ...base, arm: 'daily' })).toEqual({ kind: 'daily', interval: 3 });

    // "По дням недели" is weekly with interval 1 — the weekdays carry the rule,
    // and they come back in RFC 5545 order regardless of click order.
    expect(buildPreset({ ...base, arm: 'weekly' })).toEqual({
      kind: 'weekly',
      interval: 1,
      weekdays: ['MO', 'TU'],
    });

    expect(buildPreset({ ...base, arm: 'weekly_interval' })).toEqual({
      kind: 'weekly',
      interval: 3,
      weekdays: ['MO', 'TU'],
    });

    expect(buildPreset({ ...base, arm: 'monthly_day' })).toEqual({
      kind: 'monthly_day',
      interval: 3,
      dayOfMonth: 15,
    });

    expect(buildPreset({ ...base, arm: 'monthly_last_day' })).toEqual({
      kind: 'monthly_last_day',
      interval: 3,
    });
  });

  it('clamps an out-of-range interval and day rather than emitting an invalid rule', () => {
    expect(buildPreset({ ...base, arm: 'daily', interval: 0 })).toEqual({
      kind: 'daily',
      interval: 1,
    });
    expect(buildPreset({ ...base, arm: 'monthly_day', dayOfMonth: 99 })).toEqual({
      kind: 'monthly_day',
      interval: 3,
      dayOfMonth: 31,
    });
  });

  it('wraps a one-off as `mode: once` and a preset with its `ends`', () => {
    const anchor = { dtstartLocal: '2026-09-07T09:00:00', timezone: TZ };

    expect(buildRecurrenceSpec({ ...base, arm: 'once' }, anchor)).toEqual({
      mode: 'once',
      dtstartLocal: '2026-09-07T09:00:00',
      timezone: TZ,
      rdatesLocal: [],
      exdatesLocal: [],
    });

    expect(
      buildRecurrenceSpec({ ...base, arm: 'weekly', ends: { type: 'after', count: 8 } }, anchor),
    ).toEqual({
      mode: 'preset',
      preset: { kind: 'weekly', interval: 1, weekdays: ['MO', 'TU'] },
      ends: { type: 'after', count: 8 },
      dtstartLocal: '2026-09-07T09:00:00',
      timezone: TZ,
      rdatesLocal: [],
      exdatesLocal: [],
    });
  });

  it('switches arm from the UI and never exposes a raw RRULE field', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<RecurrenceBuilder value={{ ...base, arm: 'once' }} onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'По дням недели' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ arm: 'weekly', interval: 1 }));

    expect(screen.queryByLabelText(/RRULE/i)).toBeNull();
    expect(screen.getByRole('radio', { name: 'Последний день месяца' })).toBeInTheDocument();
  });
});
