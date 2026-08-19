import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Permission } from '@family/shared';
import { api } from '@/shared/api/client';
import { ApiError } from '@/shared/api/errors';
import { meKeys } from '@/shared/auth/use-me';
import { makeMe } from '@/test/me';
import { TooltipProvider } from '@/shared/ui/tooltip';
import { AnnouncementComposer } from './components/AnnouncementComposer';
import { PollsPanel } from './components/PollsPanel';
import { ReactionBar } from './components/ReactionBar';
import { WallFeed } from './components/WallFeed';
import { WALL_RU } from './locale';

/**
 * Wall behaviour tests.
 *
 * These cover the five rules that would silently rot: permission gating goes
 * through `useCan()` and nothing else, optimism is reversible, a closed poll is
 * a result rather than a broken form, single-choice voting replaces rather than
 * accumulates, and the activity `summary` is never re-composed on the client.
 */

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const ME_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ID = '55555555-5555-4555-8555-555555555555';
const POST_ID = '66666666-6666-4666-8666-666666666666';
const ACTIVITY_ID = '77777777-7777-4777-8777-777777777777';
const POLL_ID = '11111111-1111-4111-8111-111111111111';
const OPTION_A = '22222222-2222-4222-8222-222222222222';
const OPTION_B = '33333333-3333-4333-8333-333333333333';

const NOW = '2026-08-19T09:00:00.000Z';

const ROSTER = {
  items: [
    {
      id: ME_ID,
      displayName: 'Мама',
      avatarUrl: null,
      color: null,
      role: 'adult',
      status: 'active',
    },
    {
      id: OTHER_ID,
      displayName: 'Лиза',
      avatarUrl: null,
      color: null,
      role: 'teen',
      status: 'active',
    },
  ],
  pendingCount: 0,
};

/** The one sentence the client must never rewrite. */
const ACTIVITY_SUMMARY = 'Лиза полила цветы и вынесла мусор — 19 августа';

function feedPayload() {
  return {
    pinned: [],
    items: [
      {
        kind: 'activity',
        id: ACTIVITY_ID,
        createdAt: NOW,
        activity: {
          id: ACTIVITY_ID,
          actorId: OTHER_ID,
          verb: 'task.completed',
          entityType: 'task',
          entityId: POST_ID,
          summary: ACTIVITY_SUMMARY,
          metadata: {},
          createdAt: NOW,
        },
      },
      {
        kind: 'post',
        id: POST_ID,
        createdAt: NOW,
        post: {
          id: POST_ID,
          authorId: ME_ID,
          type: 'announcement',
          title: 'В субботу едем к бабушке',
          body: 'Выезжаем в 10:00, не проспите.',
          pinnedUntil: null,
          isPinned: false,
          commentCount: 0,
          reactions: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    ],
    nextCursor: null,
  };
}

function pollPayload(overrides: { isClosed: boolean; myOptionIds: string[] }) {
  return {
    items: [
      {
        id: POLL_ID,
        question: 'Куда едем на выходных?',
        allowMultiple: false,
        closesAt: null,
        closedAt: overrides.isClosed ? NOW : null,
        isClosed: overrides.isClosed,
        createdById: OTHER_ID,
        options: [
          {
            id: OPTION_A,
            label: 'На дачу',
            sortOrder: 0,
            voteCount: 2,
            voterIds: [ME_ID, OTHER_ID],
          },
          { id: OPTION_B, label: 'В город', sortOrder: 1, voteCount: 1, voterIds: [] },
        ],
        totalVoters: 3,
        myOptionIds: overrides.myOptionIds,
        createdAt: NOW,
      },
    ],
    nextCursor: null,
  };
}

/* -------------------------------------------------------------------------- */
/* harness                                                                     */
/* -------------------------------------------------------------------------- */

let queryClient: QueryClient;

function renderWithProviders(ui: ReactNode, permissions: Permission[]) {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  // Seeding `['me']` rather than mocking the endpoint keeps `useCan()` on its
  // real code path: the permission list still comes from the server contract.
  queryClient.setQueryData(meKeys.detail(), makeMe({ id: ME_ID, email: null, permissions }));

  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

const getSpy = vi.spyOn(api, 'get');
const postSpy = vi.spyOn(api, 'post');

beforeEach(() => {
  getSpy.mockReset();
  postSpy.mockReset();
  getSpy.mockImplementation((path: string) => {
    if (path === '/members') return Promise.resolve(ROSTER as never);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  postSpy.mockReset();
});

afterEach(() => {
  queryClient.clear();
});

/* -------------------------------------------------------------------------- */
/* permissions                                                                 */
/* -------------------------------------------------------------------------- */

describe('pin control gating', () => {
  it('offers pinning to a holder of post:pin', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AnnouncementComposer />, ['post:create', 'post:pin']);

    await user.click(screen.getByRole('button', { name: WALL_RU.post.compose }));

    expect(await screen.findByText(WALL_RU.post.pinFor)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: WALL_RU.post.pinWeek })).toBeInTheDocument();
  });

  it('hides every pin control from a user without post:pin', async () => {
    const user = userEvent.setup();
    // A teenager: may write announcements, may not pin them.
    renderWithProviders(<AnnouncementComposer />, ['post:create', 'post:delete:own']);

    await user.click(screen.getByRole('button', { name: WALL_RU.post.compose }));

    expect(await screen.findByText(WALL_RU.post.composeTitle)).toBeInTheDocument();
    expect(screen.queryByText(WALL_RU.post.pinFor)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: WALL_RU.post.pinWeek })).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* optimistic reactions                                                        */
/* -------------------------------------------------------------------------- */

describe('reactions', () => {
  it('rolls the optimistic count back when the toggle fails', async () => {
    const user = userEvent.setup();

    let rejectToggle: ((reason: unknown) => void) | undefined;
    postSpy.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectToggle = reject;
        }),
    );

    renderWithProviders(
      <ReactionBar
        target={{ entityType: 'post', entityId: POST_ID }}
        reactions={[{ emoji: '❤️', count: 1, reacted: false }]}
      />,
      ['kudos:give'],
    );

    const chip = screen.getByRole('button', { name: '❤️ 1' });
    await user.click(chip);

    // Optimistic: the counter moves before the server has said anything.
    expect(await screen.findByRole('button', { name: '❤️ 2' })).toBeInTheDocument();

    rejectToggle?.(new ApiError({ code: 'INTERNAL_ERROR', status: 500 }));

    // …and comes back exactly as it was once the request fails.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '❤️ 1' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '❤️ 1' })).toHaveAttribute('aria-pressed', 'false');
  });
});

