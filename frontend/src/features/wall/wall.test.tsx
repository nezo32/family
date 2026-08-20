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
import { ClearWallMenu } from './components/ClearWallMenu';
import { KudosPanel } from './components/KudosPanel';
import { PollCard } from './components/PollCard';
import { ReactionBar } from './components/ReactionBar';
import { WallStream } from './components/WallStream';
import { buildHead, coalesceFeed, type Roster } from './hooks';
import { WALL_RU } from './locale';

/**
 * Стена's behaviour tests.
 *
 * These cover the rules that would silently rot: permission gating goes
 * through `useCan()` and nothing else, optimism is reversible, a closed poll is
 * a result rather than a broken form, the activity `summary` is never
 * re-composed on the client — plus the four §D7 rules that are the easiest to
 * lose, because each one looks like a small reasonable regression:
 *
 * - **reactions are faces, never digits**, including in the accessible name;
 * - **the feed ends, visibly**, and says so;
 * - **consecutive activity coalesces** into one digest card;
 * - **a guest gets a `<p>`, not an `EmptyState`** with an action that would 403.
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
const KUDOS_ID = '88888888-8888-4888-8888-888888888888';

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

function activityItem(id: string, summary: string) {
  return {
    kind: 'activity' as const,
    id,
    createdAt: NOW,
    activity: {
      id,
      actorId: OTHER_ID,
      verb: 'task.completed',
      entityType: 'task',
      entityId: POST_ID,
      summary,
      metadata: {},
      createdAt: NOW,
    },
  };
}

function postItem() {
  return {
    kind: 'post' as const,
    id: POST_ID,
    createdAt: NOW,
    post: {
      id: POST_ID,
      authorId: ME_ID,
      type: 'announcement' as const,
      title: 'В субботу едем к бабушке',
      body: 'Выезжаем в 10:00, не проспите.',
      pinnedUntil: null,
      isPinned: false,
      commentCount: 0,
      reactions: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function kudosItem() {
  return {
    kind: 'kudos' as const,
    id: KUDOS_ID,
    createdAt: NOW,
    kudos: {
      id: KUDOS_ID,
      fromUserId: OTHER_ID,
      toUserId: ME_ID,
      occurrenceId: null,
      emoji: '\u{1F64F}',
      message: 'спасибо, что полила цветы',
      createdAt: NOW,
      toDisplayName: 'Мама',
      commentCount: 0,
      reactions: [{ emoji: '❤️', count: 7, reacted: false, userIds: [OTHER_ID] }],
    },
  };
}

function feedPayload(
  overrides: Partial<{
    items: unknown[];
    pinned: unknown[];
    openPolls: unknown[];
    nextCursor: string | null;
  }> = {},
) {
  return {
    pinned: overrides.pinned ?? [],
    openPolls: overrides.openPolls ?? [],
    items: overrides.items ?? [activityItem(ACTIVITY_ID, ACTIVITY_SUMMARY), postItem()],
    nextCursor: overrides.nextCursor ?? null,
    clearedAt: null,
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
    commentCount: 0,
    reactions: [],
    createdAt: NOW,
  };
}

const FAKE_ROSTER: Roster = {
  byId: new Map<string, PublicUser>(ROSTER.items.map((m) => [m.id, m as PublicUser])),
  members: ROSTER.items as PublicUser[],
  nameOf: (id) => (id === ME_ID ? 'Мама' : id ? 'Лиза' : WALL_RU.feed.systemAuthor),
};

/** Ids the contract will actually accept — `idSchema` is a UUID. */
function uuid(n: number): string {
  const digit = String(n).repeat(1);
  return `aaaaaaa${digit}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
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

/** Answers the feed and the roster; everything else still throws. */
function serveFeed(payload: unknown) {
  getSpy.mockImplementation((path: string) => {
    if (path === '/members') return Promise.resolve(ROSTER as never);
    if (path === '/wall/feed') return Promise.resolve(payload as never);
    if (path === '/wall/polls') return Promise.resolve({ items: [], nextCursor: null } as never);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

/* -------------------------------------------------------------------------- */
/* the one door                                                                */
/* -------------------------------------------------------------------------- */

describe('the one door', () => {
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

  it('skips the menu when the reader may put exactly one thing on the wall', async () => {
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

  /**
   * §D7.5, the rule the whole screen turns on: the compose affordance is a
   * `<button>`, never a field, and nothing on Стена raises the keyboard.
   */
  it('puts a button at the top of the feed and never a text field', async () => {
    serveFeed(feedPayload());
    const { container } = renderWithProviders(
      <BoardComposeProvider>
        <WallStream />
      </BoardComposeProvider>,
      ['post:create'],
    );

    expect(await screen.findByText(WALL_RU.feed.composePlaceholder)).toBeInTheDocument();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('[contenteditable]')).toBeNull();
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

describe('«Очистить доску»', () => {
  it('is offered to a holder of settings:manage and to nobody else', () => {
    const { unmount } = renderWithProviders(<ClearWallMenu />, ['settings:manage']);
    expect(screen.getByRole('button', { name: WALL_RU.clear.menuAria })).toBeInTheDocument();
    unmount();

    // An adult may moderate one note (`post:delete:any`); resetting what six
    // people see is a different authority, and they get no `⋯` at all — not a
    // disabled one (§D7.11).
    renderWithProviders(<ClearWallMenu />, ['post:delete:any', 'post:pin']);
    expect(screen.queryByRole('button', { name: WALL_RU.clear.menuAria })).not.toBeInTheDocument();
  });

  it('names what stays, and counts nothing', () => {
    // The dialog copy is the promise the feature makes: open polls survive,
    // nothing is destroyed, and there is no row count to make the action feel
    // bigger or smaller than it is.
    expect(WALL_RU.clear.confirmDescription).toContain('Открытые опросы останутся');
    expect(WALL_RU.clear.confirmDescription).toContain('Ничего не удаляется навсегда');
    expect(WALL_RU.clear.confirmDescription).not.toMatch(/\d/);
  });
});

/* -------------------------------------------------------------------------- */
/* reactions — faces, never digits                                             */
/* -------------------------------------------------------------------------- */

describe('reactions', () => {
  it('draws the reactors and no digit, on screen or to a screen reader', async () => {
    const { container } = renderWithProviders(
      <ReactionBar
        target={{ entityType: 'post', entityId: POST_ID }}
        reactions={[{ emoji: '❤️', count: 3, reacted: false, userIds: [ME_ID, OTHER_ID] }]}
        roster={{ ...FAKE_ROSTER, byId: new Map(ROSTER.items.map((m) => [m.id, m as PublicUser])) }}
      />,
      ['kudos:give'],
    );

    // The accessible name is exactly what is drawn: the emoji and the people.
    expect(screen.getByRole('button', { name: '❤️ — Мама, Лиза' })).toBeInTheDocument();

    /*
      The whole subtree, markup included — `title`, `aria-label` and every text
      node. A load bar on Семья once read «40 % (своя доля 33 %)» aloud while
      drawing no numbers at all; this is the assertion that stops the same leak
      here. `3` is the count under test.
    */
    expect(container.innerHTML).not.toMatch(/>\s*3\s*</);
    expect(container.innerHTML).not.toContain('❤️ 3');
  });

  it('rolls the optimistic toggle back when it fails', async () => {
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
        reactions={[{ emoji: '❤️', count: 1, reacted: false, userIds: [OTHER_ID] }]}
        roster={{ ...FAKE_ROSTER, byId: new Map(ROSTER.items.map((m) => [m.id, m as PublicUser])) }}
      />,
      ['kudos:give'],
    );

    const chip = screen.getByRole('button', { name: '❤️ — Лиза' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);

    // Optimistic: the reader's own face joins the chip before the server has
    // said anything.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '❤️ — Лиза, Мама' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    rejectToggle?.(new ApiError({ code: 'INTERNAL_ERROR', status: 500 }));

    // …and it comes back exactly as it was once the request fails.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '❤️ — Лиза' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });
  });

  it('gives a reader who may not react static text rather than a dead control', () => {
    renderWithProviders(
      <ReactionBar
        target={{ entityType: 'post', entityId: POST_ID }}
        reactions={[{ emoji: '❤️', count: 1, reacted: false, userIds: [OTHER_ID] }]}
        roster={FAKE_ROSTER}
      />,
      ['event:read'],
    );

    // A control that can be focused and pressed to no effect is worse than no
    // control (§D7.7).
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '❤️ — Лиза' })).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* the head                                                                    */
/* -------------------------------------------------------------------------- */

describe('the floating head', () => {
  const pinned = {
    id: POST_ID,
    authorId: ME_ID,
    type: 'announcement' as const,
    title: 'Дверь закрывать',
    body: 'Пожалуйста',
    pinnedUntil: '2026-08-25T09:00:00.000Z',
    isPinned: true,
    commentCount: 0,
    reactions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('gives the wash to an unanswered poll, and hands it to the pin once answered', () => {
    const unanswered = buildHead({
      pinned: [pinned],
      openPolls: [poll({ isClosed: false, myOptionIds: [] })],
    });
    expect(unanswered[0]).toMatchObject({ kind: 'poll', tone: 'attention' });
    expect(unanswered[1]).toMatchObject({ kind: 'post', tone: 'plain' });

    // Answering re-evaluates the precedence in the same frame: exactly one
    // tinted card per screen, always (§C2 band 2).
    const answered = buildHead({
      pinned: [pinned],
      openPolls: [poll({ isClosed: false, myOptionIds: [OPTION_A] })],
    });
    expect(answered[0]).toMatchObject({ kind: 'post', tone: 'attention' });
    expect(answered.filter((card) => card.tone === 'attention')).toHaveLength(1);
  });

  it('caps itself at five cards, so it cannot become a section with the label filed off', () => {
    const head = buildHead({
      pinned: Array.from({ length: 9 }, (_, index) => ({ ...pinned, id: `pin-${String(index)}` })),
      openPolls: [],
    });
    expect(head).toHaveLength(5);
  });

  it('states the status in words, never by colour alone', async () => {
    serveFeed(
      feedPayload({
        items: [],
        openPolls: [poll({ isClosed: false, myOptionIds: [] })],
      }),
    );
    renderWithProviders(
      <BoardComposeProvider>
        <WallStream />
      </BoardComposeProvider>,
      ['poll:vote', 'post:create'],
    );

    expect(await screen.findByText(WALL_RU.polls.needsYou)).toBeInTheDocument();
    // …and no section header above it, at any width (§D7.0).
    expect(
      screen.queryByRole('heading', { name: /Решаем вместе|Закреплено|На доске/i }),
    ).toBeNull();
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

    serveFeed(
      feedPayload({ items: [], openPolls: [poll({ isClosed: false, myOptionIds: [OPTION_A] })] }),
    );
    // Never settles: we are asserting the optimistic state, not the response.
    postSpy.mockImplementation(() => new Promise(() => undefined));

    renderWithProviders(
      <BoardComposeProvider>
        <WallStream />
      </BoardComposeProvider>,
      ['poll:vote'],
    );

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
    // back, and the number of voters is unchanged. The card the reader is
    // looking at comes from the **feed** cache, which is the one the optimistic
    // patch used to miss.
    expect(screen.getByRole('radio', { name: /На дачу/ })).toHaveAttribute('aria-checked', 'false');
    expect(
      within(screen.getByRole('radio', { name: /На дачу/ })).getByText('33%'),
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

    expect(container.innerHTML).not.toMatch(/\b7\b/);
  });

  it('renders a thank-you as a card naming both people, with no tally', async () => {
    serveFeed(feedPayload({ items: [kudosItem()] }));

    const { container } = renderWithProviders(
      <BoardComposeProvider>
        <WallStream />
      </BoardComposeProvider>,
      ['post:create', 'kudos:give'],
    );

    expect(await screen.findByText('спасибо, что полила цветы')).toBeInTheDocument();
    expect(screen.getByText(WALL_RU.kudos.cardEyebrow)).toBeInTheDocument();
    // Both people: the author line and the recipient row.
    expect(screen.getAllByText('Мама').length).toBeGreaterThan(0);

    // The reaction on the card carries seven reactors' worth of `count` in the
    // payload and must draw none of it.
    expect(container.innerHTML).not.toMatch(/\b7\b/);
  });
});

/* -------------------------------------------------------------------------- */
/* the stream                                                                  */
/* -------------------------------------------------------------------------- */

describe('the stream', () => {
  it('renders the server-rendered summary verbatim', async () => {
    serveFeed(feedPayload());

    renderWithProviders(
      <BoardComposeProvider>
        <WallStream />
      </BoardComposeProvider>,
      ['post:create'],
    );

    // Exact string, not a fragment: the sentence is frozen at write time and the
    // client must not re-compose it from `verb` + entity.
    expect(await screen.findByText(ACTIVITY_SUMMARY)).toBeInTheDocument();
    // …and the announcement beside it still has its own title, so the two
    // layers of the feed stay visually distinct.
    expect(screen.getByText('В субботу едем к бабушке')).toBeInTheDocument();
  });

  /**
   * §D7.6. Without this, a Saturday of chores produces twenty near-identical
   * muted lines and the announcement about Sunday sits below all of them.
   */
  it('coalesces a run of consecutive activity into one card', () => {
    const blocks = coalesceFeed([
      activityItem(uuid(1), 'Лиза полила цветы'),
      activityItem(uuid(2), 'Павел выполнил задачу'),
      activityItem(uuid(3), 'Мама купила 4 позиции'),
      activityItem(uuid(4), 'Папа вынес мусор'),
      postItem(),
      activityItem(uuid(5), 'Лиза убрала со стола'),
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ kind: 'digest' });
    expect(blocks[0]?.kind === 'digest' && blocks[0].items).toHaveLength(4);
    expect(blocks[1]).toMatchObject({ kind: 'card' });
    // The rule is about runs, not about a minimum: a single line between two
    // cards is still a digest card of the same kind.
    expect(blocks[2]).toMatchObject({ kind: 'digest' });
  });

  it('shows three activity lines and expands the rest in place', async () => {
    const user = userEvent.setup();
    serveFeed(
      feedPayload({
        items: [
          activityItem(uuid(1), 'Лиза полила цветы'),
          activityItem(uuid(2), 'Павел выполнил задачу'),
          activityItem(uuid(3), 'Мама купила продукты'),
          activityItem(uuid(4), 'Папа вынес мусор'),
          activityItem(uuid(5), 'Лиза убрала со стола'),
        ],
      }),
    );

    renderWithProviders(
      <BoardComposeProvider>
        <WallStream />
      </BoardComposeProvider>,
      ['post:create'],
    );

    expect(await screen.findByText('Лиза полила цветы')).toBeInTheDocument();
    expect(screen.queryByText('Папа вынес мусор')).not.toBeInTheDocument();

    // «и ещё 2» expands in place: the items are already in the page, so this
    // fetches nothing and navigates nowhere.
    await user.click(screen.getByRole('button', { name: WALL_RU.feed.andMore(2) }));
    expect(screen.getByText('Папа вынес мусор')).toBeInTheDocument();
    expect(getSpy).toHaveBeenCalledTimes(2); // the feed and the roster, and nothing else
  });

  /**
   * §D7.9, the largest departure from the apps whose shape this borrows. An
   * Instagram feed never bottoms out because bottoming out is when you leave.
   */
  it('ends visibly when there is nothing more', async () => {
    serveFeed(feedPayload());

    renderWithProviders(
      <BoardComposeProvider>
        <WallStream />
      </BoardComposeProvider>,
      ['post:create'],
    );

    expect(await screen.findByText(WALL_RU.feed.end)).toBeInTheDocument();
  });

  it('draws no digit anywhere in a feed full of reactions and votes', async () => {
    serveFeed(
      feedPayload({
        items: [
          {
            ...postItem(),
            post: {
              ...postItem().post,
              reactions: [
                { emoji: '❤️', count: 3, reacted: false, userIds: [ME_ID, OTHER_ID] },
                { emoji: '\u{1F44D}', count: 1, reacted: true, userIds: [ME_ID] },
              ],
            },
          },
        ],
      }),
    );

    const { container } = renderWithProviders(
      <BoardComposeProvider>
        <WallStream />
      </BoardComposeProvider>,
      ['post:create', 'kudos:give'],
    );

    await screen.findByText('В субботу едем к бабушке');

    // The scoreboard rule, applied to the whole rendered subtree: no reaction
    // count is drawn, titled, or narrated. `Обсуждение · N` is exempt by
    // §D7.8 and this feed has no comments on it.
    const chips = container.querySelectorAll('[aria-pressed]');
    expect(chips.length).toBe(2);
    for (const chip of chips) {
      expect(chip.getAttribute('aria-label') ?? '').not.toMatch(/\d/);
      expect(chip.textContent ?? '').not.toMatch(/\d/);
    }
  });

  it('invites a reader who may write, and lies to nobody who may not', async () => {
    serveFeed(feedPayload({ items: [] }));

    const { unmount } = renderWithProviders(
      <BoardComposeProvider>
        <WallStream />
      </BoardComposeProvider>,
      ['post:create'],
    );

    // The compose row *is* the invitation, so there is no illustration above
    // it — just one quiet line under it.
    expect(await screen.findByText(WALL_RU.feed.emptyInvite)).toBeInTheDocument();
    expect(screen.getByText(WALL_RU.feed.composePlaceholder)).toBeInTheDocument();
    unmount();

    renderWithProviders(
      <BoardComposeProvider>
        <WallStream />
      </BoardComposeProvider>,
      ['event:read'],
    );

    // A guest: a two-line `<p>`, no compose row, and **no button that would
    // 403** — §E made `EmptyState.action` required, and there is no honest
    // action to offer here (§D7.12).
    expect(await screen.findByText(WALL_RU.feed.emptyReadOnly)).toBeInTheDocument();
    expect(screen.queryByText(WALL_RU.feed.composePlaceholder)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: WALL_RU.compose.open })).not.toBeInTheDocument();
  });
});
