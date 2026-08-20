import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hasTestDb } from '../../test/db.js';
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
import { getStorage } from './s3.adapter.js';

/**
 * The avatar round trip against a **real** object store.
 *
 * Run it with the dev stack up:
 *
 *     docker compose -f infra/docker-compose.dev.yml up -d rustfs
 *     TEST_DATABASE_URL=postgres://family:family@127.0.0.1:5432/family_test \
 *     TEST_S3_ENDPOINT=http://127.0.0.1:9000 npx vitest run
 *
 * A mocked S3 client would have passed every assertion below while the adapter
 * was still pointed at virtual-hosted addressing, which no self-hosted S3
 * implementation answers. The things this file can catch and a unit test cannot
 * are exactly the ones that broke: path-style addressing, whether the bucket
 * gets created, whether `CreateBucket` on an existing bucket is an error on
 * this backend, and whether the ETag we hand the browser is the one the store
 * gave us.
 */

const hasStorage = Boolean(process.env.TEST_S3_ENDPOINT);

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** The smallest real 1×1 PNG, so the bytes that travel are a genuine image. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A minimal but structurally valid WebP (RIFF ... WEBP). */
const WEBP_TINY = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8L'),
  Buffer.from([0x0d, 0x00, 0x00, 0x00]),
  Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x88, 0x88, 0xfe, 0x07, 0x00, 0x00, 0x00]),
]);

const BOUNDARY = '----familytestboundary9f2c';

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