/* -------------------------------------------------------------------------- */
/* polls                                                                       */
/* -------------------------------------------------------------------------- */

describe('polls', () => {
  it('renders a closed poll as a result, never as a voting form', async () => {
    getSpy.mockImplementation((path: string) => {
      if (path === '/members') return Promise.resolve(ROSTER as never);
      if (path === '/wall/polls')
        return Promise.resolve(pollPayload({ isClosed: true, myOptionIds: [OPTION_A] }) as never);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });

    renderWithProviders(<PollsPanel />, ['poll:vote', 'poll:create']);

    expect(await screen.findByText('Куда едем на выходных?')).toBeInTheDocument();
    expect(screen.getByText(WALL_RU.polls.closed)).toBeInTheDocument();

    // The result is there…
    expect(screen.getByText('На дачу')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText(WALL_RU.polls.totalVoters(3))).toBeInTheDocument();

    // …and there is nothing to vote with, so nothing can 409.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: WALL_RU.polls.vote })).not.toBeInTheDocument();
  });

  it('replaces the previous choice when voting in a single-choice poll', async () => {
    const user = userEvent.setup();

    getSpy.mockImplementation((path: string) => {
      if (path === '/members') return Promise.resolve(ROSTER as never);
      if (path === '/wall/polls')
        return Promise.resolve(pollPayload({ isClosed: false, myOptionIds: [OPTION_A] }) as never);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    // Never settles: we are asserting the optimistic state, not the response.
    postSpy.mockImplementation(() => new Promise(() => undefined));

    renderWithProviders(<PollsPanel />, ['poll:vote']);

    const first = await screen.findByRole('radio', { name: /На дачу/ });
    const second = screen.getByRole('radio', { name: /В город/ });
    expect(first).toHaveAttribute('aria-checked', 'true');
    expect(second).toHaveAttribute('aria-checked', 'false');

    await user.click(second);

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /В город/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
    // Replaced, not added: the previous option is deselected and gives its vote
    // back, and the number of voters is unchanged.
    expect(screen.getByRole('radio', { name: /На дачу/ })).toHaveAttribute('aria-checked', 'false');
    expect(
      within(screen.getByRole('radio', { name: /На дачу/ })).getByText('33%'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('radio', { name: /В город/ })).getByText('67%'),
    ).toBeInTheDocument();
    expect(screen.getByText(WALL_RU.polls.totalVoters(3))).toBeInTheDocument();

    expect(postSpy).toHaveBeenCalledWith(`/wall/polls/${POLL_ID}/votes`, { optionIds: [OPTION_B] });
  });
});

/* -------------------------------------------------------------------------- */
/* activity                                                                    */
/* -------------------------------------------------------------------------- */

describe('activity feed', () => {
  it('renders the server-rendered summary verbatim', async () => {
    getSpy.mockImplementation((path: string) => {
      if (path === '/members') return Promise.resolve(ROSTER as never);
      if (path === '/wall/feed') return Promise.resolve(feedPayload() as never);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });

    renderWithProviders(<WallFeed />, ['post:create']);

    // Exact string, not a fragment: the sentence is frozen at write time and the
    // client must not re-compose it from `verb` + entity.
    expect(await screen.findByText(ACTIVITY_SUMMARY)).toBeInTheDocument();
    // …and the announcement above it is still a card with its own title, so the
    // two layers of the feed stay visually distinct.
    expect(screen.getByText('В субботу едем к бабушке')).toBeInTheDocument();
  });
});
