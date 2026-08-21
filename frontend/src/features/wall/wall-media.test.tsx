import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  MEDIA_LIMITS,
  type MediaAttachment,
  type Permission,
  type PublicUser,
} from '@family/shared';

import { api } from '@/shared/api/client';
import { ApiError } from '@/shared/api/errors';
import { meKeys } from '@/shared/auth/use-me';
import { makeMe } from '@/test/me';
import { TooltipProvider } from '@/shared/ui/tooltip';

import { AnnouncementComposer } from './components/AnnouncementComposer';
import { AnnouncementNote } from './components/AnnouncementNote';
import { CommentThread } from './components/CommentThread';
import { MediaBlock } from './components/MediaBlock';
import { ReactionBar } from './components/ReactionBar';
import type { Roster } from './hooks';
import { WALL_RU } from './locale';
import { formatClock, reservedRatio, spellDuration } from './media/limits';

/**
 * Вложения and the like (§D7.7, §D7.14).
 *
 * These are the rules that would rot silently, and each one has a specific way
 * of rotting:
 *
 * - **The heart is drawn before anybody has used it.** The regression is not a
 *   crash — it is a card whose foot line is `☺+` alone, so a like costs two
 *   taps and a popover, which is the exact shape D14 was written to kill.
 * - **No digit reaches a screen reader.** A load bar on Семья once read
 *   «40 % (своя доля 33 %)» aloud while drawing nothing, so the assertion has
 *   to read `aria-label` and `title` rather than visible text.
 * - **The aspect box is reserved from the server's numbers, before any byte
 *   arrives.** The regression here is invisible in a screenshot and obvious to
 *   a thumb: a feed that reflows while you read it.
 * - **The submit gate takes attachments into account.** A photo with no caption
 *   is a whole note, and the backend already allows it; a client that does not
 *   refuses what the server would take.
 */

/* -------------------------------------------------------------------------- */
/* mocks                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The upload transport, stubbed.
 *
 * `uploadMedia` is an `XMLHttpRequest` on purpose (it is the only thing in the
 * platform with `upload.onprogress`), and jsdom has no network. The contract
 * under test here is the composer's, not the transport's: pick a file → a tile
 * → an id in `attachmentIds` → «Повесить» becomes pressable.
 */
const uploadMock = vi.hoisted(() => vi.fn());
vi.mock('./media/upload', () => ({
  uploadMedia: uploadMock,
  discardDraft: vi.fn(() => Promise.resolve()),
  isAbort: (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
}));

/**
 * The encode step, stubbed to a pass-through.
 *
 * `preparePhoto` decodes through an `<img>` (deliberately — `createImageBitmap`
 * drops EXIF orientation) and jsdom never fires `load` **or** `error` for one,
 * so the real function would hang rather than fail. Its own behaviour is not
 * what these tests are about.
 */
vi.mock('./media/encode', () => ({
  preparePhoto: (file: File) => Promise.resolve(file),
  probeDuration: () => Promise.resolve(1000),
  PhotoDecodeError: class extends Error {},
}));

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const ME_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ID = '55555555-5555-4555-8555-555555555555';
const POST_ID = '66666666-6666-4666-8666-666666666666';
const NOW = '2026-08-19T09:00:00.000Z';

const MEMBERS: PublicUser[] = [
  {
    id: ME_ID,
    displayName: 'Мама',
    avatarUrl: null,
    color: null,
    role: 'adult',
    status: 'active',
  } as PublicUser,
  {
    id: OTHER_ID,
    displayName: 'Лиза',
    avatarUrl: null,
    color: null,
    role: 'teen',
    status: 'active',
  } as PublicUser,
];

const ROSTER: Roster = {
  byId: new Map(MEMBERS.map((member) => [member.id, member])),
  members: MEMBERS,
  nameOf: (id) => (id === ME_ID ? 'Мама' : id ? 'Лиза' : WALL_RU.feed.systemAuthor),
};

function attachment(overrides: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'image',
    contentType: 'image/jpeg',
    url: '/media/aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    byteSize: 120_000,
    width: 1600,
    height: 1200,
    durationMs: null,
    createdAt: NOW,
    ...overrides,
  };
}