describe.skipIf(!hasTestDb || !hasStorage)('avatars (integration, real object storage)', () => {
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
      url: '/api/me/avatar',
      token: user.accessToken,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody([
        {
          name: 'file',
          filename: options.filename ?? 'avatar.png',
          contentType: options.contentType ?? 'image/png',
          body,
        },
      ]),
    });
  }

  /* ------------------------------------------------------------------ */
  /* the happy path                                                      */
  /* ------------------------------------------------------------------ */

  it('uploads, stores and streams a real image back', async () => {
    const posted = await upload(owner, PNG_1PX);
    expectStatus(posted, 200);

    const self = posted.json<{ avatarUrl: string | null; id: string }>();
    expect(self.avatarUrl).toMatch(
      new RegExp(`^/api/users/${self.id}/avatar\\?v=[0-9a-f]{32}\\.png$`),
    );

    // `GET /api/me` must agree — the client renders from there, not from the
    // upload response.
    const me = await request(h.app, { method: 'GET', url: '/api/me', token: owner.accessToken });
    expectStatus(me, 200);
    expect(me.json<{ user: { avatarUrl: string } }>().user.avatarUrl).toBe(self.avatarUrl);

    const fetched = await request(h.app, {
      method: 'GET',
      url: self.avatarUrl as string,
      token: owner.accessToken,
    });
    expectStatus(fetched, 200);

    // The bytes came back byte-for-byte out of the bucket, not out of a cache.
    expect(Buffer.compare(fetched.rawPayload, PNG_1PX)).toBe(0);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(fetched.headers['x-content-type-options']).toBe('nosniff');
    expect(fetched.headers['cache-control']).toContain('immutable');
    expect(fetched.headers['cache-control']).toContain('private');
    expect(fetched.headers.etag).toBeTruthy();
  });

  it('honours If-None-Match with a 304 and no body', async () => {
    const posted = await upload(owner, PNG_1PX);
    expectStatus(posted, 200);
    const url = posted.json<{ avatarUrl: string }>().avatarUrl;

    const first = await request(h.app, { method: 'GET', url, token: owner.accessToken });
    expectStatus(first, 200);
    const etag = first.headers.etag as string;

    const second = await request(h.app, {
      method: 'GET',
      url,
      token: owner.accessToken,
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.rawPayload.length).toBe(0);
    expect(second.headers.etag).toBe(etag);
  });

  it('accepts webp, which is what the browser actually uploads', async () => {
    const posted = await upload(adult, WEBP_TINY, {
      filename: 'crop.webp',
      contentType: 'image/webp',
    });
    expectStatus(posted, 200);
    expect(posted.json<{ avatarUrl: string }>().avatarUrl).toContain('.webp');
  });

  /* ------------------------------------------------------------------ */
  /* the security gate                                                   */
  /* ------------------------------------------------------------------ */

  it('rejects an HTML file that claims to be a PNG', async () => {
    // The whole reason the serving route exists on our origin: if this got
    // through, `GET /api/users/:id/avatar` would hand a browser a script from
    // the same origin as the session.
    const html = Buffer.from(
      '<!doctype html><html><body><script>fetch("/api/me")</script></body></html>',
    );
    const posted = await upload(owner, html, { filename: 'photo.png', contentType: 'image/png' });

    expect(posted.statusCode).toBe(415);
    expect(errorCode(posted)).toBe('UNSUPPORTED_MEDIA_TYPE');

    // And nothing was written: the profile still has no avatar.
    const me = await request(h.app, { method: 'GET', url: '/api/me', token: owner.accessToken });
    expect(me.json<{ user: { avatarUrl: string | null } }>().user.avatarUrl).toBeNull();
  });

  it('rejects an SVG, which is an image the browser will happily execute', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const posted = await upload(owner, svg, { filename: 'x.svg', contentType: 'image/svg+xml' });
    expect(posted.statusCode).toBe(415);
  });

  it('rejects a file over the size cap', async () => {
    const huge = Buffer.concat([PNG_1PX, Buffer.alloc(3 * 1024 * 1024, 0x41)]);
    const posted = await upload(owner, huge);
    expect(posted.statusCode).toBe(413);
    expect(errorCode(posted)).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects a request with no file part', async () => {
    const posted = await request(h.app, {
      method: 'POST',
      url: '/api/me/avatar',
      token: owner.accessToken,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody([{ name: 'note', body: Buffer.from('hello') }]),
    });
    expect(posted.statusCode).toBe(400);
  });

  it('refuses an unauthenticated upload', async () => {
    const posted = await request(h.app, {
      method: 'POST',
      url: '/api/me/avatar',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody([
        { name: 'file', filename: 'a.png', contentType: 'image/png', body: PNG_1PX },
      ]),
    });
    expect(posted.statusCode).toBe(401);
  });

  /* ------------------------------------------------------------------ */
  /* replacement and removal — the bucket must not grow forever          */
  /* ------------------------------------------------------------------ */

  it('deletes the previous object when an avatar is replaced', async () => {
    const first = await upload(owner, PNG_1PX);
    expectStatus(first, 200);
    const firstUrl = first.json<{ avatarUrl: string }>().avatarUrl;
    const firstKey = keyOf(firstUrl);

    const storage = getStorage();
    expect(storage).not.toBeNull();
    expect(await storage?.head(firstKey)).not.toBeNull();

    const second = await upload(owner, WEBP_TINY, {
      filename: 'new.webp',
      contentType: 'image/webp',
    });
    expectStatus(second, 200);
    const secondUrl = second.json<{ avatarUrl: string }>().avatarUrl;
    expect(secondUrl).not.toBe(firstUrl);

    // The new one is there…
    expect(await storage?.head(keyOf(secondUrl))).not.toBeNull();
    // …and the old one is genuinely gone from the bucket, not merely
    // unreferenced. This assertion is the reason this suite talks to RustFS.
    expect(await storage?.head(firstKey)).toBeNull();

    // The old URL now 404s even for its owner: the row points elsewhere.
    const stale = await request(h.app, {
      method: 'GET',
      url: firstUrl,
      token: owner.accessToken,
    });
    expect(stale.statusCode).toBe(200);
    // ...serving the *current* object, because `?v` is a cache buster and the
    // key is resolved from the row. Same URL path, new bytes.
    expect(Buffer.compare(stale.rawPayload, WEBP_TINY)).toBe(0);
  });

  it('removes the avatar and its object on DELETE, idempotently', async () => {
    const posted = await upload(owner, PNG_1PX);
    expectStatus(posted, 200);
    const key = keyOf(posted.json<{ avatarUrl: string }>().avatarUrl);

    const removed = await request(h.app, {
      method: 'DELETE',
      url: '/api/me/avatar',
      token: owner.accessToken,
    });
    expectStatus(removed, 200);
    expect(removed.json<{ avatarUrl: string | null }>().avatarUrl).toBeNull();
    expect(await getStorage()?.head(key)).toBeNull();

    // Again, on a member who now has no avatar at all.
    const again = await request(h.app, {
      method: 'DELETE',
      url: '/api/me/avatar',
      token: owner.accessToken,
    });
    expectStatus(again, 200);
  });

  /* ------------------------------------------------------------------ */
  /* delivery access                                                     */
  /* ------------------------------------------------------------------ */

  it('lets one member see another member’s avatar', async () => {
    const posted = await upload(adult, PNG_1PX);
    expectStatus(posted, 200);
    const url = posted.json<{ avatarUrl: string }>().avatarUrl;

    const seen = await request(h.app, { method: 'GET', url, token: owner.accessToken });
    expectStatus(seen, 200);
  });

  it('serves nothing without a session — the bucket stays behind auth', async () => {
    const posted = await upload(adult, PNG_1PX);
    const url = posted.json<{ avatarUrl: string }>().avatarUrl;

    const anonymous = await request(h.app, { method: 'GET', url });
    expect(anonymous.statusCode).toBe(401);
  });

  it('404s for a member with no avatar, and for a user id that does not exist', async () => {
    const none = await request(h.app, {
      method: 'GET',
      url: `/api/users/${adult.id}/avatar`,
      token: owner.accessToken,
    });
    expect(none.statusCode).toBe(404);

    const ghost = await request(h.app, {
      method: 'GET',
      url: '/api/users/00000000-0000-4000-8000-000000000999/avatar',
      token: owner.accessToken,
    });
    // Identical to the above on purpose: a different status here would let a
    // caller enumerate which user ids exist (D4).
    expect(ghost.statusCode).toBe(404);
    expect(errorCode(ghost)).toBe(errorCode(none));
  });

  it('ignores a hand-edited ?v and still serves the current object', async () => {
    const posted = await upload(owner, PNG_1PX);
    const self = posted.json<{ id: string }>();

    const forged = await request(h.app, {
      method: 'GET',
      url: `/api/users/${self.id}/avatar?v=${'f'.repeat(32)}.png`,
      token: owner.accessToken,
    });
    expectStatus(forged, 200);
    expect(Buffer.compare(forged.rawPayload, PNG_1PX)).toBe(0);
  });
});

/** `/api/users/<id>/avatar?v=<name>` -> `avatars/<id>/<name>`. */
function keyOf(url: string): string {
  const parsed = new URL(url, 'http://internal.invalid');
  const id = parsed.pathname.split('/')[3];
  return `avatars/${String(id)}/${String(parsed.searchParams.get('v'))}`;
}
