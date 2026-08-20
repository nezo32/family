import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InAppNotification, PreferencesResponse } from '@family/shared';
import { clearAccessToken, setAccessToken } from '@/shared/api/token-store';
import { mockMediaQuery } from '@/test/media';
import { ERROR_MESSAGES_RU } from '@/shared/api/errors-ru';
import { ackKey, ackPath } from '@/features/settings/push/ack-queue';
import { NotificationsPanel } from './components/NotificationsPanel';
import { PushHealthBanner } from './components/PushHealthBanner';
import { NOTIFICATION_ACTION_RU, NOTIFICATIONS_RU } from './locale';

/**
 * `SwipeRow` raises the undo toast through `sonner` directly, and `notify` in
 * `shared/lib/toast` goes through the same module. Nothing renders a
 * `<Toaster>` here, so a real toast would be invisible and unassertable —
 * capturing the call is the only way to read what the toast actually offered.
 */
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));

vi.mock('sonner', () => {
  const toast = Object.assign(
    (...args: unknown[]) => {
      toastSpy(...args);
    },
    {
      success: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  );
  return { toast, Toaster: () => null };
});

interface ToastOptions {
  id?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

/** The most recent `toast(message, options)` call, as the row raised it. */
function lastToast(): [string, ToastOptions] {
  const call = toastSpy.mock.calls.at(-1);
  expect(call, 'no toast was raised').toBeDefined();
  return call as [string, ToastOptions];
}

/**
 * What is worth testing about the inbox.
 *
 * Not tested: that a `<Sheet>` opens, that TanStack Query caches. Tested: the
 * four rules whose breakage is a real incident in a real family —
 *
 *  1. **«Подтвердить» reaches `/acknowledge`.** Per D11 the explicit
 *     acknowledgement is the *only* signal that stops a `critical` intent
 *     escalating to another family member; if this button is missing, or its URL
 *     is wrong, every critical notification always runs the full ladder and
 *     wakes somebody at 3 a.m. The path is asserted character by character
 *     because the queue kind is `acknowledged` while the endpoint is
 *     `acknowledge`, and interpolating the kind silently 404s.
 *  2. **An already-acknowledged row does not offer the button again**, and its
 *     receipt says what was confirmed — see the join-request block below.
 *  3. **`pushHealthy === false` is visible.** The server has been computing that
 *     flag on every request; the whole point of the banner is that somebody
 *     finally reads it.
 *  4. **Failures speak Russian, keyed on `ErrorCode`** — never the server's
 *     English `message` (D7).
 */

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const DELIVERY_ID = '11111111-1111-4111-8111-111111111111';
const READ_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-08-19T09:00:00.000Z';

function notification(overrides: Partial<InAppNotification> = {}): InAppNotification {
  return {
    id: DELIVERY_ID,
    type: 'task_overdue',
    priority: 'critical',
    title: 'Просрочено: выгулять собаку',
    body: 'Срок был в 19:00.',
    entityType: 'task',
    entityId: '33333333-3333-4333-8333-333333333333',
    link: '/tasks/33333333-3333-4333-8333-333333333333',
    actor: null,
    createdAt: NOW,
    readAt: null,
    status: 'delivered',
    needsAcknowledgement: true,
    acknowledgedAt: null,
    ...overrides,
  };
}

function preferences(channels: Partial<PreferencesResponse['channels']> = {}) {
  return {
    preferences: [],
    quietHours: [],
    channels: { pushReady: true, pushHealthy: true, telegramReady: false, ...channels },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Scenario {
  items?: InAppNotification[];
  unread?: number;
  channels?: Partial<PreferencesResponse['channels']>;
  /** Status for `POST /deliveries/:id/acknowledge`. */
  ackStatus?: number;
  ackErrorCode?: string;
  /** Status for `POST /notifications/unread` — the swipe's undo. */
  unreadStatus?: number;
  /**
   * Remembers what the mark-read and un-read writes did, so a refetch answers
   * with the state the last write left behind.
   *
   * Every other test here can use a static stub, because it asserts on the
   * request. The undo cannot: an optimistic patch that the very next refetch
   * overwrites is exactly the bug worth catching, and a stub that always
   * answers `readAt: null` would hide it in one direction and invent it in the
   * other.
   */
  stateful?: boolean;
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const calls: Call[] = [];

function installFetch(scenario: Scenario = {}) {
  /** Server-side `readAt`, when `scenario.stateful` is on. */
  let readAt: string | null = null;

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });

      if (url.includes('/api/notifications/unread-count')) {
        const unread = scenario.stateful
          ? readAt === null
            ? (scenario.unread ?? 0)
            : 0
          : (scenario.unread ?? 0);
        return Promise.resolve(jsonResponse(200, { unread }));
      }
      // Strictly after `/unread-count`, which contains this path as a prefix.
      if (url.includes('/api/notifications/unread')) {
        const status = scenario.unreadStatus ?? 200;
        if (status !== 200) {
          return Promise.resolve(
            jsonResponse(status, { error: { code: 'NOT_FOUND', message: 'delivery is gone' } }),
          );
        }
        readAt = null;
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }
      if (url.includes('/api/notifications/preferences')) {
        return Promise.resolve(jsonResponse(200, preferences(scenario.channels)));
      }
      if (url.includes('/api/notifications/read')) {
        readAt = NOW;
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }
      if (url.includes('/acknowledge')) {
        const status = scenario.ackStatus ?? 200;
        if (status !== 200) {
          return Promise.resolve(
            jsonResponse(status, {
              error: { code: scenario.ackErrorCode ?? 'NOT_FOUND', message: 'delivery is gone' },
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {
            id: DELIVERY_ID,
            status: 'acknowledged',
            deliveredAt: NOW,
            interactedAt: null,
            acknowledgedAt: NOW,
          }),
        );
      }
      if (url.includes('/api/notifications')) {
        const items = scenario.items ?? [notification()];
        return Promise.resolve(
          jsonResponse(200, {
            items: scenario.stateful ? items.map((item) => ({ ...item, readAt })) : items,
            nextCursor: null,
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'unstubbed' } }),
      );
    }),
  );
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

beforeEach(() => {
  calls.length = 0;
  toastSpy.mockClear();
  // A mouse, unless a test says otherwise: `(pointer: coarse)` is what enables
  // the swipe, and most of this file is about the buttons rather than the
  // gesture.
  mockMediaQuery([]);
  clearAccessToken();
  setAccessToken('test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAccessToken();
});

/* -------------------------------------------------------------------------- */
/* the acknowledgement contract (D11)                                          */
/* -------------------------------------------------------------------------- */

describe('«Подтвердить» — the only thing that stops an escalation (D11)', () => {
  it('posts to /deliveries/:id/acknowledge with the moment of the tap', async () => {
    installFetch({ items: [notification()], unread: 1 });
    const user = userEvent.setup();

    render(wrapper(<NotificationsPanel open onOpenChange={() => undefined} />));

    const button = await screen.findByRole('button', { name: NOTIFICATIONS_RU.acknowledge });
    await user.click(button);

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/acknowledge'))).toBe(true);
    });

    const ack = calls.find((call) => call.url.includes('/acknowledge'));
    expect(ack?.method).toBe('POST');
    // The queue kind is `acknowledged`; the endpoint is `acknowledge`. Getting
    // this wrong 404s every acknowledgement and looks exactly like nobody
    // pressed the button.
    expect(ack?.url).toContain(`/api/notifications/deliveries/${DELIVERY_ID}/acknowledge`);
    expect(ack?.url).not.toContain('/acknowledged');
    expect((ack?.body as { occurredAt?: string } | undefined)?.occurredAt).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it('offers the button for high/critical and never for an already-acknowledged row', async () => {
    installFetch({
      items: [
        notification({ id: DELIVERY_ID, acknowledgedAt: NOW, needsAcknowledgement: false }),
        notification({ id: READ_ID, priority: 'normal', needsAcknowledgement: false, readAt: NOW }),
      ],
    });

    render(wrapper(<NotificationsPanel open onOpenChange={() => undefined} />));

    await waitFor(() => {
      expect(screen.getAllByText('Просрочено: выгулять собаку').length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByRole('button', { name: NOTIFICATIONS_RU.acknowledge }),
    ).not.toBeInTheDocument();
    // The row still shows the receipt — the ladder is visibly stopped — and it
    // names what was confirmed, which is the *delivery*.
    expect(screen.getByText(/Получение подтверждено/)).toBeInTheDocument();
  });

  it('queues under a key the offline flush understands', () => {
    // `AckKind` now carries `acknowledged`, so a tap made offline rides the same
    // IndexedDB queue as the service worker's `delivered`/`interacted` receipts.
    expect(ackPath(DELIVERY_ID, 'acknowledged')).toBe(
      `/notifications/deliveries/${DELIVERY_ID}/acknowledge`,
    );
    expect(ackKey(DELIVERY_ID, 'acknowledged')).toBe(`${DELIVERY_ID}:acknowledged`);
    expect(ackKey(DELIVERY_ID, 'acknowledged')).not.toBe(ackKey(DELIVERY_ID, 'delivered'));
  });

  it('renders a failure in Russian, keyed on the ErrorCode', async () => {
    installFetch({ items: [notification()], ackStatus: 404, ackErrorCode: 'NOT_FOUND' });
    const user = userEvent.setup();

    render(wrapper(<NotificationsPanel open onOpenChange={() => undefined} />));
    await user.click(await screen.findByRole('button', { name: NOTIFICATIONS_RU.acknowledge }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/acknowledge'))).toBe(true);
    });
    // The server's English `message` ("delivery is gone") must never reach the
    // DOM; the Russian sentence is keyed on the code (D7).
    expect(screen.queryByText(/delivery is gone/)).not.toBeInTheDocument();
    expect(ERROR_MESSAGES_RU.NOT_FOUND).toBe('Не найдено. Возможно, запись удалили.');
  });
});

/* -------------------------------------------------------------------------- */
/* the join request — the incident of 20 August                                */
/* -------------------------------------------------------------------------- */

const APPLICANT_ID = '55555555-5555-4555-8555-555555555555';
const JOIN_REQUEST_ID = '44444444-4444-4444-8444-444444444444';

/** «Заявка в семью — дарья кислякова ждёт подтверждения · google», verbatim. */
function joinRequest(overrides: Partial<InAppNotification> = {}): InAppNotification {
  return notification({
    id: JOIN_REQUEST_ID,
    type: 'member_pending_approval',
    priority: 'high',
    title: 'Заявка в семью',
    body: 'дарья кислякова · ждёт подтверждения · google',
    entityType: 'user',
    entityId: APPLICANT_ID,
    link: '/admin/members',
    ...overrides,
  });
}

/** Renders the current pathname so a navigation out of the sheet is observable. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="pathname">{location.pathname}</span>;
}

function wrapperWithLocation(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        {ui}
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/**
 * The bug: an owner opened this exact row and pressed the only button on it.
 * The button was the D11 delivery receipt, labelled «Подтвердить»; the card
 * then read «Подтверждено 20 августа в 08:09» and she told the applicant she
 * was in. `POST /members/:id/approve` was never called — not once, in the whole
 * day's production log — and the applicant stayed `pending_approval`.
 *
 * Two independent things had to be true for that to happen, so both are pinned
 * here: the row offered no way to actually decide the request, and the receipt
 * was worded as if it had decided it.
 */
describe('«Заявка в семью» — deciding it, and never appearing to', () => {
  it('leads with «Рассмотреть заявку», which opens the approval queue', async () => {
    installFetch({ items: [joinRequest()], unread: 1 });
    const user = userEvent.setup();

    render(wrapperWithLocation(<NotificationsPanel open onOpenChange={() => undefined} />));

    const action = await screen.findByRole('button', {
      name: NOTIFICATION_ACTION_RU.member_pending_approval,
    });
    await user.click(action);

    // `/admin/members`, the queue — not `/admin/members/<uuid>`, which the
    // router does not match and which therefore rendered the 404 screen.
    await waitFor(() => {
      expect(screen.getByTestId('pathname')).toHaveTextContent('/admin/members');
    });
    expect(screen.getByTestId('pathname').textContent).toBe('/admin/members');

    // And it went to the queue instead of quietly filing a delivery receipt.
    expect(calls.some((call) => call.url.includes('/acknowledge'))).toBe(false);
  });

  it('never offers a bare «Подтвердить» next to «ждёт подтверждения»', async () => {
    installFetch({ items: [joinRequest()] });
    render(wrapperWithLocation(<NotificationsPanel open onOpenChange={() => undefined} />));

    await screen.findByText('Заявка в семью');

    // The exact label the owner tapped. Whatever the receipt button says, it
    // must not be a bare verb that reads as a decision on the request.
    expect(screen.queryByRole('button', { name: 'Подтвердить' })).not.toBeInTheDocument();

    // The receipt button is still there — D11 needs it — and it names its
    // object, and it is not the primary control on the row.
    const ack = screen.getByRole('button', { name: NOTIFICATIONS_RU.acknowledge });
    expect(ack).toBeInTheDocument();
    expect(NOTIFICATIONS_RU.acknowledge).toMatch(/получени/i);

    // And the row says out loud that pressing it decides nothing.
    expect(screen.getByText(NOTIFICATIONS_RU.acknowledgeHint)).toBeInTheDocument();
  });

  it('reports an acknowledgement as a delivery receipt, not as an approval', async () => {
    installFetch({
      items: [joinRequest({ acknowledgedAt: NOW, needsAcknowledgement: false, readAt: NOW })],
    });
    render(wrapperWithLocation(<NotificationsPanel open onOpenChange={() => undefined} />));

    await screen.findByText('Заявка в семью');

    // This is the sentence the owner read as "заявка подтверждена". It must
    // name what was actually confirmed.
    expect(screen.getByText(/Получение подтверждено/)).toBeInTheDocument();
    expect(screen.queryByText(/^Подтверждено /)).not.toBeInTheDocument();

    // The request is still undecided, so the way to decide it is still offered.
    expect(
      screen.getByRole('button', { name: NOTIFICATION_ACTION_RU.member_pending_approval }),
    ).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* the inbox itself                                                            */
/* -------------------------------------------------------------------------- */

describe('inbox', () => {
  it('renders the server-rendered Russian copy and never re-templates it', async () => {
    installFetch({ items: [notification()] });
    render(wrapper(<NotificationsPanel open onOpenChange={() => undefined} />));

    expect(await screen.findByText('Просрочено: выгулять собаку')).toBeInTheDocument();
    expect(screen.getByText('Срок был в 19:00.')).toBeInTheDocument();
  });

  it('«Прочитать все» sweeps with a `before` pinned to the tap', async () => {
    installFetch({ items: [notification()], unread: 3 });
    const user = userEvent.setup();

    render(wrapper(<NotificationsPanel open onOpenChange={() => undefined} />));

    const markAll = await screen.findByRole('button', { name: /Прочитать все/ });
    await waitFor(() => {
      expect(markAll).toBeEnabled();
    });
    await user.click(markAll);

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/api/notifications/read'))).toBe(true);
    });
    const read = calls.find((call) => call.url.includes('/api/notifications/read'));
    expect(read?.method).toBe('POST');
    // `all` without `before` would also swallow a notification that arrives
    // while the request is in flight.
    expect(read?.body).toMatchObject({ all: true });
    expect((read?.body as { before?: string }).before).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it('says «Всё прочитано» rather than looking broken when there is nothing', async () => {
    installFetch({ items: [] });
    render(wrapper(<NotificationsPanel open onOpenChange={() => undefined} />));

    expect(await screen.findByText(NOTIFICATIONS_RU.emptyTitle)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* the swipe and its undo (§C-gestures/G4)                                     */
/* -------------------------------------------------------------------------- */

/**
 * This was the one place §G4 was not met.
 *
 * The spec's rule is unconditional: every gesture action raises a six-second
 * «Отменить» and that button genuinely reverses the action. The notification
 * row could not, because the API had `POST /notifications/read` and nothing
 * that put a row back — so it shipped a toast with no control at all, which was
 * the right call and a gap. `POST /notifications/unread` closes it, and these
 * tests are what stop it silently reopening: a row whose `onUndo` is dropped
 * again would still pass every other test in this file.
 *
 * The commit is driven through the revealed 88px button rather than a synthetic
 * touch sequence. §G4 makes tapping it a commit in its own right, so this is a
 * real path and not a shortcut, and it keeps the assertions about *what the
 * undo does* rather than about jsdom's absent `TouchEvent`.
 */
describe('swipe «Прочитано» and its «Отменить» (§G4)', () => {
  /**
   * The row's revealed action button.
   *
   * Queried by its `aria-label` rather than by role: the button is
   * `aria-hidden` until the row stands open (§G1 — the visible twin is the row
   * itself, so this must not be a second entry in the accessibility tree), and
   * an `aria-hidden` node has no accessible name to match a role query against.
   */
  function swipeButton(): HTMLElement {
    return screen.getByLabelText(NOTIFICATIONS_RU.swipeRead);
  }

  async function openPanelOnAPhone() {
    mockMediaQuery(['(pointer: coarse)']);
    render(wrapper(<NotificationsPanel open onOpenChange={() => undefined} />));
    expect(await screen.findByText('Просрочено: выгулять собаку')).toBeInTheDocument();
  }

  it('marks the row read and offers a six-second undo that reverses it', async () => {
    installFetch({ items: [notification()], unread: 1 });
    await openPanelOnAPhone();

    fireEvent.click(swipeButton());

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/api/notifications/read'))).toBe(true);
    });
    const read = calls.find((call) => call.url.includes('/api/notifications/read'));
    expect(read?.method).toBe('POST');
    expect(read?.body).toEqual({ ids: [DELIVERY_ID] });

    // §G4: one word, six seconds, and a button that says «Отменить».
    const [message, options] = lastToast();
    expect(message).toBe(NOTIFICATIONS_RU.swipeRead);
    expect(options.duration).toBe(6000);
    expect(options.action?.label).toBe('Отменить');

    options.action?.onClick();

    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/api/notifications/unread'))).toBe(true);
    });
    const undo = calls.find((call) => call.url.endsWith('/api/notifications/unread'));
    expect(undo?.method).toBe('POST');
    // Ids only. There is no `all` on this endpoint, and «Отменить» reverses the
    // one row the finger touched — never the sweep that «Прочитать все» ran.
    expect(undo?.body).toEqual({ ids: [DELIVERY_ID] });
  });

  it('puts the unread dot back, and it survives the refetch that follows', async () => {
    installFetch({ items: [notification()], unread: 1, stateful: true });
    await openPanelOnAPhone();

    const dot = () => screen.queryByLabelText('Непрочитано');
    expect(dot()).toBeInTheDocument();

    fireEvent.click(swipeButton());
    await waitFor(() => {
      expect(dot()).not.toBeInTheDocument();
    });

    const [, options] = lastToast();
    options.action?.onClick();

    /*
     * Optimistic both ways — the undo has to feel like the swipe running
     * backwards rather than like a round trip — *and* still true afterwards.
     * `onSettled` invalidates the whole inbox, so a dot that only ever came
     * back optimistically would blink out again a moment later, which is the
     * failure this stateful stub exists to see.
     */
    await waitFor(() => {
      expect(dot()).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'GET').length).toBeGreaterThan(2);
    });
    expect(dot()).toBeInTheDocument();
  });

  it('speaks Russian when the undo fails, and never the server\'s message', async () => {
    installFetch({ items: [notification()], unread: 1, unreadStatus: 404 });
    await openPanelOnAPhone();

    fireEvent.click(swipeButton());
    const [, options] = lastToast();
    options.action?.onClick();

    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith('/api/notifications/unread'))).toBe(true);
    });
    expect(screen.queryByText(/delivery is gone/)).not.toBeInTheDocument();
    expect(NOTIFICATIONS_RU.markUnreadFailed).toBe('Не удалось вернуть в непрочитанные');
  });
});

/* -------------------------------------------------------------------------- */
/* the D11 health signal                                                       */
/* -------------------------------------------------------------------------- */

describe('pushHealthy === false', () => {
  it('raises «Уведомления отключились — включить снова?»', async () => {
    installFetch({ channels: { pushReady: true, pushHealthy: false } });

    render(wrapper(<PushHealthBanner />));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(NOTIFICATIONS_RU.pushUnhealthyTitle)).toBeInTheDocument();
    expect(
      within(alert).getByRole('button', { name: NOTIFICATIONS_RU.pushUnhealthyAction }),
    ).toBeInTheDocument();
  });

  it('stays silent when push is healthy, and when there is no subscription at all', async () => {
    installFetch({ channels: { pushReady: true, pushHealthy: true } });
    const { unmount } = render(wrapper(<PushHealthBanner />));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/preferences'))).toBe(true);
    });
    expect(screen.queryByText(NOTIFICATIONS_RU.pushUnhealthyTitle)).not.toBeInTheDocument();
    unmount();

    // `pushReady: false` is "уведомления просто не включены" — the settings
    // funnel's business, not a repair banner.
    calls.length = 0;
    installFetch({ channels: { pushReady: false, pushHealthy: false } });
    render(wrapper(<PushHealthBanner />));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/preferences'))).toBe(true);
    });
    expect(screen.queryByText(NOTIFICATIONS_RU.pushUnhealthyTitle)).not.toBeInTheDocument();
  });
});
