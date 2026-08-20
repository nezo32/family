import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Permission, PollResponse, PublicUser } from '@family/shared';
import { api } from '@/shared/api/client';
import { ApiError } from '@/shared/api/errors';
import { meKeys } from '@/shared/auth/use-me';
import { makeMe } from '@/test/me';
import { TooltipProvider } from '@/shared/ui/tooltip';
import { AnnouncementComposer } from './components/AnnouncementComposer';
import { BoardComposeButton, BoardComposeProvider } from './components/BoardCompose';
import { KudosPanel } from './components/KudosPanel';
import { PollBoard } from './components/PollBoard';
import { PollCard } from './components/PollCard';
import { ReactionBar } from './components/ReactionBar';
import { WallStream } from './components/WallStream';
import type { Roster } from './hooks';
import { WALL_RU } from './locale';

/**
 * Board behaviour tests.
 *
 * These cover the rules that would silently rot: permission gating goes through
 * `useCan()` and nothing else, optimism is reversible, a closed poll is a
 * result rather than a broken form, single-choice voting replaces rather than
 * accumulates, the activity `summary` is never re-composed on the client — and
 * the two rules this redesign added, which are the two easiest to lose:
 *
 * - **the poll result is hidden until you have answered**, so the family's
 *   loudest voters cannot anchor a ten-year-old's answer, and
 * - **«Спасибо» never renders a per-person count, out loud or on screen** (D5).
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

/** The permission set a `child` actually holds — checked against `ROLE_PERMISSIONS`. */
const CHILD_PERMISSIONS: Permission[] = [
  'post:create',
  'post:delete:own',
  'comment:create',
  'comment:delete:own',
  'kudos:give',
  'poll:vote',
];

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

function poll(overrides: { isClosed: boolean; myOptionIds: string[] }): PollResponse {
  return {
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
  };
}

function pollPayload(overrides: { isClosed: boolean; myOptionIds: string[] }) {
  return { items: [poll(overrides)], nextCursor: null };
}

const FAKE_ROSTER: Roster = {
  byId: new Map<string, PublicUser>(),
  members: [],
  nameOf: (id) => (id === ME_ID ? 'Мама' : id ? 'Лиза' : WALL_RU.board.systemAuthor),
};

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

const noop = (): void => undefined;

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
/* the one door                                                                */
/* -------------------------------------------------------------------------- */

