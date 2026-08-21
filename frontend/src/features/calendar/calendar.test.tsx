import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { EventOccurrenceResponse, EventSeriesResponse, PublicUser } from '@family/shared';

/* -------------------------------------------------------------------------- */
/* API stub                                                                    */
/* -------------------------------------------------------------------------- */

const responses = new Map<string, unknown>();

vi.mock('@/shared/api/client', () => {
  const get = (path: string): Promise<unknown> => {
    if (responses.has(path)) {
      const value = responses.get(path);
      // A stubbed `Error` is a stubbed *failure* — the only way to exercise the
      // screens a 404 is supposed to produce.
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    return Promise.reject(new Error(`unstubbed GET ${path}`));
  };
  // `PATCH <path>` in the same map: a series update answers with the series the
  // server chose, which for a `this_and_future` edit is a *different* one.
  const patch = (path: string): Promise<unknown> =>
    Promise.resolve(responses.has(`PATCH ${path}`) ? responses.get(`PATCH ${path}`) : {});
  return {
    api: {
      get,
      post: () => Promise.resolve({}),
      patch,
      put: () => Promise.resolve({}),
      del: () => Promise.resolve(undefined),
    },
  };
});

import { makeMe } from '@/test/me';
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
import EventDetailPage from './pages/EventDetailPage';
import { ApiError } from '@/shared/api/errors';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const TZ = 'Europe/Moscow';
const ME_ID = '11111111-1111-4111-8111-111111111111';
const ANNA_ID = '22222222-2222-4222-8222-222222222222';

const me = makeMe({
  id: ME_ID,
  email: 'me@example.com',
  displayName: 'Пётр',
  timezone: TZ,
  permissions: [
    'event:read',
    'event:create',
    'event:update:any',
    'event:delete:any',
    'member:read',
  ],
  family: { timezone: TZ },
});

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

/* -------------------------------------------------------------------------- */
/* 6. The event detail page — the only route a notification can reach          */
/* -------------------------------------------------------------------------- */

/*
 * `/calendar/:eventId` has no link anywhere in the UI: the calendar opens a
 * sheet instead of navigating. A push notification is the only way in, which
 * makes this the one detail route that can rot for a whole release with nobody
 * noticing — and it did, for the life of the feature. These tests stand in for
 * the human who never visits it.
 */

const SEP_08 = 'occ-sep-08';
const SEP_15 = 'occ-sep-15';
const SEP_22 = 'occ-sep-22';

function occurrenceOn(id: string, localDate: string, title: string): EventOccurrenceResponse {
  return {
    ...timedOccurrence,
    id,
    title,
    localDate,
    occurrenceKey: `${localDate}T19:00:00`,
    startsLocal: `${localDate}T19:00:00`,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderEventDetail(path: string) {
  return render(
    wrapper(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/calendar/:eventId" element={<EventDetailPage />} />
          <Route path="/calendar" element={<div>Календарь</div>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

describe('event detail page', () => {
  beforeEach(() => {
    responses.set('/events/series/series-dinner', series());
    responses.set('/events/occurrences', [
      occurrenceOn(SEP_08, '2026-09-08', 'Ужин восьмого'),
      occurrenceOn(SEP_15, '2026-09-15', 'Ужин пятнадцатого'),
    ]);
  });

  it('marks the date the reminder was about', async () => {
    // The whole reason `?date=` exists. The path can only name the series, so
    // without it the reader of «Скоро событие» arrives at a list of dates with
    // no indication which one they were just told about.
    const { container } = renderEventDetail('/calendar/series-dinner?date=2026-09-15');

    expect(await screen.findByTestId('reminded-date')).toHaveTextContent(
      'Напоминание: 15 сентября 2026 г.',
    );
    const marked = container.querySelectorAll('[data-reminded="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent('Ужин пятнадцатого');
  });

  it('renders without a reminded date at all', async () => {
    renderEventDetail('/calendar/series-dinner');

    expect(await screen.findByText('Ужин восьмого')).toBeInTheDocument();
    expect(screen.queryByTestId('reminded-date')).toBeNull();
  });

  it('ignores a date the URL made up', async () => {
    // The param is typed by anybody. Anything that is not a date key is absent.
    renderEventDetail('/calendar/series-dinner?date=завтра');

    expect(await screen.findByText('Ужин восьмого')).toBeInTheDocument();
    expect(screen.queryByTestId('reminded-date')).toBeNull();
  });

  it('says so when the reminded date has left the schedule', async () => {
    // The successor of a «это и последующие» edit need not contain the date the
    // reader arrived on. The window below straddles 15 сентября without
    // containing it, which is the only evidence that proves the date is gone.
    responses.set('/events/occurrences', [
      occurrenceOn(SEP_08, '2026-09-08', 'Ужин восьмого'),
      occurrenceOn(SEP_22, '2026-09-22', 'Ужин двадцать второго'),
    ]);

    const { container } = renderEventDetail('/calendar/series-dinner?date=2026-09-15');

    expect(await screen.findByTestId('reminded-date')).toHaveTextContent(
      'Этой даты больше нет в расписании',
    );
    expect(container.querySelectorAll('[data-reminded="true"]')).toHaveLength(0);
  });

  it('does not accuse a date the loaded window never covered', async () => {
    // `/events/occurrences` answers a bounded from-today window. A date beyond
    // its last row may be perfectly real and simply further out than the 25
    // rows we asked for, so the page must not claim it was rescheduled.
    renderEventDetail('/calendar/series-dinner?date=2026-12-01');

    expect(await screen.findByTestId('reminded-date')).toHaveTextContent(
      'Напоминание: 1 декабря 2026 г.',
    );
  });

  it('answers a link whose series is gone with «не найдено», not an error', async () => {
    /*
     * Inbox rows outlive the rows they point at: `notification_intents.
     * entity_id` has no foreign key and nothing sweeps the inbox, so a push
     * sent last week can name a series deleted since. That is an outcome, not a
     * failure, and it must not arrive as the red alert card with a «Повторить»
     * that can never succeed.
     */
    responses.set('/events/series/series-gone', new ApiError({ code: 'NOT_FOUND', status: 404 }));

    renderEventDetail('/calendar/series-gone?date=2026-09-15');

    expect(await screen.findByText('Событие не найдено')).toBeInTheDocument();
    expect(screen.queryByText('Что-то пошло не так')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
    // Two ways out: the eyebrow back-link every state carries, and the empty
    // state's own action. The second is the one this screen adds.
    expect(screen.getAllByRole('link', { name: 'К календарю' })).toHaveLength(2);
  });

  it('follows a «это и последующие» edit to the series it created', async () => {
    /*
     * The split, from the reader's side. `events.service.ts` truncates this
     * series and inserts a **successor** carrying the edited fields, so the id
     * in the URL stops being the one holding the edited dates. Before this, the
     * save toast settled over pre-edit content and an empty «Ближайшие даты».
     *
     * `?date=` rides along untouched: it is a date, and a split cannot
     * invalidate a date the way it invalidates a row id.
     */
    const user = userEvent.setup();
    const successor = series({ id: 'series-successor', title: 'Ужин попозже' });
    responses.set('/events/series/series-successor', successor);
    responses.set('PATCH /events/series/series-dinner', successor);

    renderEventDetail('/calendar/series-dinner?date=2026-09-15');

    await user.click(await screen.findByRole('button', { name: /Изменить/ }));
    await user.click(await screen.findByRole('button', { name: /Сохранить/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/calendar/series-successor?date=2026-09-15',
      );
    });
  });

  it('stays put when the save edited the series in place', async () => {
    // The ordinary edit returns the same series. Navigating to where we already
    // are is a pointless history write, and `replace: true` on every save would
    // fight the anchor logic the form applies to an «все» edit.
    const user = userEvent.setup();
    responses.set('PATCH /events/series/series-dinner', series({ title: 'Ужин переименованный' }));

    renderEventDetail('/calendar/series-dinner?date=2026-09-15');

    await user.click(await screen.findByRole('button', { name: /Изменить/ }));
    await user.click(await screen.findByRole('button', { name: /Сохранить/ }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Сохранить/ })).toBeNull();
    });
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/calendar/series-dinner?date=2026-09-15',
    );
  });
});
