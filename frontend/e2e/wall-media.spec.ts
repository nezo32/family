import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import type { Locator, Page } from '@playwright/test';

import { test, expect } from './fixtures';
import { ANONYMOUS, API, RUN_ID, assertClean, watch } from './helpers';

/**
 * Вложения on Стена — the measurements, not the pixels (§D7.14).
 *
 * ## Why these are e2e and not unit tests
 *
 * Three of the four rules below cannot be observed in jsdom at all, because
 * jsdom has no layout:
 *
 * - **The reserved aspect box** is a claim about *height in pixels before the
 *   bytes arrive*. `wall-media.test.tsx` asserts the inline `aspect-ratio`
 *   reaches the DOM; only a real engine can say whether the box that results is
 *   actually 448px tall at a 358px card and whether anything below it moves
 *   when the image lands.
 * - **No layout shift on load** is a comparison of two real bounding boxes
 *   across a real image decode.
 * - **Touch targets** are `getBoundingClientRect`, which jsdom answers `0` to
 *   for everything.
 *
 * The fourth — the composer's upload path — is here because it is the only
 * place the real `XMLHttpRequest`, the real canvas re-encode and the real
 * multipart body run together. `wall-media.test.tsx` stubs all three, on
 * purpose; something has to exercise them unstubbed.
 *
 * ## The fixtures are generated, not committed
 *
 * A PNG with real dimensions is thirty lines of `zlib`, and a committed binary
 * would be a file nobody can review in a diff. Video and audio are **not**
 * generated — a synthetic MP4 that a browser will actually decode is not thirty
 * lines — so those two cards are exercised by writing the `media_attachments`
 * row straight into the development database and letting the real feed serve
 * it. See `seedPostWithMedia` for why that beats intercepting the response.
 *
 * The honest split, stated: the upload path is exercised with real bytes end to
 * end; the *drawing* of a clip is exercised with real layout over a row whose
 * object does not exist, which is fine precisely because nothing here taps play.
 */

/**
 * The generated fixtures live in the OS temp directory, not in the repository.
 *
 * They are build output, not source: writing them under `e2e/` would mean a
 * `.gitignore` entry for files that exist only while a suite is running, and
 * one more directory for somebody to wonder about.
 */
const FIXTURES = path.join(tmpdir(), 'family-e2e-media');

/** A real PNG of the given size, written where `setInputFiles` can reach it. */
function png(name: string, w: number, h: number, tint: [number, number, number]): string {
  mkdirSync(FIXTURES, { recursive: true });
  const file = path.join(FIXTURES, name);
  writeFileSync(file, encodePng(w, h, tint));
  return file;
}

