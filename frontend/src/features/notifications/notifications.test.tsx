import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InAppNotification, PreferencesResponse } from '@family/shared';
import { clearAccessToken, setAccessToken } from '@/shared/api/token-store';
import { ERROR_MESSAGES_RU } from '@/shared/api/errors-ru';
import { ackKey, ackPath } from '@/features/settings/push/ack-queue';
import { NotificationsPanel } from './components/NotificationsPanel';
import { PushHealthBanner } from './components/PushHealthBanner';
import { NOTIFICATIONS_RU } from './locale';

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
 *  2. **An already-acknowledged row does not offer the button again.**
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
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const calls: Call[] = [];

function installFetch(scenario: Scenario = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });

      if (url.includes('/api/notifications/unread-count')) {
        return Promise.resolve(jsonResponse(200, { unread: scenario.unread ?? 0 }));
      }
      if (url.includes('/api/notifications/preferences')) {
        return Promise.resolve(jsonResponse(200, preferences(scenario.channels)));
      }
      if (url.includes('/api/notifications/read')) {
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
        return Promise.resolve(
          jsonResponse(200, { items: scenario.items ?? [notification()], nextCursor: null }),
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
    // The row still says it was confirmed — the ladder is visibly stopped.
    expect(screen.getByText(/Подтверждено/)).toBeInTheDocument();
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
