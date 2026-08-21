import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestSql, hasTestDb } from '../../test/db.js';
import {
  closeHarness,
  createMember,
  createOwner,
  errorCode,
  expectStatus,
  request,
  resetDatabase,
  startHarness,
  type Harness,
  type TestUser,
} from '../../test/harness.js';
import {
  HTML_DOCUMENT,
  PNG_1PX,
  buildHeic,
  buildMp3,
  buildMp4,
  buildPng,
} from '../../test/media-fixtures.js';
import { runMediaOrphanSweep } from './media.jobs.js';
import { sweepOrphanedMedia } from './media.service.js';
import { getStorage } from './s3.adapter.js';

/**
 * The media round trip against a **real** object store.
 *
 *     docker compose -f infra/docker-compose.dev.yml up -d rustfs
 *     TEST_DATABASE_URL=postgres://family:family@127.0.0.1:5432/family_test \
 *     TEST_S3_ENDPOINT=http://127.0.0.1:9000 npx vitest run
 *
 * The avatar suite's argument applies here and then goes further. A mocked S3
 * client would pass every assertion below while `Range` support was entirely
 * absent — and `Range` is not a nicety for video: Safari opens a `<video>` with
 * `Range: bytes=0-1` and gives up if it gets the whole file back with a `200`.
 * The things only a real store can answer are the ones that would ship broken:
 * whether a ranged `GET` really returns a `206` with a correct `Content-Range`,
 * whether the `ETag` we hand the browser is the store's, and whether a deleted
 * attachment's bytes are genuinely gone rather than merely unreferenced.
 */

const hasStorage = Boolean(process.env.TEST_S3_ENDPOINT);

const BOUNDARY = '----familymediaboundary7c41';

/**
 * A multipart body, built by hand.
 *
 * `app.inject()` has no FormData support, and building the bytes here is not a
 * shortcut — it is the only way to send a part whose declared `Content-Type`
 * disagrees with its contents, which is the single most important case in this
 * file.
 */