function photos(n: number): MediaAttachment[] {
  return Array.from({ length: n }, (_, index) =>
    attachment({
      id: `aaaaaaa${String(index)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      url: `/media/aaaaaaa${String(index)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    }),
  );
}

function post(
  overrides: {
    body?: string;
    attachments?: MediaAttachment[];
    hiddenAttachments?: number;
  } = {},
) {
  return {
    id: POST_ID,
    authorId: ME_ID,
    type: 'announcement' as const,
    title: null,
    body: overrides.body ?? 'Выезжаем в 10:00',
    pinnedUntil: null,
    isPinned: false,
    commentCount: 0,
    reactions: [],
    attachments: overrides.attachments ?? [],
    hiddenAttachments: overrides.hiddenAttachments ?? 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/* -------------------------------------------------------------------------- */
/* harness                                                                     */
/* -------------------------------------------------------------------------- */

let queryClient: QueryClient;

function renderWithProviders(ui: ReactNode, permissions: Permission[]) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData(meKeys.detail(), makeMe({ id: ME_ID, email: null, permissions }));
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

const getSpy = vi.spyOn(api, 'get');
const postSpy = vi.spyOn(api, 'post');

/*
  jsdom implements no media pipeline: `play()` raises "Not implemented" into the
  virtual console and returns `undefined`, so the `.catch()` every call site has
  would itself throw. Stubbing the two methods **once, at module scope** is what
  lets the decisions around playback be tested — which src the element is given,
  and what happens when it errors — without pretending jsdom can decode
  anything. Not in `beforeEach`, and never restored: a `restoreAllMocks` would
  also detach the two `api` spies above from the module they are spying on, and
  every later test in this file would then hit the real fetch wrapper.
*/
const playSpy = vi
  .spyOn(HTMLMediaElement.prototype, 'play')
  .mockImplementation(() => Promise.resolve());
vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);

beforeEach(() => {
  uploadMock.mockReset();
  uploadMock.mockImplementation((_file: Blob) => Promise.resolve(attachment()));
  getSpy.mockReset();
  postSpy.mockReset();
  getSpy.mockImplementation((path: string) => {
    if (path === '/members') return Promise.resolve({ items: MEMBERS } as never);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  postSpy.mockImplementation((path: string) =>
    Promise.reject(new Error(`unexpected POST ${path}`)),
  );
  playSpy.mockClear();
  // Every media element resolves its bytes through `fetch` with a bearer token
  // (there is no cookie fallback on `GET /api/media/:id`). Refuse them all: what
  // is under test is the box that is reserved *before* they arrive.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
  );
  // jsdom ships no `createObjectURL`. Patch the two statics rather than
  // replacing `URL` wholesale — spreading a class does not carry its statics,
  // and the missing `revokeObjectURL` then throws out of a cleanup effect,
  // which surfaces as a failure in whichever test happens to unmount next.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:mock'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

function jpeg(name: string, size = 1024): File {
  const file = new File([new Uint8Array(8)], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/* -------------------------------------------------------------------------- */
/* the like                                                                    */
/* -------------------------------------------------------------------------- */

describe('the like', () => {
  it('draws the heart on a card nobody has touched, as a pressable control', () => {
    renderWithProviders(
      <ReactionBar
        target={{ entityType: 'post', entityId: POST_ID }}
        reactions={[]}
        roster={ROSTER}
      />,
      ['kudos:give'],
    );

    // §D7.7a. A like behind a popover is not a like: the previous drawing left
    // a fresh card with nothing on its foot line but `☺+`.
    const heart = screen.getByRole('button', { name: WALL_RU.reactions.like });
    expect(heart).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the heart inside the picker as well, so there are not two kinds of heart', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReactionBar
        target={{ entityType: 'post', entityId: POST_ID }}
        reactions={[]}
        roster={ROSTER}
      />,
      ['kudos:give'],
    );

    await user.click(screen.getByRole('button', { name: WALL_RU.reactions.addAria }));
    // The promoted chip is a shortcut, not an exclusion (§D7.7a).
    expect(await screen.findByRole('button', { name: '❤️' })).toBeInTheDocument();
  });

  it('draws exactly one heart once somebody has used it', () => {
    renderWithProviders(
      <ReactionBar
        target={{ entityType: 'post', entityId: POST_ID }}
        reactions={[{ emoji: '❤️', count: 1, reacted: true, userIds: [OTHER_ID] }]}
        roster={ROSTER}
      />,
      ['kudos:give'],
    );

    // Not two: the always-drawn chip and the used one are the same row.
    expect(screen.getAllByRole('button', { name: /❤️/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '❤️ — Лиза' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('offers a reader who may not react no empty heart to press', () => {
    renderWithProviders(
      <ReactionBar
        target={{ entityType: 'post', entityId: POST_ID }}
        reactions={[]}
        roster={ROSTER}
      />,
      ['event:read'],
    );

    // §D7.7d: static text where somebody has reacted, and *nothing* where
    // nobody has. A control that can be focused and pressed to no effect is
    // worse than no control.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('puts no digit on the heart, on screen or in the accessible layer', () => {
    const { container } = renderWithProviders(
      <ReactionBar
        target={{ entityType: 'post', entityId: POST_ID }}
        reactions={[{ emoji: '❤️', count: 2, reacted: false, userIds: [ME_ID, OTHER_ID] }]}
        roster={ROSTER}
      />,
      ['kudos:give'],
    );

    for (const element of container.querySelectorAll('*')) {
      expect(element.getAttribute('aria-label') ?? '').not.toMatch(/\d/);
      expect(element.getAttribute('title') ?? '').not.toMatch(/\d/);
    }
    expect(container.textContent ?? '').not.toMatch(/\d/);
  });
});

/* -------------------------------------------------------------------------- */
/* the reserved box                                                            */
/* -------------------------------------------------------------------------- */

describe('the reserved aspect box', () => {
  it('clamps only the tall end, at 4:5', () => {
    // A landscape photo keeps its own shape — a panorama is short and harms
    // nothing, so the wide end is unclamped.
    expect(reservedRatio(attachment({ width: 1600, height: 1200 }))).toBeCloseTo(4 / 3);
    // A 9:19.5 iPhone screenshot is drawn in a 4:5 box, `object-fit: cover`.
    expect(reservedRatio(attachment({ width: 1179, height: 2556 }))).toBeCloseTo(0.8);
    // Portrait, but milder than the clamp: kept.
    expect(reservedRatio(attachment({ width: 1200, height: 1400 }))).toBeCloseTo(1200 / 1400);
    // Audio has no box at all, and `null` says so rather than guessing one.
    expect(reservedRatio(attachment({ kind: 'audio', width: null, height: null }))).toBeNull();
  });

  it('is on the DOM before a single byte has arrived', () => {
    const { container } = renderWithProviders(
      <MediaBlock attachments={[attachment({ width: 1600, height: 1200 })]} authorName="Мама" />,
      ['kudos:give'],
    );

    // Every fetch in this file 404s, so nothing has loaded — and the box is
    // there anyway. That is the whole property: no layout shift when media
    // arrives, because the space was never not there.
    const box = container.querySelector('[style*="aspect-ratio"]');
    expect(box).not.toBeNull();
    expect(box?.getAttribute('style')).toContain('aspect-ratio: 1.333');
    expect(box?.getAttribute('style')).toContain('max-height: 60dvh');
  });

  it('caps the box in a comment shorter than the one on a card', () => {
    const { container } = renderWithProviders(
      <MediaBlock
        attachments={[attachment()]}
        authorName="Мама"
        tone="inset"
        maxHeight="comment"
      />,
      ['kudos:give'],
    );
    expect(container.querySelector('[style*="aspect-ratio"]')?.getAttribute('style')).toContain(
      'max-height: 240px',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* the grid                                                                    */
/* -------------------------------------------------------------------------- */

describe('the photo grid', () => {
  it('names every photo for a reader who cannot see it', () => {
    renderWithProviders(<MediaBlock attachments={photos(4)} authorName="Мама" />, ['kudos:give']);

    // Never empty and never «изображение» (§D7.14.8). `alt=""` means
    // decorative, and a photo that is the content of a post is not.
    expect(screen.getAllByRole('button', { name: /Фото 1 из 4 — Мама/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Фото 4 из 4 — Мама/ })).toHaveLength(1);
  });

  it('stops at four, so a «+N» tile can never be drawn', () => {
    // The cap is a layout fact, not a resource limit: four is what the grid
    // holds without a counter, and a counter is a digit on a card (§D7.7b).
    renderWithProviders(<MediaBlock attachments={photos(6)} authorName="Мама" />, ['kudos:give']);
    expect(screen.getAllByRole('button', { name: /^Фото/ })).toHaveLength(4);
  });
});

/* -------------------------------------------------------------------------- */
/* video and audio                                                             */
/* -------------------------------------------------------------------------- */

describe('video and audio', () => {
  const video = attachment({
    kind: 'video',
    contentType: 'video/quicktime',
    width: 1920,
    height: 1080,
    durationMs: 42_000,
  });

  it('fetches nothing until somebody asks to watch', () => {
    renderWithProviders(<MediaBlock attachments={[video]} authorName="Павел" />, ['kudos:give']);

    // §D7.14.5. Fifteen cards of video cost fifteen nothing — which matters
    // more here than the design assumed, because there is no poster object and
    // the whole file is what would otherwise be fetched.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Смотреть/ })).toBeInTheDocument();
  });

  it('draws the duration as a pill and spells it for a screen reader', () => {
    const { container } = renderWithProviders(
      <MediaBlock attachments={[video]} authorName="Павел" />,
      ['kudos:give'],
    );

    /*
      The one number allowed on this screen, and it passes D7.2 cleanly: a
      clip's length is not sayable any other way, it is not attached to a
      person, and nothing sorts by it. Drawn as «0:42», spoken as «42 секунды» —
      a screen reader reading the pill would say "ноль двоеточие сорок два".
    */
    expect(container.textContent).toContain('0:42');
    expect(screen.getByRole('button', { name: /Видео — Павел, 42 секунды/ })).toBeInTheDocument();
    // …and the pill itself is hidden, so the number is announced once.
    expect(container.querySelector('[aria-hidden="true"].tabular-nums')?.textContent).toBe('0:42');
  });

  it('draws audio as a row rather than a box', () => {
    const { container } = renderWithProviders(
      <MediaBlock
        attachments={[
          attachment({
            kind: 'audio',
            contentType: 'audio/mp4',
            width: null,
            height: null,
            durationMs: 72_000,
          }),
        ]}
        authorName="Бабушка"
      />,
      ['kudos:give'],
    );

    // Distinguishable from a video *because it is a different shape*, not
    // because of an icon (§B4: colour is never the only signal, and neither is
    // a glyph). So: no reserved aspect box anywhere in the subtree.
    expect(container.querySelector('[style*="aspect-ratio"]')).toBeNull();
    expect(
      screen.getByRole('button', { name: /Голосовая запись — Бабушка, 1 минута 12 секунд/ }),
    ).toBeInTheDocument();
  });

  it('spells durations the way Russian does', () => {
    expect(formatClock(42_000)).toBe('0:42');
    expect(formatClock(72_000)).toBe('1:12');
    expect(spellDuration(1000)).toBe('1 секунда');
    expect(spellDuration(3000)).toBe('3 секунды');
    expect(spellDuration(11_000)).toBe('11 секунд');
    expect(spellDuration(72_000)).toBe('1 минута 12 секунд');
    expect(spellDuration(120_000)).toBe('2 минуты');
  });
});

/* -------------------------------------------------------------------------- */
/* a card that is media and nothing else                                       */
/* -------------------------------------------------------------------------- */

describe('a note with media and no caption', () => {
  it('draws the photo and nothing in place of the missing words', () => {
    const { container } = renderWithProviders(
      <AnnouncementNote post={post({ body: '', attachments: photos(1) })} roster={ROSTER} />,
      ['kudos:give'],
    );

    // §D7.14.4: no «без описания», no placeholder, no italic hint. An absent
    // caption is not an error state — the reader is looking at the photo.
    expect(container.textContent).not.toContain('без описания');
    expect(screen.getByRole('button', { name: /Фото — Мама/ })).toBeInTheDocument();
    // The body element is absent entirely rather than present and empty, so
    // nothing reserves a line of nothing above the photo.
    expect(container.querySelector('.line-clamp-4')).toBeNull();
  });

  it('draws no digit anywhere on a card carrying four photos and a full foot line', () => {
    const { container } = renderWithProviders(
      <AnnouncementNote
        post={{
          ...post({ attachments: photos(4) }),
          reactions: [{ emoji: '❤️', count: 2, reacted: false, userIds: [ME_ID, OTHER_ID] }],
        }}
        roster={ROSTER}
      />,
      ['kudos:give'],
    );

    // The scoreboard rule at the level of the drawn pixel *and* the read-aloud
    // string. The two exemptions are named rather than assumed: «Обсуждение · N»
    // (§D7.8) — this card has no comments — and a clip's duration (§D7.14.4) —
    // this card has no clip. Everything else must be digit-free.
    for (const chip of container.querySelectorAll('[aria-pressed]')) {
      expect(chip.getAttribute('aria-label') ?? '').not.toMatch(/\d/);
      expect(chip.textContent ?? '').not.toMatch(/\d/);
    }
    // The photo labels say «Фото 1 из 4», which is a position and not a tally —
    // so the sweep below excludes them by looking only at the foot line.
    const foot = container.querySelector('[aria-expanded]')?.parentElement;
    expect(foot?.textContent ?? '').not.toMatch(/\d/);
  });
});

/* -------------------------------------------------------------------------- */
/* the composer                                                                */
/* -------------------------------------------------------------------------- */

describe('the composer', () => {
  function openComposer(permissions: Permission[] = ['post:create', 'comment:create']) {
    return renderWithProviders(
      <AnnouncementComposer open onOpenChange={() => undefined} />,
      permissions,
    );
  }

  function fileInput(): HTMLInputElement {
    // The sheet renders through a portal, so the attach control is on
    // `document.body` rather than inside the render container.
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('the composer has no attach control');
    return input;
  }

  it('offers one control, with no `capture` and never the broken audio wildcard', () => {
    openComposer();
    const input = fileInput();

    // `capture` short-circuits WKFileUploadPanel to the system camera and
    // *removes* «Фотогалерея» and «Выбрать файл» — the opposite of what an
    // "add a photo to this note" flow wants (§D7.14.3).
    expect(input.hasAttribute('capture')).toBe(false);
    // WebKit bug 242110 maps the `audio/*` wildcard to `UTTypeMovie`. The
    // explicit audio types do not take that branch.
    expect(input.accept).not.toContain('audio/*');
    expect(input.accept).toContain('image/*');
    expect(input.accept).toContain('video/*');
  });

  it('lets a photo with no caption be posted, and refuses an empty note', async () => {
    const user = userEvent.setup();
    openComposer();

    const publish = screen.getByRole('button', { name: WALL_RU.post.publish });
    // Neither words nor an attachment: still a bug, and still refused.
    expect(publish).toBeDisabled();

    await user.upload(fileInput(), jpeg('photo.jpg'));

    // §D7.14.4 — a photo with no caption is a whole note, and the backend
    // already allows it. The gate is `body || attachments`, not `body`.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: WALL_RU.post.publish })).toBeEnabled();
    });
  });

  it('holds «Повесить» shut while a tile is still going up, and says why', async () => {
    const user = userEvent.setup();
    let finish: ((value: MediaAttachment) => void) | undefined;
    uploadMock.mockImplementation(
      () =>
        new Promise<MediaAttachment>((resolve) => {
          finish = resolve;
        }),
    );

    openComposer();
    await user.upload(fileInput(), jpeg('slow.jpg'));

    await waitFor(() => {
      // In words, rather than a dead button with no explanation (§D7.14.7).
      expect(screen.getByText(WALL_RU.media.uploadingFooter)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: WALL_RU.post.publish })).toBeDisabled();

    finish?.(attachment());
    await waitFor(() => {
      expect(screen.getByRole('button', { name: WALL_RU.post.publish })).toBeEnabled();
    });
  });

  it('offers a retry on the failed file only, and keeps the note postable', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/shared/api/errors');
    uploadMock.mockImplementationOnce(() =>
      Promise.reject(
        new ApiError({
          code: 'UNSUPPORTED_MEDIA_TYPE',
          status: 415,
          // The server's own sentence, surfaced verbatim rather than replaced
          // with a second wording that would then drift (§D7.14.6).
          details: { file: ['SVG — это документ, который умеет выполнять код.'] },
        }),
      ),
    );

    openComposer();
    await user.upload(fileInput(), jpeg('bad.jpg'));

    expect(
      await screen.findByText('SVG — это документ, который умеет выполнять код.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: WALL_RU.media.retry })).toBeInTheDocument();

    // A failed tile does **not** disable «Повесить»: a member may post the note
    // without the photo that would not go, and that is usually what they want.
    await user.type(screen.getByLabelText(WALL_RU.post.fieldBody), 'едем в 10');
    expect(screen.getByRole('button', { name: WALL_RU.post.publish })).toBeEnabled();

    uploadMock.mockImplementation(() => Promise.resolve(attachment()));
    await user.click(screen.getByRole('button', { name: WALL_RU.media.retry }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: WALL_RU.media.retry })).not.toBeInTheDocument();
    });
  });

  it('refuses a fifth photo at pick time rather than dropping it silently', async () => {
    const user = userEvent.setup();
    openComposer();

    await user.upload(fileInput(), [
      jpeg('1.jpg'),
      jpeg('2.jpg'),
      jpeg('3.jpg'),
      jpeg('4.jpg'),
      jpeg('5.jpg'),
    ]);

    expect(await screen.findByText(WALL_RU.media.tooMany)).toBeInTheDocument();
    // …and the trigger is gone, so there is no control offering a sixth.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: WALL_RU.media.add })).not.toBeInTheDocument();
    });
  });

  it('refuses a mixture of kinds', async () => {
    const user = userEvent.setup();
    openComposer();

    const clip = new File([new Uint8Array(8)], 'clip.mov', { type: 'video/quicktime' });
    await user.upload(fileInput(), [jpeg('1.jpg'), clip]);

    // «В одной записке — либо фото, либо видео, либо запись голоса.» A video in
    // tile 3 of a 2×2 grid is 178px wide with a play button in it.
    expect(await screen.findByText(WALL_RU.media.mixedKinds)).toBeInTheDocument();
  });

  it('refuses an oversized clip with the contract’s own number', async () => {
    const user = userEvent.setup();
    openComposer();

    const heavy = new File([new Uint8Array(8)], 'big.mov', { type: 'video/quicktime' });
    Object.defineProperty(heavy, 'size', { value: MEDIA_LIMITS.video.maxBytes + 1 });
    await user.upload(fileInput(), heavy);

    // Instantly, before a byte moves, and with the same megabyte figure the
    // server would have used — the constant is imported from the contract by
    // both sides.
    expect(await screen.findByText(/100 МБ/)).toBeInTheDocument();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('says nothing about a photo out loud while it uploads', async () => {
    const user = userEvent.setup();
    uploadMock.mockImplementation(() => new Promise<MediaAttachment>(() => undefined));
    openComposer();
    await user.upload(fileInput(), jpeg('photo.jpg'));

    const strip = await screen.findByRole('list');
    // A `role="progressbar"` here would put `aria-valuenow="40"` in the
    // accessibility tree — a number narrated on Стена, which is the exact leak
    // D14 records. The ring is decoration; the footer carries the meaning.
    expect(within(strip).queryByRole('progressbar')).not.toBeInTheDocument();
    for (const element of strip.querySelectorAll('*')) {
      expect(element.getAttribute('aria-label') ?? '').not.toMatch(/\d/);
      expect(element.getAttribute('aria-valuenow')).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* what a reader without `media:read` gets instead                             */
/* -------------------------------------------------------------------------- */

describe('a note whose photographs are not for this reader', () => {
  it('says so in place of the box, and the line knows how many', () => {
    renderWithProviders(
      <AnnouncementNote
        post={post({ body: 'В субботу едем к бабушке', hiddenAttachments: 3 })}
        roster={ROSTER}
      />,
      ['kudos:give'],
    );

    // §D7.14.10. One quiet line on `--muted` ground — not a lock-shaped hole,
    // not a blur, and above all not a blurred copy of the actual photograph.
    expect(screen.getByText('3 фото — только для семьи')).toBeInTheDocument();
    // The note itself is still a note. A guest reads the wall.
    expect(screen.getByText('В субботу едем к бабушке')).toBeInTheDocument();
  });

  it('reads differently for one photograph than for four — which is why it is a count', () => {
    // The whole reason `hiddenAttachments` is a number and not a boolean. A
    // line standing in for one photo must not be the same line that stands in
    // for four; at one the sentence is the design's own, verbatim.
    expect(WALL_RU.media.blocked(1)).toBe('Фото — только для семьи');
    expect(WALL_RU.media.blocked(4)).toBe('4 фото — только для семьи');
    expect(WALL_RU.media.blocked(1)).not.toBe(WALL_RU.media.blocked(4));
  });

  it('hands the reader nothing they could probe the delivery route with', () => {
    const { container } = renderWithProviders(
      <MediaBlock attachments={[]} hiddenCount={2} authorName="Мама" />,
      ['kudos:give'],
    );

    // No id, no url, no element that would go and ask for one. The route
    // answers them 404 anyway — this is the half of that which is drawn.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('audio')).toBeNull();
    expect(container.innerHTML).not.toContain('/media/');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('draws nothing at all on a note that simply has no photographs', () => {
    /*
      The trap this rule exists for. `attachments: []` is *also* what a note of
      plain words looks like, so a card that branched on the array being empty
      would put «только для семьи» under every text note in the feed. The
      branch is on the count, and only on the count.
    */
    const { container } = renderWithProviders(
      <AnnouncementNote post={post({ body: 'Купила молоко' })} roster={ROSTER} />,
      ['kudos:give'],
    );
    expect(container.textContent).not.toContain('только для семьи');
  });
});

/* -------------------------------------------------------------------------- */
/* playback tickets — the seek that was unreachable                            */
/* -------------------------------------------------------------------------- */

describe('playback tickets', () => {
  const VIDEO_ID = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const clip = attachment({
    id: VIDEO_ID,
    kind: 'video',
    contentType: 'video/quicktime',
    width: 1920,
    height: 1080,
    durationMs: 42_000,
  });

  const TICKET = `/api/media/${VIDEO_ID}/stream?t=m1.first`;
  const SECOND = `/api/media/${VIDEO_ID}/stream?t=m1.second`;

  function serveTickets(...urls: string[]) {
    let call = 0;
    postSpy.mockImplementation((path: string) => {
      if (path !== `/media/${VIDEO_ID}/ticket`) {
        return Promise.reject(new Error(`unexpected POST ${path}`));
      }
      const url = urls[call] ?? urls[urls.length - 1];
      call += 1;
      if (url === '404') {
        return Promise.reject(new ApiError({ code: 'NOT_FOUND', status: 404 }) as never);
      }
      return Promise.resolve({
        url,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      } as never);
    });
  }

  async function tapPlay(): Promise<void> {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Смотреть/ }));
  }

  it('mints nothing until somebody taps play, then puts the ticket straight in `src`', async () => {
    serveTickets(TICKET);
    const { container } = renderWithProviders(
      <MediaBlock attachments={[clip]} authorName="Павел" />,
      ['kudos:give'],
    );

    // §D7.14.5. A feed of four clips costs four *nothing* — the objection that
    // per-clip minting is four round trips before anything plays never arises,
    // because nothing is minted for a clip nobody has asked to watch.
    expect(postSpy).not.toHaveBeenCalled();

    await tapPlay();

    await waitFor(() => {
      expect(container.querySelector('video')?.getAttribute('src')).toBe(TICKET);
    });
    expect(postSpy).toHaveBeenCalledTimes(1);
    /*
      And it was **asked to play**, unconditionally.

      This assertion is not ceremony: `preload="none"` means the element loads
      nothing until something asks it to, so an arrangement that waited for
      `loadedmetadata` before calling `play()` deadlocks — `readyState` stays 0,
      no request is ever issued, and the card sits on a spinner for ever. That
      was a real bug in this file's first draft, and Chromium at 1440 was where
      it showed: WebKit loaded metadata of its own accord and hid it entirely.
    */
    expect(playSpy).toHaveBeenCalled();
    /*
      And the bytes did **not** come through `fetch`. That is the whole change:
      the URL is in `src`, so the browser's own media stack issues the range
      requests and a seek costs the part seeked to rather than the whole file.
    */
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('re-mints once when playback stops, and resumes where the reader was', async () => {
    serveTickets(TICKET, SECOND);
    const { container } = renderWithProviders(
      <MediaBlock attachments={[clip]} authorName="Павел" />,
      ['kudos:give'],
    );
    await tapPlay();

    const video = await waitFor(() => {
      const element = container.querySelector('video');
      expect(element?.getAttribute('src')).toBe(TICKET);
      return element as HTMLVideoElement;
    });

    // Twelve seconds in, the ticket ages out — or the range request is refused
    // for one of the three reasons the stream route re-checks every time.
    Object.defineProperty(video, 'currentTime', { value: 12, writable: true });
    fireEvent.error(video);

    await waitFor(() => {
      expect(container.querySelector('video')?.getAttribute('src')).toBe(SECOND);
    });
    expect(postSpy).toHaveBeenCalledTimes(2);

    // The seek waits for metadata, because `currentTime` on an element that
    // does not know its duration is silently dropped.
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(12);
    expect(playSpy).toHaveBeenCalled();
  });

  it('says the recording is gone when the re-mint itself answers 404', async () => {
    serveTickets(TICKET, '404');
    const { container } = renderWithProviders(
      <MediaBlock attachments={[clip]} authorName="Павел" />,
      ['kudos:give'],
    );
    await tapPlay();

    const video = await waitFor(() => {
      const element = container.querySelector('video');
      expect(element).not.toBeNull();
      return element as HTMLVideoElement;
    });
    fireEvent.error(video);

    /*
      The mint runs the same authorisation chain the stream route re-runs on
      every range request, so a 404 there is authoritative: the member was
      suspended, `media:read` was revoked, or the note was deleted while they
      watched. Different words from «Вложение не открылось», deliberately — it
      opened; it stopped.
    */
    expect(await screen.findByText(WALL_RU.media.playbackLost)).toBeInTheDocument();
    expect(screen.queryByText(WALL_RU.media.unavailable)).toBeNull();
  });

  it('stops after one re-mint, so an undecodable file is not a request loop', async () => {
    serveTickets(TICKET, SECOND);
    const { container } = renderWithProviders(
      <MediaBlock attachments={[clip]} authorName="Павел" />,
      ['kudos:give'],
    );
    await tapPlay();

    const video = await waitFor(() => {
      const element = container.querySelector('video');
      expect(element?.getAttribute('src')).toBe(TICKET);
      return element as HTMLVideoElement;
    });

    fireEvent.error(video);
    await waitFor(() => {
      expect(container.querySelector('video')?.getAttribute('src')).toBe(SECOND);
    });
    // A file the browser cannot decode raises `error` on every source it is
    // given. The second one is reported rather than minted against for ever.
    fireEvent.error(video);

    expect(await screen.findByText(WALL_RU.media.unavailable)).toBeInTheDocument();
    expect(postSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps a photograph on the plain immutable path, with no ticket anywhere', async () => {
    serveTickets(TICKET);
    renderWithProviders(<MediaBlock attachments={[attachment()]} authorName="Мама" />, [
      'kudos:give',
    ]);

    // A photo is not ranged, and `private, max-age=31536000, immutable` is
    // exactly what a fifteen-minute credential in the URL would spoil.
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });
    expect(postSpy).not.toHaveBeenCalled();
    const requested = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(requested.some((url) => url.includes('/stream'))).toBe(false);
    expect(requested.some((url) => url.includes('t='))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* the heart on a reply                                                        */
/* -------------------------------------------------------------------------- */

describe('the heart on a comment', () => {
  const COMMENT_ID = 'ccccccc1-cccc-4ccc-8ccc-cccccccccccc';

  function comment(overrides: Record<string, unknown> = {}) {
    return {
      id: COMMENT_ID,
      entityType: 'post' as const,
      entityId: POST_ID,
      authorId: OTHER_ID,
      body: 'и я тоже так думаю',
      reactions: [],
      attachments: [],
      hiddenAttachments: 0,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function serveThread(...comments: unknown[]) {
    getSpy.mockImplementation((path: string) => {
      if (path === '/members') return Promise.resolve({ items: MEMBERS } as never);
      if (path === `/posts/${POST_ID}/comments`) {
        return Promise.resolve({ items: comments, nextCursor: null } as never);
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
  }

  async function openThread(permissions: Permission[]) {
    const user = userEvent.setup();
    renderWithProviders(
      <CommentThread target={{ entityType: 'post', entityId: POST_ID }} commentCount={1} />,
      permissions,
    );
    await user.click(screen.getByRole('button', { name: /Обсуждение|Обсудить/ }));
    return user;
  }

  it('draws the heart on a reply nobody has touched, exactly as a card does', async () => {
    serveThread(comment());
    await openThread(['kudos:give']);

    // §D7.8a. `POST /api/comments/:id/reactions` is mounted now, so the chip is
    // a real control: drawn before anybody has used it, `aria-pressed`, first
    // position, at the same x on every row.
    const heart = await screen.findByRole('button', { name: WALL_RU.reactions.like });
    expect(heart).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggles against the comment’s own route, and never against a nested thread', async () => {
    serveThread(comment());
    postSpy.mockImplementation((path: string) => {
      if (path === `/comments/${COMMENT_ID}/reactions`) {
        return Promise.resolve({
          entityType: 'comment',
          entityId: COMMENT_ID,
          reactions: [{ emoji: '❤️', count: 1, reacted: true, userIds: [ME_ID] }],
        } as never);
      }
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });

    const user = await openThread(['kudos:give']);
    await user.click(await screen.findByRole('button', { name: WALL_RU.reactions.like }));

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith(`/comments/${COMMENT_ID}/reactions`, { emoji: '❤️' });
    });
  });

  it('puts no digit on the chip, in its title, or in its accessible name', async () => {
    serveThread(
      comment({
        reactions: [{ emoji: '❤️', count: 2, reacted: false, userIds: [ME_ID, OTHER_ID] }],
      }),
    );
    await openThread(['kudos:give']);
    await screen.findByText('и я тоже так думаю');

    // Same rule as §D7.7b, same test. Two faces, and nothing that says «2».
    for (const chip of document.body.querySelectorAll('[aria-pressed]')) {
      expect(chip.getAttribute('aria-label') ?? '').not.toMatch(/\d/);
      expect(chip.getAttribute('title') ?? '').not.toMatch(/\d/);
      expect(chip.textContent ?? '').not.toMatch(/\d/);
    }
  });

  it('offers a reply no thread of its own, and no picker', async () => {
    serveThread(comment());
    await openThread(['kudos:give', 'comment:create']);
    await screen.findByText('и я тоже так думаю');

    /*
      The backend widened reactions to `comment` and pointedly did not widen
      comments — `GET /api/comments/:id/comments` answers 404 by construction.
      A discussion on Стена is a flat list under a card, so there must be no
      affordance suggesting otherwise: exactly one thread toggle on screen (the
      post's own, which opened this list), and no second one under the reply.
    */
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1);
    // §D7.8a — no `☺+` on a comment: the post's full foot line under every
    // message is 44px of chrome per row.
    expect(screen.queryByRole('button', { name: WALL_RU.reactions.addAria })).toBeNull();
  });

  it('gives a reader who may not react no control row at all', async () => {
    serveThread(comment());
    await openThread([]);
    await screen.findByText('и я тоже так думаю');

    // A control that can be focused and pressed to no effect is worse than no
    // control (§D7.7d), and a thread of five plain messages stays five rows.
    expect(screen.queryByRole('button', { name: WALL_RU.reactions.like })).toBeNull();
  });
});