function encodePng(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.concat(
    Array.from({ length: h }, (_, y) => {
      const row = Buffer.alloc(1 + w * 3);
      for (let x = 0; x < w; x++) {
        row[1 + x * 3] = r;
        row[2 + x * 3] = (g + ((x + y) % 64)) & 0xff;
        row[3 + x * 3] = b;
      }
      return row;
    }),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The composer's file input. It is `sr-only`, so it is reached by selector. */
function attachInput(page: Page): Locator {
  return page.locator('input[type="file"]');
}

async function openWall(page: Page): Promise<void> {
  await page.goto('/wall');
  await expect(page.getByRole('heading', { name: 'Стена' }).first()).toBeVisible({
    timeout: 15_000,
  });
}

/* ========================================================================== */
/* the upload path, with real bytes                                           */
/* ========================================================================== */

test('a photo with no caption is a whole note', async ({ page }) => {
  const problems = watch(page);
  await openWall(page);

  await page
    .getByRole('button', { name: /Написать/ })
    .first()
    .click();
  const post = page.getByRole('button', { name: 'Объявление' });
  if (await post.isVisible().catch(() => false)) await post.click();

  const publish = page.getByRole('button', { name: 'Повесить' });
  // Neither words nor an attachment: still refused, exactly as the service is.
  await expect(publish).toBeDisabled();

  await attachInput(page).setInputFiles(png('landscape.png', 1600, 1200, [200, 120, 80]));

  // The upload starts the moment the file is picked — the member is still
  // typing — so «Повесить» goes from "nothing to post" through "wait for the
  // bytes" to enabled, without them touching the text field at all.
  await expect(publish).toBeEnabled({ timeout: 30_000 });
  await publish.click();

  const card = page.locator('article').filter({ has: page.getByRole('button', { name: /^Фото/ }) });
  await expect(card.first()).toBeVisible({ timeout: 15_000 });
  // §D7.14.4: nothing is drawn in place of the missing caption.
  await expect(card.first()).not.toContainText('без описания');

  assertClean(problems, 'wall with a caption-less photo');
});

/* ========================================================================== */
/* the reserved box                                                           */
/* ========================================================================== */

test('the media box is reserved before the bytes arrive, and nothing moves when they land', async ({
  page,
}) => {
  /*
    A phone, explicitly. The 4:5 clamp is only the *binding* constraint where
    `60dvh` is not — and `devices['Desktop Chrome']` is 1280×720, which is short
    enough that the height cap wins and the drawn box is landscape. §D7.14.2's
    own number ("448px at a 358px card") is a phone number, so it is asserted at
    a phone.
  */
  await page.setViewportSize({ width: 393, height: 852 });
  await openWall(page);

  /*
    Hold the image bytes back so the "before" measurement is genuinely before.
    The feed is not blocked — only `GET /api/media/:id` is — which is exactly
    the real-world case this rule exists for: a card that is on screen while its
    photograph is still coming down a phone connection.
  */
  let releaseImage: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  await page.route('**/api/media/*', async (route) => {
    await held;
    await route.continue();
  });

  await page
    .getByRole('button', { name: /Написать/ })
    .first()
    .click();
  const post = page.getByRole('button', { name: 'Объявление' });
  if (await post.isVisible().catch(() => false)) await post.click();
  // Unique, because the shared development feed already carries other cards
  // with photographs on them — including the ones this file's other tests post.
  const caption = `Портрет 4:5 ${String(Date.now())}`;
  await page.getByLabel('Текст').fill(caption);
  await attachInput(page).setInputFiles(png('portrait.png', 1200, 1600, [80, 140, 200]));
  await expect(page.getByRole('button', { name: 'Повесить' })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Повесить' }).click();

  const photo = page
    .locator('article')
    .filter({ hasText: caption })
    .getByRole('button', { name: /^Фото/ });
  await expect(photo).toBeVisible({ timeout: 15_000 });

  const before = await photo.boundingBox();
  expect(before, 'the box exists before the image does').not.toBeNull();
  expect(before?.height ?? 0).toBeGreaterThan(100);

  releaseImage?.();
  await expect(photo.locator('img')).toBeVisible({ timeout: 15_000 });
  await photo.locator('img').evaluate(
    (image: HTMLImageElement) =>
      image.complete ||
      new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true });
      }),
  );

  const after = await photo.boundingBox();
  // **No layout shift.** One pixel of tolerance for sub-pixel rounding; the
  // regression this guards moves a card by hundreds.
  expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);

  // 1200×1600 is 3:4, which is *taller* than the 4:5 clamp, so the drawn box is
  // 4:5 and the frame is cropped — the uncropped original is one tap away.
  const ratio = (after?.width ?? 1) / (after?.height ?? 1);
  expect(ratio).toBeGreaterThan(0.78);
  expect(ratio).toBeLessThan(0.82);
  // …and the other half of the rule: the box never exceeds 60dvh, whichever of
  // the two caps binds first.
  expect(after?.height ?? 0).toBeLessThanOrEqual(852 * 0.6 + 1);
});

/* ========================================================================== */
/* video and audio — seeded in the database, because the bytes are not         */
/* synthesisable                                                              */
/* ========================================================================== */