function multipartBody(
  parts: { name: string; filename?: string; contentType?: string; body: Buffer }[],
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n` +
          (part.contentType ? `Content-Type: ${part.contentType}\r\n` : '') +
          '\r\n',
      ),
      part.body,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

interface UploadedMedia {
  id: string;
  kind: 'image' | 'video' | 'audio';
  contentType: string;
  url: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

describe.skipIf(!hasTestDb || !hasStorage)('media (integration, real object storage)', () => {
  let h: Harness;
  let owner: TestUser;
  let adult: TestUser;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await closeHarness();
  });

  beforeEach(async () => {
    await resetDatabase();
    owner = await createOwner(h.app);
    adult = await createMember(h.app, owner, 'adult', { displayName: 'Взрослый' });
  });

  async function upload(
    user: TestUser,
    body: Buffer,
    options: { filename?: string; contentType?: string } = {},
  ) {
    return request(h.app, {
      method: 'POST',
      url: '/api/media',
      token: user.accessToken,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody([
        {
          name: 'file',
          filename: options.filename ?? 'photo.png',
          contentType: options.contentType ?? 'image/png',
          body,
        },
      ]),
    });
  }

  async function uploadOk(user: TestUser, body: Buffer, options = {}): Promise<UploadedMedia> {
    const response = await upload(user, body, options);
    expectStatus(response, 201);
    return response.json<UploadedMedia>();
  }

  async function createPost(
    user: TestUser,
    body: { body: string; attachmentIds?: string[]; title?: string },
  ) {
    return request(h.app, {
      method: 'POST',
      url: '/api/wall/posts',
      token: user.accessToken,
      payload: body,
    });
  }

  async function objectKeyOf(mediaId: string): Promise<string | null> {
    const sql = await getTestSql();
    const rows = await sql<{ object_key: string }[]>`
      select object_key from media_attachments where id = ${mediaId}
    `;
    return rows[0]?.object_key ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* the happy path                                                      */
  /* ------------------------------------------------------------------ */

  it('uploads a photo, mints an id, and streams the same bytes back', async () => {
    const png = buildPng(800, 600);
    const media = await uploadOk(owner, png);

    expect(media.url).toBe(`/api/media/${media.id}`);
    expect(media.kind).toBe('image');
    expect(media.contentType).toBe('image/png');
    // The dimensions the card boxes itself with, read from the file, not sent
    // by the client (§D7.6 — nothing reflows on load).
    expect(media.width).toBe(800);
    expect(media.height).toBe(600);
    expect(media.durationMs).toBeNull();
    expect(media.byteSize).toBe(png.length);

    const fetched = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: owner.accessToken,
    });
    expectStatus(fetched, 200);
    expect(Buffer.compare(fetched.rawPayload, png)).toBe(0);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(fetched.headers['x-content-type-options']).toBe('nosniff');
    expect(fetched.headers['content-security-policy']).toContain("default-src 'none'");
    expect(fetched.headers['cache-control']).toContain('private');
    expect(fetched.headers['cache-control']).toContain('immutable');
    expect(fetched.headers['accept-ranges']).toBe('bytes');
    expect(fetched.headers.etag).toBeTruthy();
  });

  it('answers a conditional request with a 304 and no body', async () => {
    const media = await uploadOk(owner, PNG_1PX);
    const first = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: owner.accessToken,
    });
    expectStatus(first, 200);
    const etag = first.headers.etag as string;

    const second = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: owner.accessToken,
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.rawPayload.length).toBe(0);
    expect(second.headers.etag).toBe(etag);
  });

  it('reads a video container: kind, duration, and the rotated frame size', async () => {
    const mp4 = buildMp4({
      width: 1920,
      height: 1080,
      durationMs: 4000,
      rotated: true,
      padding: 2048,
    });
    const media = await uploadOk(owner, mp4, { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(media.kind).toBe('video');
    expect(media.contentType).toBe('video/mp4');
    expect(media.durationMs).toBe(4000);
    // The display matrix was applied — a portrait clip is portrait.
    expect(media.width).toBe(1080);
    expect(media.height).toBe(1920);
  });

  it('reads an audio file, and gives it no dimensions', async () => {
    const mp3 = buildMp3(400);
    const media = await uploadOk(owner, mp3, { filename: 'song.mp3', contentType: 'audio/mpeg' });
    expect(media.kind).toBe('audio');
    expect(media.contentType).toBe('audio/mpeg');
    expect(media.width).toBeNull();
    expect(media.durationMs).toBeGreaterThan(9000);
  });

  /* ------------------------------------------------------------------ */
  /* Range — the thing video needs and photos never did                  */
  /* ------------------------------------------------------------------ */

  it('answers Range with a 206, the right bytes and a Content-Range', async () => {
    const mp4 = buildMp4({ durationMs: 5000, padding: 64 * 1024 });
    const media = await uploadOk(owner, mp4, { filename: 'clip.mp4', contentType: 'video/mp4' });

    // Safari's opening move on a `<video>`: two bytes, to find out whether the
    // endpoint honours ranges at all. Answer it with a 200 and it never asks
    // again — the video simply does not play.
    const probe = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: owner.accessToken,
      headers: { range: 'bytes=0-1' },
    });
    expect(probe.statusCode).toBe(206);
    expect(probe.headers['content-range']).toBe(`bytes 0-1/${String(mp4.length)}`);
    expect(probe.headers['accept-ranges']).toBe('bytes');
    expect(probe.rawPayload.length).toBe(2);
    expect(Buffer.compare(probe.rawPayload, mp4.subarray(0, 2))).toBe(0);

    // A seek into the middle: one request for the part that was dragged to,
    // not a re-download of the whole clip.
    const middle = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: owner.accessToken,
      headers: { range: 'bytes=1000-1999' },
    });
    expect(middle.statusCode).toBe(206);
    expect(middle.rawPayload.length).toBe(1000);
    expect(Buffer.compare(middle.rawPayload, mp4.subarray(1000, 2000))).toBe(0);

    // An open-ended range — "everything from here on".
    const tail = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: owner.accessToken,
      headers: { range: `bytes=${String(mp4.length - 10)}-` },
    });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.length).toBe(10);
  });

  it('answers an impossible range with 416 rather than a wrong 200', async () => {
    const media = await uploadOk(owner, PNG_1PX);
    const past = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: owner.accessToken,
      headers: { range: 'bytes=999999-1000000' },
    });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${String(media.byteSize)}`);
  });

  /* ------------------------------------------------------------------ */
  /* the security gate                                                   */
  /* ------------------------------------------------------------------ */

  it('rejects an HTML file that claims to be a PNG, and stores nothing', async () => {
    const posted = await upload(owner, HTML_DOCUMENT, {
      filename: 'photo.png',
      contentType: 'image/png',
    });
    expect(posted.statusCode).toBe(415);
    expect(errorCode(posted)).toBe('UNSUPPORTED_MEDIA_TYPE');

    const sql = await getTestSql();
    const rows = await sql<{ count: string }[]>`select count(*)::text from media_attachments`;
    expect(rows[0]?.count).toBe('0');
  });

  it('rejects a HEIC with advice, not with a shrug', async () => {
    const posted = await upload(owner, buildHeic(), {
      filename: 'IMG_0001.HEIC',
      contentType: 'image/heic',
    });
    expect(posted.statusCode).toBe(415);
    const details = posted.json<{ error: { details?: Record<string, string[]> } }>().error.details;
    // The member is told what to change on their phone — «unsupported» alone
    // teaches nobody anything.
    expect(details?.file?.[0]).toContain('HEIC');
    expect(details?.file?.[0]).toContain('Наиболее совместимые');
  });

  it('rejects a photo over the size cap with the number in it', async () => {
    // Valid PNG magic and a valid IHDR, then ten megabytes of nothing: the
    // sniffer is happy and the limit is what refuses it.
    const fat = Buffer.concat([buildPng(100, 100), Buffer.alloc(10 * 1024 * 1024, 0x41)]);
    const posted = await upload(owner, fat);
    expect(posted.statusCode).toBe(413);
    expect(errorCode(posted)).toBe('PAYLOAD_TOO_LARGE');
    const details = posted.json<{ error: { details?: Record<string, string[]> } }>().error.details;
    expect(details?.file?.[0]).toContain('10 МБ');
  });

  it('refuses an unauthenticated upload and an unauthenticated read', async () => {
    const media = await uploadOk(owner, PNG_1PX);

    const anonymousRead = await request(h.app, { method: 'GET', url: media.url });
    expect(anonymousRead.statusCode).toBe(401);

    const anonymousUpload = await request(h.app, {
      method: 'POST',
      url: '/api/media',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody([
        { name: 'file', filename: 'a.png', contentType: 'image/png', body: PNG_1PX },
      ]),
    });
    expect(anonymousUpload.statusCode).toBe(401);
  });

  /* ------------------------------------------------------------------ */
  /* drafts                                                              */
  /* ------------------------------------------------------------------ */

  it('keeps an unposted draft private to whoever uploaded it', async () => {
    const media = await uploadOk(owner, PNG_1PX);

    const mine = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: owner.accessToken,
    });
    expectStatus(mine, 200);

    // 404, not 403: an id nobody but its uploader has ever seen must not be
    // confirmed to exist (D4).
    const theirs = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: adult.accessToken,
    });
    expect(theirs.statusCode).toBe(404);
  });

  it('discards a draft and reclaims its object', async () => {
    const media = await uploadOk(owner, PNG_1PX);
    const key = await objectKeyOf(media.id);
    expect(key).toBeTruthy();
    expect(await getStorage()?.head(key as string)).not.toBeNull();

    const removed = await request(h.app, {
      method: 'DELETE',
      url: `/api/media/${media.id}`,
      token: owner.accessToken,
    });
    expectStatus(removed, 200);

    // Genuinely gone from the bucket, not merely unreferenced. This assertion
    // is the reason this suite talks to RustFS.
    expect(await getStorage()?.head(key as string)).toBeNull();
    expect(await objectKeyOf(media.id)).toBeNull();
  });

  it('will not let one member discard another member’s draft', async () => {
    const media = await uploadOk(owner, PNG_1PX);
    const removed = await request(h.app, {
      method: 'DELETE',
      url: `/api/media/${media.id}`,
      token: adult.accessToken,
    });
    expect(removed.statusCode).toBe(404);
  });

  /* ------------------------------------------------------------------ */
  /* attaching to a post                                                 */
  /* ------------------------------------------------------------------ */

  it('hangs photos on a post, in the order they were given', async () => {
    const first = await uploadOk(owner, buildPng(10, 10));
    const second = await uploadOk(owner, buildPng(20, 20));

    const posted = await createPost(owner, {
      body: 'Вчера на даче',
      attachmentIds: [second.id, first.id],
    });
    expectStatus(posted, 201);
    const post = posted.json<{ id: string; attachments: UploadedMedia[] }>();
    expect(post.attachments.map((item) => item.id)).toEqual([second.id, first.id]);

    // And the same order comes back on a fresh read, so two clients cannot
    // disagree about which photo is first.
    const reread = await request(h.app, {
      method: 'GET',
      url: `/api/wall/posts/${post.id}`,
      token: adult.accessToken,
    });
    expectStatus(reread, 200);
    expect(reread.json<{ attachments: UploadedMedia[] }>().attachments.map((i) => i.id)).toEqual([
      second.id,
      first.id,
    ]);

    // Another member can now read the bytes, because the post is readable.
    const seen = await request(h.app, {
      method: 'GET',
      url: first.url,
      token: adult.accessToken,
    });
    expectStatus(seen, 200);
  });

  it('accepts a photo with no caption, and refuses a note with neither', async () => {
    const media = await uploadOk(owner, PNG_1PX);
    const photoOnly = await createPost(owner, { body: '', attachmentIds: [media.id] });
    expectStatus(photoOnly, 201);

    const empty = await createPost(owner, { body: '   ' });
    expect(empty.statusCode).toBe(400);
  });

  it('refuses to hang somebody else’s upload on your post', async () => {
    const theirs = await uploadOk(adult, PNG_1PX);
    const posted = await createPost(owner, { body: 'Смотрите', attachmentIds: [theirs.id] });
    expect(posted.statusCode).toBe(403);

    // …and the post was not created either: the attach runs inside the post's
    // own transaction.
    const feed = await request(h.app, {
      method: 'GET',
      url: '/api/wall/posts',
      token: owner.accessToken,
    });
    expect(feed.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('refuses to hang one object on two posts', async () => {
    const media = await uploadOk(owner, PNG_1PX);
    expectStatus(await createPost(owner, { body: 'Раз', attachmentIds: [media.id] }), 201);

    const second = await createPost(owner, { body: 'Два', attachmentIds: [media.id] });
    expect(second.statusCode).toBe(409);
  });

  it('reclaims the object when a photo is edited off a post', async () => {
    const media = await uploadOk(owner, PNG_1PX);
    const key = (await objectKeyOf(media.id)) as string;
    const posted = await createPost(owner, { body: 'С фото', attachmentIds: [media.id] });
    const postId = posted.json<{ id: string }>().id;

    const patched = await request(h.app, {
      method: 'PATCH',
      url: `/api/wall/posts/${postId}`,
      token: owner.accessToken,
      payload: { attachmentIds: [] },
    });
    expectStatus(patched, 200);
    expect(patched.json<{ attachments: unknown[] }>().attachments).toEqual([]);

    // Removing a photo from your own note is deliberate, so the bytes go at
    // once — the same rule as replacing an avatar.
    expect(await getStorage()?.head(key)).toBeNull();
  });

  /* ------------------------------------------------------------------ */
  /* comments                                                            */
  /* ------------------------------------------------------------------ */

  it('hangs a photo on a comment, and hides it when the comment goes', async () => {
    const posted = await createPost(owner, { body: 'Кто поедет?' });
    const postId = posted.json<{ id: string }>().id;

    const media = await uploadOk(adult, buildPng(64, 48));
    const commented = await request(h.app, {
      method: 'POST',
      url: `/api/posts/${postId}/comments`,
      token: adult.accessToken,
      payload: { body: 'Вот такой', attachmentIds: [media.id] },
    });
    expectStatus(commented, 201);
    const comment = commented.json<{ id: string; attachments: UploadedMedia[] }>();
    expect(comment.attachments).toHaveLength(1);

    const listed = await request(h.app, {
      method: 'GET',
      url: `/api/posts/${postId}/comments`,
      token: owner.accessToken,
    });
    expectStatus(listed, 200);
    expect(
      listed.json<{ items: { attachments: UploadedMedia[] }[] }>().items[0]?.attachments,
    ).toHaveLength(1);

    const key = (await objectKeyOf(media.id)) as string;
    const deleted = await request(h.app, {
      method: 'DELETE',
      url: `/api/comments/${comment.id}`,
      token: adult.accessToken,
    });
    expectStatus(deleted, 200);

    // Hidden immediately…
    const gone = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: owner.accessToken,
    });
    expect(gone.statusCode).toBe(404);
    // …but the bytes stay, because a soft delete has to be answerable for
    // «верните, я не то удалил» (media.service.DETACHED_GRACE_DAYS).
    expect(await getStorage()?.head(key)).not.toBeNull();
  });

  /* ------------------------------------------------------------------ */
  /* deletion, the horizon, and the sweep                                */
  /* ------------------------------------------------------------------ */

  it('hides a deleted post’s media without destroying it', async () => {
    const media = await uploadOk(owner, PNG_1PX);
    const posted = await createPost(owner, { body: 'Удалю', attachmentIds: [media.id] });
    const postId = posted.json<{ id: string }>().id;
    const key = (await objectKeyOf(media.id)) as string;

    expectStatus(
      await request(h.app, {
        method: 'DELETE',
        url: `/api/wall/posts/${postId}`,
        token: owner.accessToken,
      }),
      200,
    );

    const gone = await request(h.app, { method: 'GET', url: media.url, token: owner.accessToken });
    expect(gone.statusCode).toBe(404);
    expect(await getStorage()?.head(key)).not.toBeNull();
  });

  it('leaves media completely alone when the board is cleared', async () => {
    // «Очистить доску» is a horizon, not a delete (§D7.11): the post, its
    // comments and its photos are all still there, and the undo puts the whole
    // board back. A sweep keyed off the horizon would turn a reversible product
    // decision into irreversible data loss.
    const media = await uploadOk(owner, PNG_1PX);
    const posted = await createPost(owner, { body: 'До очистки', attachmentIds: [media.id] });
    expectStatus(posted, 201);
    const key = (await objectKeyOf(media.id)) as string;

    expectStatus(
      await request(h.app, { method: 'POST', url: '/api/wall/clear', token: owner.accessToken }),
      200,
    );

    expect(await getStorage()?.head(key)).not.toBeNull();
    const still = await request(h.app, { method: 'GET', url: media.url, token: owner.accessToken });
    expectStatus(still, 200);

    // Not even after a sweep: the row is neither a draft nor detached.
    await sweepOrphanedMedia(h.db);
    expect(await getStorage()?.head(key)).not.toBeNull();
  });

  it('sweeps a draft nobody ever posted, and nothing else', async () => {
    const abandoned = await uploadOk(owner, PNG_1PX);
    const kept = await uploadOk(owner, buildPng(30, 30));
    expectStatus(await createPost(owner, { body: 'Живой', attachmentIds: [kept.id] }), 201);

    const abandonedKey = (await objectKeyOf(abandoned.id)) as string;
    const keptKey = (await objectKeyOf(kept.id)) as string;

    // A fresh draft is not swept — the composer may still be open.
    let result = await sweepOrphanedMedia(h.db);
    expect(result.drafts).toBe(0);
    expect(await getStorage()?.head(abandonedKey)).not.toBeNull();

    // Age it past the TTL and try again.
    const sql = await getTestSql();
    await sql`
      update media_attachments
         set created_at = now() - interval '2 days'
       where id = ${abandoned.id}
    `;

    result = await sweepOrphanedMedia(h.db);
    expect(result.drafts).toBe(1);
    expect(await getStorage()?.head(abandonedKey)).toBeNull();
    expect(await objectKeyOf(abandoned.id)).toBeNull();

    // The posted one is untouched, and still readable.
    expect(await getStorage()?.head(keptKey)).not.toBeNull();
    expectStatus(
      await request(h.app, { method: 'GET', url: kept.url, token: adult.accessToken }),
      200,
    );
  });

  it('sweeps a detached row only after its grace period', async () => {
    const media = await uploadOk(owner, PNG_1PX);
    const posted = await createPost(owner, { body: 'Пока', attachmentIds: [media.id] });
    const postId = posted.json<{ id: string }>().id;
    const key = (await objectKeyOf(media.id)) as string;

    expectStatus(
      await request(h.app, {
        method: 'DELETE',
        url: `/api/wall/posts/${postId}`,
        token: owner.accessToken,
      }),
      200,
    );

    expect((await sweepOrphanedMedia(h.db)).detached).toBe(0);
    expect(await getStorage()?.head(key)).not.toBeNull();

    const sql = await getTestSql();
    await sql`
      update media_attachments
         set deleted_at = now() - interval '60 days'
       where id = ${media.id}
    `;

    expect((await sweepOrphanedMedia(h.db)).detached).toBe(1);
    expect(await getStorage()?.head(key)).toBeNull();
  });

  /* ------------------------------------------------------------------ */
  /* the scheduled job (`maintenance.sweep-media`)                       */
  /* ------------------------------------------------------------------ */

  it('drains a backlog of orphans in one run, and reclaims nothing on the next', async () => {
    // More orphans than a single batch, to exercise what the schedule actually
    // meets on its first night: everything that piled up while the sweep had no
    // schedule at all.
    const abandoned = [
      await uploadOk(owner, PNG_1PX),
      await uploadOk(owner, buildPng(20, 20)),
      await uploadOk(adult, buildPng(21, 21)),
    ];
    const kept = await uploadOk(owner, buildPng(22, 22));
    expectStatus(await createPost(owner, { body: 'Живой', attachmentIds: [kept.id] }), 201);
    const keptKey = (await objectKeyOf(kept.id)) as string;

    const keys = await Promise.all(abandoned.map(async (m) => (await objectKeyOf(m.id)) as string));
    // Every draft, which is exactly the three above — `kept` is attached.
    const sql = await getTestSql();
    await sql`
      update media_attachments
         set created_at = now() - interval '3 days'
       where entity_id is null
    `;

    const first = await runMediaOrphanSweep(h.db, { batch: 2 });
    expect(first).toMatchObject({ drafts: 3, detached: 0, failed: 0 });
    // Two passes of two, because `batch` is a unit of work and not a nightly
    // ceiling — a backlog must not take one night per batch to drain.
    expect(first.passes).toBeGreaterThan(1);
    for (const key of keys) expect(await getStorage()?.head(key)).toBeNull();

    // Idempotent: the second run finds a window it already emptied.
    expect(await runMediaOrphanSweep(h.db, { batch: 2 })).toMatchObject({
      drafts: 0,
      detached: 0,
      failed: 0,
      passes: 0,
    });

    // And the posted photo is still there, still readable.
    expect(await getStorage()?.head(keptKey)).not.toBeNull();
    expectStatus(
      await request(h.app, { method: 'GET', url: kept.url, token: adult.accessToken }),
      200,
    );
  });

  it('keeps the row when the object store refuses the delete', async () => {
    /*
     * The inverse orphan, and the worse one: a row deleted for an object that
     * is still in the bucket is a byte leak nothing can ever find again, since
     * the key only exists in the row. So a store that is down must cost the
     * sweep nothing but a retry.
     */
    const media = await uploadOk(owner, PNG_1PX);
    const key = (await objectKeyOf(media.id)) as string;
    const sql = await getTestSql();
    await sql`
      update media_attachments
         set created_at = now() - interval '3 days'
       where id = ${media.id}
    `;

    const storage = getStorage();
    if (!storage) throw new Error('this suite requires TEST_S3_ENDPOINT');
    const remove = vi
      .spyOn(storage, 'remove')
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9000'));

    try {
      const result = await runMediaOrphanSweep(h.db);
      expect(result).toMatchObject({ drafts: 0, detached: 0, failed: 1 });
      // One pass, not twenty-five: a pass that reclaims nothing ends the loop,
      // so an outage does not turn into a retry storm against a dead store.
      expect(result.passes).toBe(0);
    } finally {
      remove.mockRestore();
    }

    // Row intact, bytes intact, and the draft is still its uploader's.
    expect(await objectKeyOf(media.id)).toBe(key);
    expect(await getStorage()?.head(key)).not.toBeNull();
    expectStatus(
      await request(h.app, { method: 'GET', url: media.url, token: owner.accessToken }),
      200,
    );

    // Next run — tomorrow's tick, or BullMQ's retry — finishes the job.
    expect(await runMediaOrphanSweep(h.db)).toMatchObject({ drafts: 1, failed: 0 });
    expect(await getStorage()?.head(key)).toBeNull();
  });

  it('reclaims nothing at all after a board clear, however often it runs', async () => {
    // The schedule must not become a back door to the thing §D7.11 forbids: a
    // cleared board is hidden, not deleted, and an undo has to bring back the
    // photographs too.
    const media = await uploadOk(owner, PNG_1PX);
    expectStatus(await createPost(owner, { body: 'До очистки', attachmentIds: [media.id] }), 201);
    const key = (await objectKeyOf(media.id)) as string;

    expectStatus(
      await request(h.app, { method: 'POST', url: '/api/wall/clear', token: owner.accessToken }),
      200,
    );

    // Well past both windows, in case the horizon ever leaked into either query.
    const sql = await getTestSql();
    await sql`update media_attachments set created_at = now() - interval '90 days'`;

    for (let run = 0; run < 2; run += 1) {
      expect(await runMediaOrphanSweep(h.db)).toMatchObject({ drafts: 0, detached: 0, failed: 0 });
    }
    expect(await getStorage()?.head(key)).not.toBeNull();
    expectStatus(
      await request(h.app, { method: 'GET', url: media.url, token: owner.accessToken }),
      200,
    );
  });
});