describe('the board’s one door', () => {
  it('offers a child announcements and thanks, and never a poll', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BoardComposeProvider>
        <BoardComposeButton />
      </BoardComposeProvider>,
      CHILD_PERMISSIONS,
    );

    await user.click(screen.getByRole('button', { name: WALL_RU.compose.open }));

    // A child holds `post:create` and `kudos:give` but not `poll:create`, so
    // the third row is absent — not disabled, absent.
    expect(await screen.findByText(WALL_RU.compose.menuTitle)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Объявление/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Спасибо/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Опрос/ })).not.toBeInTheDocument();
  });

  it('skips the menu when the reader may put exactly one thing on the board', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <BoardComposeProvider>
        <BoardComposeButton />
      </BoardComposeProvider>,
      ['post:create'],
    );

    await user.click(screen.getByRole('button', { name: WALL_RU.compose.open }));

    // Straight into the composer: a menu with one item is a tap tax.
    expect(await screen.findByText(WALL_RU.post.composeTitle)).toBeInTheDocument();
    expect(screen.queryByText(WALL_RU.compose.menuTitle)).not.toBeInTheDocument();
  });

  it('renders no door at all for a reader who may not write', () => {
    renderWithProviders(
      <BoardComposeProvider>
        <BoardComposeButton />
      </BoardComposeProvider>,
      ['event:read'],
    );

    expect(screen.queryByRole('button', { name: WALL_RU.compose.open })).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* permissions                                                                 */
/* -------------------------------------------------------------------------- */

describe('pin control gating', () => {
  it('offers pinning to a holder of post:pin', async () => {
    renderWithProviders(<AnnouncementComposer open onOpenChange={noop} />, [
      'post:create',
      'post:pin',
    ]);

    expect(await screen.findByText(WALL_RU.post.pinFor)).toBeInTheDocument();
  });

  it('hides every pin control from a user without post:pin', async () => {
    // A teenager: may write announcements, may not pin them.
    renderWithProviders(<AnnouncementComposer open onOpenChange={noop} />, [
      'post:create',
      'post:delete:own',
    ]);

    expect(await screen.findByText(WALL_RU.post.composeTitle)).toBeInTheDocument();
    expect(screen.queryByText(WALL_RU.post.pinFor)).not.toBeInTheDocument();
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
  it('renders a closed poll as a result, never as a voting form', () => {
    renderWithProviders(
      <PollCard poll={poll({ isClosed: true, myOptionIds: [OPTION_A] })} roster={FAKE_ROSTER} />,
      ['poll:vote', 'poll:create'],
    );

    expect(screen.getByText('Куда едем на выходных?')).toBeInTheDocument();
    expect(screen.getByText(WALL_RU.polls.closedBadge)).toBeInTheDocument();

    // The result is there…
    expect(screen.getByText('На дачу')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();

    // …and there is nothing to vote with, so nothing can 409.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: WALL_RU.polls.vote })).not.toBeInTheDocument();
  });

  it('hides the result until the reader has answered', () => {
    renderWithProviders(
      <PollCard poll={poll({ isClosed: false, myOptionIds: [] })} roster={FAKE_ROSTER} />,
      ['poll:vote'],
    );

    // Both options are offered…
    expect(screen.getByRole('radio', { name: /На дачу/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /В город/ })).toBeInTheDocument();
    // …and neither shows how the family is leaning, so the loudest voter in the
    // house cannot anchor a ten-year-old's answer.
    expect(screen.queryByText('67%')).not.toBeInTheDocument();
    expect(screen.queryByText('33%')).not.toBeInTheDocument();
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

    renderWithProviders(<PollBoard surface="attention" />, ['poll:vote']);

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

    expect(postSpy).toHaveBeenCalledWith(`/wall/polls/${POLL_ID}/votes`, { optionIds: [OPTION_B] });
  });
});

/* -------------------------------------------------------------------------- */
/* kudos — the negative rule                                                   */
/* -------------------------------------------------------------------------- */

describe('«Спасибо»', () => {
  it('never renders a per-person count, on screen or to a screen reader', async () => {
    getSpy.mockImplementation((path: string) => {
      if (path === '/members') return Promise.resolve(ROSTER as never);
      if (path === '/wall/kudos/totals')
        return Promise.resolve({
          items: [
            { userId: ME_ID, displayName: 'Мама', received: 7 },
            { userId: OTHER_ID, displayName: 'Лиза', received: 0 },
          ],
        } as never);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });

    const { container } = renderWithProviders(<KudosPanel />, ['kudos:give']);

    expect(await screen.findByText('Мама')).toBeInTheDocument();
    expect(screen.getByText(WALL_RU.kudos.receivedSome)).toBeInTheDocument();
    expect(screen.getByText(WALL_RU.kudos.receivedNone)).toBeInTheDocument();

    /*
      The whole subtree, markup included — `title`, `aria-label` and every text
      node. A weekly-load bar on Семья once read «40 % (своя доля 33 %)» aloud
      while drawing no numbers at all; this is the assertion that stops the same
      leak here. `7` is the count under test; `0` would be trivially present in
      a uuid, so only the non-trivial one is asserted.
    */
    expect(container.innerHTML).not.toMatch(/\b7\b/);
  });
});

/* -------------------------------------------------------------------------- */
/* activity                                                                    */
/* -------------------------------------------------------------------------- */

describe('the board stream', () => {
  it('renders the server-rendered summary verbatim', async () => {
    getSpy.mockImplementation((path: string) => {
      if (path === '/members') return Promise.resolve(ROSTER as never);
      if (path === '/wall/feed') return Promise.resolve(feedPayload() as never);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });

    renderWithProviders(<WallStream pinnedSurface="card" />, ['post:create']);

    // Exact string, not a fragment: the sentence is frozen at write time and the
    // client must not re-compose it from `verb` + entity.
    expect(await screen.findByText(ACTIVITY_SUMMARY)).toBeInTheDocument();
    // …and the announcement beside it still has its own title, so the two
    // layers of the board stay visually distinct.
    expect(screen.getByText('В субботу едем к бабушке')).toBeInTheDocument();
  });

  it('offers a way out of an empty board, and none to a reader who may not write', async () => {
    getSpy.mockImplementation((path: string) => {
      if (path === '/members') return Promise.resolve(ROSTER as never);
      if (path === '/wall/feed')
        return Promise.resolve({ pinned: [], items: [], nextCursor: null } as never);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });

    const { unmount } = renderWithProviders(
      <BoardComposeProvider>
        <WallStream pinnedSurface="card" />
      </BoardComposeProvider>,
      ['post:create'],
    );

    expect(await screen.findByText(WALL_RU.board.empty)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: WALL_RU.compose.open })).toBeInTheDocument();
    unmount();

    renderWithProviders(
      <BoardComposeProvider>
        <WallStream pinnedSurface="card" />
      </BoardComposeProvider>,
      ['event:read'],
    );

    expect(await screen.findByText(WALL_RU.board.empty)).toBeInTheDocument();
    expect(screen.getByText(WALL_RU.board.emptyReadOnly)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: WALL_RU.compose.open })).not.toBeInTheDocument();
  });
});