/**
 * A row straight into the development database.
 *
 * ## Why not `page.route`
 *
 * The obvious approach — intercept `GET /api/wall/feed` and rewrite the JSON —
 * **works in Chromium and silently does not work in WebKit here.** Measured:
 * a catch-all `page.route('**\/*')` on this app sees 19 API requests on
 * desktop-chrome and **2** on mobile-safari, so the feed's own fetch is simply
 * never handed to the handler. A test that "passes" on one project while
 * quietly asserting against the real feed on the other is worse than no test.
 *
 * Seeding is also the more faithful shape: the card is rendered from a real
 * `GET /api/wall/feed`, through the real contract parse, with the real
 * `attachments` array the server assembles — none of which an intercepted
 * response exercises.
 *
 * The object the row points at does not exist, and that is deliberate: nothing
 * in this file taps play, so nothing ever asks for those bytes, which is
 * exactly the property under test.
 */
function psql(sql: string): string {
  return execSync(
    `docker exec family-dev-postgres-1 psql -U family -d family -tAc "${sql.replaceAll('"', '\\"')}"`,
    { encoding: 'utf8' },
  ).trim();
}

interface Seeded {
  kind: 'image' | 'video' | 'audio';
  contentType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

/** ASCII only — these travel through a shell into `docker exec psql`. */
const SEED_MARKER = 'E2E media ';

/**
 * Writes one post carrying `items`, and returns its body text so the test can
 * find the card it just made rather than whichever card the shared development
 * database happens to put first.
 */
function seedPostWithMedia(items: readonly Seeded[]): { body: string; ids: string[] } {
  /*
    Sweep what earlier *runs* left behind, and nothing newer.

    The half-hour cutoff is the important half: this file's tests run in
    parallel, in two projects, and an unbounded `delete … where body like
    'E2E media %'` had each of them deleting the others' fixtures out from under
    a live page — which showed up as a card that rendered and then vanished. The
    cutoff is the same shape, and the same reasoning, as `sweepStaleFixtures` in
    `helpers.ts`: two orders of magnitude beyond the longest run measured here,
    and it can never touch a concurrent one.

    The marker is ASCII on purpose — it travels through a shell into
    `docker exec psql`, and a Cyrillic literal that survives one machine's
    console codepage can arrive mangled on another's.
  */
  psql(
    `delete from media_attachments where entity_id in (select id from posts` +
      ` where body like '${SEED_MARKER}%' and created_at < now() - interval '30 minutes');` +
      ` delete from posts where body like '${SEED_MARKER}%'` +
      ` and created_at < now() - interval '30 minutes'`,
  );

  // Unique per call, not per run: two projects seed at the same millisecond.
  const body = `${SEED_MARKER}${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
  // `-tA` suppresses headers but **not** the `INSERT 0 1` command tag, so the
  // id is the first line and not the whole output. `helpers.ts` solves the same
  // problem with a CTE; one line is the cheaper half of that trick.
  const postId = psql(
    `insert into posts (author_id, type, body)` +
      ` select id, 'announcement', '${body}' from users` +
      ` where status = 'active' order by created_at limit 1 returning id`,
  )
    .split(/\r?\n/)[0]
    ?.trim();
  expect(postId, 'seeded a post').toMatch(/^[0-9a-f-]{36}$/);

  const ids = items.map((item, index) => {
    const id = psql(
      `insert into media_attachments` +
        ` (uploader_id, kind, content_type, object_key, byte_size, width, height,` +
        `  duration_ms, entity_type, entity_id, sort_order, attached_at)` +
        ` select id, '${item.kind}', '${item.contentType}',` +
        ` 'e2e/${String(Date.now())}-${String(index)}', 1024,` +
        ` ${item.width === null ? 'null' : String(item.width)},` +
        ` ${item.height === null ? 'null' : String(item.height)},` +
        ` ${item.durationMs === null ? 'null' : String(item.durationMs)},` +
        ` 'post', '${postId}', ${String(index)}, now()` +
        ` from users where status = 'active' order by created_at limit 1 returning id`,
    )
      .split(/\r?\n/)[0]
      ?.trim();
    expect(id, 'seeded an attachment').toMatch(/^[0-9a-f-]{36}$/);
    return id ?? '';
  });

  return { body, ids };
}

/** The `<article>` the seeded post rendered into. */
function seededCard(page: Page, body: string): Locator {
  return page.locator('article').filter({ hasText: body });
}

test('a video card reserves its box, shows the duration pill, and fetches nothing', async ({
  page,
}) => {
  const { body, ids } = seedPostWithMedia([
    { kind: 'video', contentType: 'video/mp4', width: 1920, height: 1080, durationMs: 42_000 },
  ]);

  // Counted, not blocked: the point is that **zero** requests are made for a
  // clip nobody has tapped. Scoped to this clip's own id, because the shared
  // development database is full of other people’s photographs and counting
  // all media traffic would be measuring them.
  let mediaRequests = 0;
  page.on('request', (request) => {
    if (ids.some((id) => request.url().includes(id))) mediaRequests += 1;
  });

  await openWall(page);
  const card = seededCard(page, body);
  const play = card.getByRole('button', { name: /^Видео —/ });
  await expect(play).toBeVisible({ timeout: 15_000 });

  // §D7.14.5 / §D7.14.7. Fifteen cards of video cost fifteen nothing — which
  // matters more here than the design assumed, because there is no poster
  // object and the whole file is what would otherwise come down.
  expect(mediaRequests).toBe(0);

  const box = await play.boundingBox();
  // 16:9, reserved from the server's own `width`/`height` and unclamped at the
  // wide end — a panorama is short and harms nothing.
  expect((box?.width ?? 1) / (box?.height ?? 1)).toBeGreaterThan(1.6);

  // The pill is drawn, and it is hidden from the accessibility tree because the
  // same number is already spelled out inside the button's name. «0:42» read
  // aloud is "ноль двоеточие сорок два", which is not a duration.
  await expect(card.getByText('0:42', { exact: true })).toBeVisible();
  await expect(play).toHaveAccessibleName(/42 секунды/);
});

test('audio is a 56px row, not a box', async ({ page }) => {
  const { body } = seedPostWithMedia([
    { kind: 'audio', contentType: 'audio/mp4', width: null, height: null, durationMs: 72_000 },
  ]);

  await openWall(page);
  const card = seededCard(page, body);
  const row = card.getByRole('button', { name: /^Голосовая запись —/ });
  await expect(row).toBeVisible({ timeout: 15_000 });

  // Distinguishable from a video **because it is a different shape** (§B4:
  // colour is never the only signal, and neither is a glyph). So: 56px, and no
  // reserved aspect box anywhere on the card.
  const box = await row.locator('xpath=..').boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(54);
  expect(box?.height ?? 0).toBeLessThanOrEqual(58);
  await expect(card.locator('[style*="aspect-ratio"]')).toHaveCount(0);
});

/* ========================================================================== */
/* touch targets                                                              */
/* ========================================================================== */

test('every media control clears the 44px floor at 320px', async ({ page }) => {
  const { body } = seedPostWithMedia([
    { kind: 'video', contentType: 'video/mp4', width: 1920, height: 1080, durationMs: 42_000 },
  ]);
  await page.setViewportSize({ width: 320, height: 720 });
  await openWall(page);

  const card = seededCard(page, body);
  await expect(card.getByRole('button', { name: /^Видео —/ })).toBeVisible({ timeout: 15_000 });

  /*
    The heart, the picker and the play control. 320px is where a row is most
    likely to have been squeezed, and it is where this caught a real one: the
    empty ❤️ chip measured **43.97px** wide, because it is one emoji plus
    `px-2.5` and an emoji is not reliably 24px. `min-h-11` alone was not the
    floor it looked like.
  */
  for (const name of ['Нравится', 'Добавить реакцию', /^Видео —/] as const) {
    const control = card.getByRole('button', { name }).first();
    const box = await control.boundingBox();
    expect(box, `${String(name)} is on the page`).not.toBeNull();
    expect(box?.height ?? 0, `${String(name)} height`).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0, `${String(name)} width`).toBeGreaterThanOrEqual(44);
  }

  // …and the feed still does not scroll sideways with media on it.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/* ========================================================================== */
/* a failed upload                                                            */
/* ========================================================================== */

test('a refused upload says the server’s own sentence, and the note is still postable', async ({
  page,
}) => {
  await openWall(page);

  await page
    .getByRole('button', { name: /Написать/ })
    .first()
    .click();
  const post = page.getByRole('button', { name: 'Объявление' });
  if (await post.isVisible().catch(() => false)) await post.click();
  await page.getByLabel('Текст').fill('Записка, к которой видео не пошло');

  /*
    A real refusal from the real server, not an intercepted one — `page.route`
    is unreliable on WebKit here (see `seedPostWithMedia`), and a faked 415
    would not prove that `error.details.file` survives the XHR, the
    `toApiError` parse and the tile.

    A `.mp4` of noise is the only file that reaches the sniffer: an unreadable
    *image* is refused by `encode.ts` on the client before it moves, because a
    photo the browser cannot decode is a photo nobody can display either.
  */
  mkdirSync(FIXTURES, { recursive: true });
  const notAVideo = path.join(FIXTURES, 'noise.mp4');
  writeFileSync(notAVideo, Buffer.alloc(4096, 0x5a));
  await attachInput(page).setInputFiles(notAVideo);

  // The server's own words, verbatim. The composer never invents a second
  // wording for a refusal the server already knows how to explain (§D7.14.6).
  await expect(page.getByText(/Не удалось распознать файл/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Принимаем: JPEG/)).toBeVisible();

  // A **failed** tile does not disable «Повесить» — a member may post the note
  // without the file that would not go, and that is usually what they want at
  // that point (§D7.14.7).
  await expect(page.getByRole('button', { name: 'Повесить' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Ещё раз' })).toBeVisible();
});

/* ========================================================================== */
/* the playback ticket                                                        */
/* ========================================================================== */

/**
 * `<video src>` is `/api/media/<id>/stream?t=…`, minted on the tap.
 *
 * What this can prove here and what it cannot, stated rather than implied: the
 * seeded row points at an object that does not exist, so no browser is going to
 * decode anything. What *is* observable — and is the whole of the change — is
 * **which URL the element is given, and when**. A clip nobody has tapped costs
 * no mint at all; the tap costs exactly one; and the URL that lands in `src`
 * carries a capability rather than nothing, which is what puts the range
 * requests back in the browser's own media stack.
 *
 * Seeking through a real file was verified by hand against a 15 MB clip and is
 * recorded in the report: a drag to 150 s of a 170 s clip issued
 * `Range: bytes=13434880-` and was answered `206 bytes 13434880-15308316/…`.
 * Committing that would mean committing a 15 MB fixture or an ffmpeg
 * dependency, and CI has neither.
 */
/**
 * Every `src` a `<video>` on this page is ever given, in order.
 *
 * Read out of the DOM rather than off the network, and both halves of that are
 * deliberate. **Off the network** would be the more direct assertion, and it is
 * the one that does not survive WebKit: `page.on('request')` reports this app's
 * ticket POST there but never the media element's own load, so a
 * network-shaped test passes on Chromium and asserts nothing at all on
 * mobile-safari — the same failure mode `seedPostWithMedia` was written to
 * avoid. **A `MutationObserver` rather than reading the attribute afterwards**
 * because the seeded row points at an object that was never written: the
 * request fails, the card re-mints and gives up inside a few hundred
 * milliseconds, and by the time a poll could look, `src` is gone and so is the
 * element. A record of what it *was* given cannot be raced.
 */
declare global {
  interface Window {
    __mediaSrcs?: string[];
  }
}

async function recordVideoSources(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__mediaSrcs = [];
    const note = (node: Node): void => {
      if (!(node instanceof HTMLVideoElement) && !(node instanceof HTMLAudioElement)) return;
      const src = node.getAttribute('src');
      if (src) window.__mediaSrcs?.push(src);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') note(record.target);
        for (const added of record.addedNodes) note(added);
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  });
}

const videoSources = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__mediaSrcs ?? []);

/**
 * `<video src>` is `/api/media/<id>/stream?t=…`, minted on the tap.
 *
 * What this can prove here and what it cannot, stated rather than implied: the
 * seeded row points at an object that does not exist, so no browser is going to
 * decode anything. What *is* observable — and is the whole of the change — is
 * **which URL the element is given, and when**. A clip nobody has tapped costs
 * no mint at all; the tap costs exactly one; and the URL that lands in `src`
 * carries a capability rather than nothing, which is what puts the range
 * requests back into the browser's own media stack.
 *
 * Seeking through a real file was verified by hand against a 15 MB clip and is
 * recorded in the report: a drag to 150 s of a 170 s clip issued
 * `Range: bytes=13434880-` and was answered `206 bytes 13434880-15308316/…`,
 * on both engines. Committing that would mean committing a 15 MB fixture or an
 * ffmpeg dependency, and CI has neither.
 */
test('a clip is minted a ticket on the tap, and not one moment before', async ({ page }) => {
  const problems = watch(page);
  const { body, ids } = seedPostWithMedia([
    { kind: 'video', contentType: 'video/mp4', width: 1920, height: 1080, durationMs: 42_000 },
  ]);
  const id = ids[0] ?? '';

  const mints: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/media/${id}/ticket`)) mints.push(request.method());
  });

  await openWall(page);
  const card = seededCard(page, body);
  const play = card.getByRole('button', { name: /^Видео —/ });
  await expect(play).toBeVisible({ timeout: 15_000 });
  await recordVideoSources(page);

  // A feed of four clips is not four round trips, because it is not any round
  // trips: nothing is minted for a clip nobody has asked to watch, and there is
  // no element on the card to want any.
  expect(mints).toEqual([]);
  await expect(card.locator('video')).toHaveCount(0);

  await play.click();

  await expect.poll(() => videoSources(page), { timeout: 15_000 }).not.toEqual([]);
  const sources = await videoSources(page);

  // The whole change, in one assertion: the element was pointed at the stream
  // route carrying a capability, so the browser's own media stack issues the
  // range requests — with no service worker and no object URL in the way.
  expect(sources[0]).toMatch(new RegExp(`^/api/media/${id}/stream\\?t=m1\\.`));

  /*
    And the app itself never says the token out loud.

    `core/logger.ts` cuts the query string off every request line because the
    ICS feed token was once written out in full, and a `console.log` of the src
    — or an error message that interpolated it — would walk straight around
    that. `problems.console` is everything this page said, warnings included.

    Worth knowing and deliberately **not** asserted here: `watch()` records
    failing requests by their full URL, ticket and all, and `assertClean` prints
    those into the report on failure. That is the harness rather than the app;
    see the note in the report.
  */
  for (const line of problems.console) {
    expect(line).not.toContain('t=m1.');
  }
});