/* ========================================================================== */
/* `media:read` — a guest reads the wall and not the photographs (D15 §4)     */
/* ========================================================================== */

describe.skipIf(!hasTestDb || !hasStorage)('media:read, over real HTTP', () => {
  let h: Harness;
  let owner: TestUser;
  let child: TestUser;
  let guest: TestUser;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await closeHarness();
  });

  beforeEach(async () => {
    await resetDatabase();
    owner = await createOwner(h.app);
    child = await createMember(h.app, owner, 'child', { displayName: 'Ребёнок' });
    guest = await createMember(h.app, owner, 'guest', { displayName: 'Гость' });
  });

  async function upload(user: TestUser, body: Buffer): Promise<UploadedMedia> {
    const response = await request(h.app, {
      method: 'POST',
      url: '/api/media',
      token: user.accessToken,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody([
        { name: 'file', filename: 'photo.png', contentType: 'image/png', body },
      ]),
    });
    expectStatus(response, 201);
    return response.json<UploadedMedia>();
  }

  async function postWithPhoto(): Promise<{ postId: string; media: UploadedMedia }> {
    const media = await upload(owner, buildPng(64, 48));
    const posted = await request(h.app, {
      method: 'POST',
      url: '/api/wall/posts',
      token: owner.accessToken,
      payload: { body: 'Вчера на даче', attachmentIds: [media.id] },
    });
    expectStatus(posted, 201);
    return { postId: posted.json<{ id: string }>().id, media };
  }

  /**
   * The one that matters, and the reason it is asserted over real HTTP rather
   * than against a matrix entry: the guard, the row lookup and the entity
   * resolver all have to agree, and a matrix assertion would have passed
   * throughout the window in which a guest could read every photograph on the
   * wall.
   */
  it('serves a child the bytes and answers a guest 404', async () => {
    const { media } = await postWithPhoto();

    const forChild = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: child.accessToken,
    });
    expectStatus(forChild, 200);
    expect(forChild.rawPayload.length).toBe(media.byteSize);

    const forGuest = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: guest.accessToken,
    });
    // 404, never 403: a 403 would confirm the object exists to the one caller
    // forbidden from knowing (D4).
    expect(forGuest.statusCode).toBe(404);
    // A JSON refusal, not the PNG — asserted against the bytes rather than the
    // status alone, because "404 with the file attached" is a shape a careless
    // `reply.code()` can produce.
    expect(errorCode(forGuest)).toBe('NOT_FOUND');
    expect(forGuest.headers['content-type']).toContain('application/json');
  });

  it('refuses a guest a ranged read too, which is how a `<video>` asks', async () => {
    const { media } = await postWithPhoto();
    const ranged = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: guest.accessToken,
      headers: { range: 'bytes=0-1' },
    });
    expect(ranged.statusCode).toBe(404);
  });

  it('still shows a guest the note, and tells the card how many photos it may not open', async () => {
    const { postId } = await postWithPhoto();

    const feed = await request(h.app, {
      method: 'GET',
      url: '/api/wall/posts',
      token: guest.accessToken,
    });
    expectStatus(feed, 200);
    const [card] = feed.json<{
      items: { body: string; attachments: UploadedMedia[]; hiddenAttachments: number }[];
    }>().items;

    // The wall is still readable — a guest is not being hidden from the family,
    // only from the photographs.
    expect(card?.body).toBe('Вчера на даче');
    // Nothing that names the object crosses the wire: no id, no url, no type.
    expect(card?.attachments).toEqual([]);
    // …but the card knows to draw «Фото — только для семьи» (§D7.14.10).
    expect(card?.hiddenAttachments).toBe(1);

    // Sanity: the same feed, for somebody who may look.
    const forChild = await request(h.app, {
      method: 'GET',
      url: '/api/wall/posts',
      token: child.accessToken,
    });
    const mine = forChild.json<{
      items: { attachments: UploadedMedia[]; hiddenAttachments: number }[];
    }>().items[0];
    expect(mine?.attachments).toHaveLength(1);
    expect(mine?.hiddenAttachments).toBe(0);

    // And a single post read, which is a different code path to the feed.
    const single = await request(h.app, {
      method: 'GET',
      url: `/api/wall/posts/${postId}`,
      token: guest.accessToken,
    });
    expectStatus(single, 200);
    expect(single.json<{ attachments: unknown[]; hiddenAttachments: number }>()).toMatchObject({
      attachments: [],
      hiddenAttachments: 1,
    });
  });

  it('redacts a photo on a comment for a guest as well', async () => {
    const { postId } = await postWithPhoto();
    const media = await upload(child, buildPng(20, 20));
    const commented = await request(h.app, {
      method: 'POST',
      url: `/api/posts/${postId}/comments`,
      token: child.accessToken,
      payload: { body: 'И вот ещё', attachmentIds: [media.id] },
    });
    expectStatus(commented, 201);

    const listed = await request(h.app, {
      method: 'GET',
      url: `/api/posts/${postId}/comments`,
      token: guest.accessToken,
    });
    expectStatus(listed, 200);
    const [reply] = listed.json<{
      items: { body: string; attachments: unknown[]; hiddenAttachments: number }[];
    }>().items;
    expect(reply?.body).toBe('И вот ещё');
    expect(reply?.attachments).toEqual([]);
    expect(reply?.hiddenAttachments).toBe(1);

    const forGuest = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: guest.accessToken,
    });
    expect(forGuest.statusCode).toBe(404);
  });

  it('opens for one guest who was granted it, without moving the role', async () => {
    // The reversibility that makes the closed default safe to ship while the
    // owner is still deciding: the babysitter who genuinely should see the
    // holiday photos is one `permission_grants` entry, not a role change.
    const { media } = await postWithPhoto();

    const granted = await request(h.app, {
      method: 'PATCH',
      url: `/api/members/${guest.id}`,
      token: owner.accessToken,
      payload: { permissionGrants: ['media:read'] },
    });
    expectStatus(granted, 200);

    const forGuest = await request(h.app, {
      method: 'GET',
      url: media.url,
      token: guest.accessToken,
    });
    expectStatus(forGuest, 200);
  });
});

/* ========================================================================== */
/* Playback tickets — the credential a `<video>` can carry                    */
/* ========================================================================== */

describe.skipIf(!hasTestDb || !hasStorage)('playback tickets', () => {
  let h: Harness;
  let owner: TestUser;
  let child: TestUser;
  let guest: TestUser;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await closeHarness();
  });

  beforeEach(async () => {
    await resetDatabase();
    owner = await createOwner(h.app);
    child = await createMember(h.app, owner, 'child', { displayName: 'Ребёнок' });
    guest = await createMember(h.app, owner, 'guest', { displayName: 'Гость' });
  });

  async function postedVideo(): Promise<{ media: UploadedMedia; bytes: Buffer }> {
    const bytes = buildMp4({ durationMs: 5000, padding: 64 * 1024 });
    const uploaded = await request(h.app, {
      method: 'POST',
      url: '/api/media',
      token: owner.accessToken,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody([
        { name: 'file', filename: 'clip.mp4', contentType: 'video/mp4', body: bytes },
      ]),
    });
    expectStatus(uploaded, 201);
    const media = uploaded.json<UploadedMedia>();

    const posted = await request(h.app, {
      method: 'POST',
      url: '/api/wall/posts',
      token: owner.accessToken,
      payload: { body: 'Первый велосипед', attachmentIds: [media.id] },
    });
    expectStatus(posted, 201);
    return { media, bytes };
  }

  async function mint(user: TestUser, mediaId: string) {
    return request(h.app, {
      method: 'POST',
      url: `/api/media/${mediaId}/ticket`,
      token: user.accessToken,
    });
  }

  it('mints a URL a media element can use, and honours Range on it', async () => {
    const { media, bytes } = await postedVideo();

    const minted = await mint(child, media.id);
    expectStatus(minted, 200);
    const ticket = minted.json<{ url: string; expiresAt: string }>();
    expect(ticket.url.startsWith(`/api/media/${media.id}/stream?t=`)).toBe(true);
    expect(new Date(ticket.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // No Authorization header anywhere below — that is the entire point.
    const probe = await request(h.app, {
      method: 'GET',
      url: ticket.url,
      headers: { range: 'bytes=0-1' },
    });
    expect(probe.statusCode).toBe(206);
    expect(probe.headers['content-range']).toBe(`bytes 0-1/${String(bytes.length)}`);
    expect(probe.headers['accept-ranges']).toBe('bytes');
    // Same security headers as the bearer route — one sender, so they cannot
    // drift apart.
    expect(probe.headers['x-content-type-options']).toBe('nosniff');
    expect(probe.headers['content-security-policy']).toContain("default-src 'none'");

    const seek = await request(h.app, {
      method: 'GET',
      url: ticket.url,
      headers: { range: 'bytes=1000-1999' },
    });
    expect(seek.statusCode).toBe(206);
    expect(Buffer.compare(seek.rawPayload, bytes.subarray(1000, 2000))).toBe(0);

    const whole = await request(h.app, { method: 'GET', url: ticket.url });
    expectStatus(whole, 200);
    expect(Buffer.compare(whole.rawPayload, bytes)).toBe(0);
    expect(whole.headers['content-type']).toBe('video/mp4');
  });

  it('answers 404 to a forged, truncated or absent ticket', async () => {
    const { media } = await postedVideo();
    const good = (await mint(child, media.id)).json<{ url: string }>().url;
    const token = good.slice(good.indexOf('t=') + 2);

    for (const url of [
      `/api/media/${media.id}/stream?t=nonsense`,
      `/api/media/${media.id}/stream?t=${token.slice(0, -4)}AAAA`,
    ]) {
      const response = await request(h.app, { method: 'GET', url });
      expect(response.statusCode).toBe(404);
    }

    // Missing entirely is a validation failure, not a leak either way.
    const bare = await request(h.app, {
      method: 'GET',
      url: `/api/media/${media.id}/stream`,
    });
    expect(bare.statusCode).toBeGreaterThanOrEqual(400);
    expect(bare.statusCode).toBeLessThan(500);
  });

  it('will not open a different object with a valid ticket', async () => {
    const first = await postedVideo();
    const second = await postedVideo();
    const ticket = (await mint(child, first.media.id)).json<{ url: string }>().url;
    const token = ticket.slice(ticket.indexOf('t=') + 2);

    const crossed = await request(h.app, {
      method: 'GET',
      url: `/api/media/${second.media.id}/stream?t=${token}`,
    });
    expect(crossed.statusCode).toBe(404);
  });

  it('refuses a guest the ticket, so the credential cannot outflank the permission', async () => {
    const { media } = await postedVideo();
    const minted = await mint(guest, media.id);
    expect(minted.statusCode).toBe(404);
  });

  /**
   * The property that makes a URL-borne credential acceptable at all: it is a
   * credential, not a frozen authorisation. Everything is re-evaluated on the
   * next range request.
   */
  it('stops working the moment its member loses access', async () => {
    const { media } = await postedVideo();
    const ticket = (await mint(child, media.id)).json<{ url: string }>().url;
    expectStatus(await request(h.app, { method: 'GET', url: ticket }), 200);

    const denied = await request(h.app, {
      method: 'PATCH',
      url: `/api/members/${child.id}`,
      token: owner.accessToken,
      payload: { permissionDenies: ['media:read'] },
    });
    expectStatus(denied, 200);

    const after = await request(h.app, { method: 'GET', url: ticket });
    expect(after.statusCode).toBe(404);
  });

  it('stops working when the note it hangs on is deleted', async () => {
    const { media } = await postedVideo();
    const ticket = (await mint(child, media.id)).json<{ url: string }>().url;
    expectStatus(await request(h.app, { method: 'GET', url: ticket }), 200);

    const feed = await request(h.app, {
      method: 'GET',
      url: '/api/wall/posts',
      token: owner.accessToken,
    });
    const postId = feed.json<{ items: { id: string }[] }>().items[0]?.id;
    expectStatus(
      await request(h.app, {
        method: 'DELETE',
        url: `/api/wall/posts/${postId ?? ''}`,
        token: owner.accessToken,
      }),
      200,
    );

    const after = await request(h.app, { method: 'GET', url: ticket });
    expect(after.statusCode).toBe(404);
  });
});