test('a clip whose bytes will not come re-mints once, and then stops asking', async ({ page }) => {
  const { body, ids } = seedPostWithMedia([
    { kind: 'video', contentType: 'video/mp4', width: 1920, height: 1080, durationMs: 42_000 },
  ]);
  const id = ids[0] ?? '';

  let mints = 0;
  page.on('request', (request) => {
    if (request.url().includes(`/media/${id}/ticket`)) mints += 1;
  });

  await openWall(page);
  const card = seededCard(page, body);
  await card.getByRole('button', { name: /^Видео —/ }).click();
  await expect(card.locator('video')).toHaveAttribute('src', /\/stream\?t=/, { timeout: 15_000 });

  /*
    The object behind this row was never written, so every request for its bytes
    fails. That is the shape of a file the browser cannot use, and an unbounded
    "on error, mint again" would be an infinite request loop against the API —
    a `<video>` raises `error` on **every** source it is handed. One re-mint is
    the bound: it is enough to fix the one thing a re-mint can fix (a ticket
    that aged out while the clip sat paused), and after it the mint has already
    proved that access is fine, so a second failure is the bytes.
  */
  await expect(card.getByText('Вложение не открылось')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2_000);
  expect(mints).toBeLessThanOrEqual(2);
});

/* ========================================================================== */
/* the heart on a reply                                                       */
/* ========================================================================== */

/** One comment on the seeded post, straight into the database. */
function seedComment(postId: string, body: string): string {
  const id = psql(
    `insert into comments (entity_type, entity_id, author_id, body)` +
      ` select 'post', '${postId}', id, '${body}' from users` +
      ` where status = 'active' order by created_at limit 1 returning id`,
  )
    .split(/\r?\n/)[0]
    ?.trim();
  expect(id, 'seeded a comment').toMatch(/^[0-9a-f-]{36}$/);
  return id ?? '';
}

test('a reply takes a heart, at the 44px floor and with no digit on it', async ({ page }) => {
  const { body } = seedPostWithMedia([]);
  const postId =
    psql(`select id from posts where body = '${body}'`).split(/\r?\n/)[0]?.trim() ?? '';
  seedComment(postId, 'E2E reply');

  await page.setViewportSize({ width: 320, height: 720 });
  await openWall(page);

  const card = seededCard(page, body);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole('button', { name: /Обсуждение|Обсудить/ }).click();
  await expect(card.getByText('E2E reply')).toBeVisible({ timeout: 15_000 });

  /*
    Two hearts on screen now — the card's own and the reply's — and the reply's
    is the second. `POST /api/comments/:id/reactions` is mounted, so it is a
    real control rather than a drawing.
  */
  const hearts = card.getByRole('button', { name: /Нравится|^❤️/ });
  await expect(hearts).toHaveCount(2);
  const heart = hearts.last();
  await expect(heart).toHaveAttribute('aria-pressed', 'false');

  // §F1 at the width where a row is most likely to have been squeezed. This is
  // where the empty chip once measured 43.97px — one emoji plus `px-2.5`, and
  // an emoji is not reliably 24px.
  const box = await heart.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);

  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

  // Faces, never digits — on the chip, in its `title`, and in the name a screen
  // reader reads out (§D7.7b). The last of those is how this crept back before.
  expect(await heart.getAttribute('aria-label')).not.toMatch(/\d/);
  expect(await heart.getAttribute('title')).toBeNull();
  expect(await heart.textContent()).not.toMatch(/\d/);

  /*
    And **no thread on a thread.** The backend widened reactions to `comment`
    and pointedly did not widen comments — `GET /api/comments/:id/comments`
    answers 404 by construction — so there must be no affordance suggesting
    otherwise. Exactly one expanded toggle: the post's own, which opened this
    list.
  */
  await expect(page.getByRole('button', { expanded: true })).toHaveCount(1);
  // §D7.8a: no `☺+` on a comment. The card above it still has one.
  await expect(card.getByRole('button', { name: 'Добавить реакцию' })).toHaveCount(1);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/* ========================================================================== */
/* what a `guest` sees, which is the path nobody can see by accident          */
/* ========================================================================== */

/**
 * A second account, because a `guest` is the one reader this suite cannot
 * borrow.
 *
 * `media:read` is granted from `child` up and withheld from `guest`, and the
 * fixture's session is an `owner` — so the redaction path is invisible to every
 * other test in this file. Demoting the shared account instead would reach into
 * whatever else is running against this stack: the run's owner is one account
 * shared by every worker, and two projects run in parallel.
 *
 * So: one extra account, per run, swept by age exactly as `helpers.ts` sweeps
 * its own. ASCII throughout — these predicates travel through a shell into
 * `docker exec psql`, and a Cyrillic literal that survives one machine's
 * console codepage can arrive mangled on another's.
 */
const GUEST_EMAIL = `e2e-guest-${RUN_ID}@example.test`;
const GUEST_PASSWORD = 'E2ePassw0rd!2345';

test.describe('a reader without media:read', () => {
  test.use({ storageState: ANONYMOUS });

  test('is told there are photographs, how many, and nothing else at all', async ({
    page,
    request,
  }) => {
    /*
      Two attachments, so the line has to be the plural one — which is the whole
      reason `hiddenAttachments` is a count and not a boolean.

      `video`, not `image`, and the reason is other people's tests: these rows
      point at objects that were never written, and an `image` row is fetched by
      **every** card that draws it. The owner sessions running the rest of this
      file would then collect a 404 apiece and `assertClean` would fail in a
      test that has nothing to do with this one. A clip fetches nothing until it
      is tapped. The reader under test sees neither either way — the placeholder
      says «фото» whatever the kind, because the kind is one more thing that
      does not cross the wire to them.
    */
    const { body, ids } = seedPostWithMedia([
      { kind: 'video', contentType: 'video/mp4', width: 1920, height: 1080, durationMs: 12_000 },
      { kind: 'video', contentType: 'video/mp4', width: 1920, height: 1080, durationMs: 8_000 },
    ]);

    psql(
      `delete from users where email like 'e2e-guest-%@example.test'` +
        ` and created_at < now() - interval '6 hours'`,
    );
    if (psql(`select 1 from users where email = '${GUEST_EMAIL}'`) !== '1') {
      const res = await request.post(`${API}/api/auth/register`, {
        data: { email: GUEST_EMAIL, password: GUEST_PASSWORD, displayName: 'Гость' },
      });
      expect(
        res.ok() || res.status() === 409,
        `guest registration failed: ${res.status()} ${await res.text()}`,
      ).toBeTruthy();
    }
    psql(`update users set status='active', role='guest' where email='${GUEST_EMAIL}'`);

    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/login');
    await page.getByLabel('Почта', { exact: true }).fill(GUEST_EMAIL);
    await page.getByLabel('Пароль', { exact: true }).fill(GUEST_PASSWORD);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page).toHaveURL(/\/($|\?)/, { timeout: 20_000 });

    const asked: string[] = [];
    page.on('request', (req) => {
      if (ids.some((id) => req.url().includes(id))) asked.push(req.url());
    });

    await openWall(page);
    const card = seededCard(page, body);
    await expect(card).toBeVisible({ timeout: 15_000 });

    // §D7.14.10 — one quiet line, and it counts. Not a lock-shaped hole, not a
    // blur, and above all not a blurred copy of the actual photograph.
    await expect(card.getByText('2 фото — только для семьи')).toBeVisible();

    /*
      And the reader is holding nothing they could take to the delivery route.
      No id crosses the wire for them, so no element on this page can ask for
      one — which is the half of D15 §4 that is drawn. The route answers them
      404 regardless; this is the half that means they never find out.
    */
    expect(asked).toEqual([]);
    await expect(card.locator('img, video, audio')).toHaveCount(0);

    // A quiet line is still a line: it clears the 44px floor, and nothing about
    // it moves, because nothing is ever going to arrive in it.
    const line = card.getByText('2 фото — только для семьи');
    const first = await line.boundingBox();
    expect(first?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.waitForTimeout(1_500);
    const second = await line.boundingBox();
    expect(Math.abs((second?.y ?? 0) - (first?.y ?? 0))).toBeLessThanOrEqual(1);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
