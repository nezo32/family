import { describe, expect, it } from 'vitest';

import {
  COMMENTABLE_ENTITY_TYPES,
  MEDIA_LIMITS,
  MEDIA_TICKET_TTL_SECONDS,
  ROLES,
  effectivePermissions,
} from '@family/shared';

import { AppError } from '../../core/errors.js';
import {
  HTML_DOCUMENT,
  PNG_1PX,
  SVG_WITH_SCRIPT,
  WAV_HEADER,
  WEBM_HEADER,
  buildGif,
  buildHeic,
  buildJpeg,
  buildMp3,
  buildMp4,
  buildPng,
  buildWebp,
  mp3DurationMs,
} from '../../test/media-fixtures.js';
import {
  assertWithinLimits,
  formatDurationRu,
  formatMegabytes,
  sniffMedia,
  type ProbedMedia,
} from './media.js';
import { bufferSource, probeMedia } from './media.probe.js';
import { ATTACHABLE_ENTITY_TYPES, mediaObjectKey, mediaUrlFor } from './media.service.js';
import { mintMediaTicket, parseMediaTicket } from './media.ticket.js';

/**
 * The media gate, without a database, a bucket or an HTTP request.
 *
 * Everything here is the part of the pipeline that decides **what a file is** —
 * the security boundary — and **whether we will keep it** — the limits. Both
 * are pure functions over bytes, which is exactly why they are testable this
 * way and why they were written to be.
 *
 * The round trip through real object storage lives in
 * `media.integration.test.ts`; that suite proves the plumbing, this one proves
 * the judgement.
 */

async function probe(buffer: Buffer): Promise<ProbedMedia> {
  const sniff = sniffMedia(buffer);
  if (!sniff.ok) throw new Error(`unexpectedly rejected: ${sniff.reason}`);
  return probeMedia(bufferSource(buffer), sniff.sniffed, buffer.subarray(0, 4096));
}

function rejection(buffer: Buffer): string {
  const sniff = sniffMedia(buffer);
  return sniff.ok ? `accepted as ${sniff.sniffed.container}` : sniff.reason;
}

/* -------------------------------------------------------------------------- */
/* Sniffing                                                                    */
/* -------------------------------------------------------------------------- */

describe('sniffMedia', () => {
  it('recognises the four picture formats by their bytes', () => {
    expect(sniffMedia(PNG_1PX)).toMatchObject({ ok: true, sniffed: { container: 'png' } });
    expect(sniffMedia(buildJpeg(100, 50))).toMatchObject({
      ok: true,
      sniffed: { container: 'jpeg' },
    });
    expect(sniffMedia(buildGif(4, 4))).toMatchObject({ ok: true, sniffed: { container: 'gif' } });
    expect(sniffMedia(buildWebp(8, 8))).toMatchObject({ ok: true, sniffed: { container: 'webp' } });
  });

  it('recognises MP4, QuickTime and MP3', () => {
    expect(sniffMedia(buildMp4())).toMatchObject({ ok: true, sniffed: { container: 'isobmff' } });
    expect(sniffMedia(buildMp4({ brand: 'qt  ' }))).toMatchObject({
      ok: true,
      sniffed: { container: 'isobmff' },
    });
    expect(sniffMedia(buildMp3(4))).toMatchObject({ ok: true, sniffed: { container: 'mp3' } });
    expect(sniffMedia(buildMp3(4, { id3: true }))).toMatchObject({
      ok: true,
      sniffed: { container: 'mp3' },
    });
  });

  it('refuses HEIC by name, not as an MP4', () => {
    // The failure this prevents: HEIC is `ftyp` exactly like MP4 is, so a brand
    // table that ignored it would store an iPhone photo as `video/mp4` and hand
    // the family a video that never plays.
    expect(rejection(buildHeic())).toBe('heic');
  });

  it('refuses the executable and the unplayable, each by name', () => {
    expect(rejection(SVG_WITH_SCRIPT)).toBe('svg');
    expect(rejection(WEBM_HEADER)).toBe('webm');
    expect(rejection(WAV_HEADER)).toBe('wav');
    expect(rejection(Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj'))).toBe('pdf');
  });

  it('refuses an HTML document whatever it is called', () => {
    // The avatar suite's most important case, restated for eight content types:
    // this endpoint serves from our own origin, behind the family's session.
    expect(rejection(HTML_DOCUMENT)).toBe('unknown');
  });

  it('does not mistake WAV or AVI for WebP just because both are RIFF', () => {
    const avi = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('AVI LIST', 'latin1'),
      Buffer.alloc(16),
    ]);
    expect(rejection(avi)).toBe('avi');
    expect(rejection(WAV_HEADER)).toBe('wav');
  });

  it('refuses a truncated file rather than guessing', () => {
    expect(rejection(Buffer.from([0x89, 0x50]))).toBe('unknown');
    expect(rejection(Buffer.alloc(0))).toBe('unknown');
  });

  it('refuses an ISO-BMFF brand nobody in this family can play', () => {
    // `ftyp` with a brand outside the table: a 3GPP2 oddity, a fragmented
    // container nobody here writes. Accepting every `ftyp` would be the same
    // mistake as accepting every `RIFF`.
    const alien = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from('ftypnope', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('nope', 'latin1'),
      Buffer.alloc(16),
    ]);
    alien.writeUInt32BE(alien.length, 0);
    expect(rejection(alien)).toBe('unknown');
  });
});

/* -------------------------------------------------------------------------- */
/* Probing                                                                     */
/* -------------------------------------------------------------------------- */

describe('probeMedia: still images', () => {
  it('reads PNG and GIF dimensions out of the header', async () => {
    await expect(probe(buildPng(1280, 960))).resolves.toMatchObject({
      contentType: 'image/png',
      kind: 'image',
      width: 1280,
      height: 960,
      durationMs: null,
    });
    await expect(probe(buildGif(320, 240))).resolves.toMatchObject({
      contentType: 'image/gif',
      width: 320,
      height: 240,
    });
  });

  it('walks past a fat EXIF block to the real JPEG frame header', async () => {
    // A signature scan would find the `SOF0` of an embedded thumbnail and
    // report its size — wrong, and plausible enough to ship.
    await expect(probe(buildJpeg(4032, 3024, 40_000))).resolves.toMatchObject({
      contentType: 'image/jpeg',
      width: 4032,
      height: 3024,
    });
  });

  it('reads a lossy WebP canvas', async () => {
    await expect(probe(buildWebp(512, 384))).resolves.toMatchObject({
      contentType: 'image/webp',
      width: 512,
      height: 384,
    });
  });
});

describe('probeMedia: ISO base media files', () => {
  it('reads size and duration from moov, and calls it video', async () => {
    await expect(
      probe(buildMp4({ width: 1920, height: 1080, durationMs: 12_500 })),
    ).resolves.toEqual({
      contentType: 'video/mp4',
      kind: 'video',
      width: 1920,
      height: 1080,
      durationMs: 12_500,
    });
  });

  it('applies the display matrix, so a portrait clip is portrait', async () => {
    // An iPhone records landscape pixels plus a 90° matrix. Reading `tkhd`
    // without the matrix boxes the feed card on its side.
    await expect(
      probe(buildMp4({ width: 1920, height: 1080, rotated: true })),
    ).resolves.toMatchObject({ width: 1080, height: 1920 });
  });

  it('finds moov when it sits after mdat, which is where a phone puts it', async () => {
    // The reason the probe reads from a seekable temp file instead of the
    // stream: nothing rewrites a 90 MB recording to move its index to the front.
    await expect(
      probe(buildMp4({ durationMs: 3000, padding: 4096, moovLast: true })),
    ).resolves.toMatchObject({ durationMs: 3000, kind: 'video' });
  });

  it('keeps a QuickTime file QuickTime', async () => {
    await expect(probe(buildMp4({ brand: 'qt  ' }))).resolves.toMatchObject({
      contentType: 'video/quicktime',
      kind: 'video',
    });
  });

  it('calls an audio-only MP4 audio, from its tracks and not its brand', async () => {
    // An `.m4a` is often written with brand `isom`; trusting the brand would
    // serve a voice message as a video that draws nothing.
    await expect(probe(buildMp4({ handler: 'soun', durationMs: 8000 }))).resolves.toEqual({
      contentType: 'audio/mp4',
      kind: 'audio',
      width: null,
      height: null,
      durationMs: 8000,
    });
  });
});

describe('probeMedia: MP3', () => {
  it('measures a constant-bitrate file from its frame header', async () => {
    const frames = 200;
    await expect(probe(buildMp3(frames))).resolves.toMatchObject({
      contentType: 'audio/mpeg',
      kind: 'audio',
      durationMs: mp3DurationMs(frames),
    });
  });

  it('skips an ID3v2 tag rather than reading it as audio', async () => {
    const frames = 100;
    const probed = await probe(buildMp3(frames, { id3: true }));
    expect(probed.durationMs).toBe(mp3DurationMs(frames));
  });
});

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

function limitError(probed: ProbedMedia, byteSize: number): AppError {
  try {
    assertWithinLimits(probed, byteSize);
  } catch (error) {
    if (AppError.isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected assertWithinLimits to throw');
}

const photo: ProbedMedia = {
  contentType: 'image/jpeg',
  kind: 'image',
  width: 3024,
  height: 4032,
  durationMs: null,
};

const clip: ProbedMedia = {
  contentType: 'video/mp4',
  kind: 'video',
  width: 1920,
  height: 1080,
  durationMs: 30_000,
};

describe('assertWithinLimits', () => {
  it('lets an ordinary phone photo and an ordinary clip through', () => {
    expect(() => {
      assertWithinLimits(photo, 4 * 1024 * 1024);
    }).not.toThrow();
    expect(() => {
      assertWithinLimits(clip, 40 * 1024 * 1024);
    }).not.toThrow();
  });

  it('names the limit and the actual size in Russian, not just "413"', () => {
    // The whole point of the limits living in the shared contract: a refusal
    // after a ninety-second upload has to say what would have worked.
    const error = limitError(photo, MEDIA_LIMITS.image.maxBytes + 1);
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.details?.file?.[0]).toContain('10 МБ');
    expect(error.details?.file?.[0]).toContain('Фото');
  });

  it('measures video by duration as well as by weight', () => {
    const long = { ...clip, durationMs: MEDIA_LIMITS.video.maxDurationMs + 1000 };
    const error = limitError(long, 10 * 1024 * 1024);
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.details?.file?.[0]).toContain('3 минуты');
  });

  it('refuses a file whose duration it could not read', () => {
    // An unmeasurable duration is an unenforceable limit, and "probably short
    // enough" is how a 40-minute file ends up in every nightly backup forever.
    const error = limitError({ ...clip, durationMs: null }, 1024);
    expect(error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(error.details?.file?.[0]).toContain('длительность');
  });

  it('refuses a decompression bomb by its declared dimensions', () => {
    // Nothing decodes it here — but six phones will, the moment it is drawn.
    const bomb: ProbedMedia = { ...photo, width: 50_000, height: 50_000 };
    const error = limitError(bomb, 200 * 1024);
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.details?.file?.[0]).toContain('50000×50000');
  });

  it('does not ask audio for dimensions', () => {
    expect(() => {
      assertWithinLimits(
        {
          contentType: 'audio/mpeg',
          kind: 'audio',
          width: null,
          height: null,
          durationMs: 30_000,
        },
        1024 * 1024,
      );
    }).not.toThrow();
  });
});

describe('Russian number formatting', () => {
  it('agrees with itself about minutes', () => {
    expect(formatDurationRu(60_000)).toBe('1 минута');
    expect(formatDurationRu(180_000)).toBe('3 минуты');
    expect(formatDurationRu(600_000)).toBe('10 минут');
    expect(formatDurationRu(45_000)).toBe('45 сек.');
  });

  it('rounds megabytes the way a person would read them', () => {
    expect(formatMegabytes(10 * 1024 * 1024)).toBe('10 МБ');
    expect(formatMegabytes(100 * 1024 * 1024)).toBe('100 МБ');
    expect(formatMegabytes(1_572_864)).toBe('1.5 МБ');
  });
});

/* -------------------------------------------------------------------------- */
/* Keys, URLs and the attachable set                                           */
/* -------------------------------------------------------------------------- */

describe('object keys and URLs', () => {
  it('builds a key from ids we minted, never from anything a client sent', () => {
    const key = mediaObjectKey('11111111-2222-4333-8444-555555555555', 'abcdef.mp4');
    expect(key).toBe('media/11111111-2222-4333-8444-555555555555/abcdef.mp4');
  });

  it('hands the client our own path and nothing resembling a bucket URL', () => {
    expect(mediaUrlFor('11111111-2222-4333-8444-555555555555')).toBe(
      '/api/media/11111111-2222-4333-8444-555555555555',
    );
  });
});

describe('what may hold media', () => {
  it('is narrower than the commentable set, deliberately', () => {
    // A task, an event and a goal take *comments*, and a comment takes media —
    // so a photo reaches them through the thread without every module that
    // deletes something having to learn about objects.
    expect([...ATTACHABLE_ENTITY_TYPES]).toEqual(['post', 'comment']);
    for (const type of ATTACHABLE_ENTITY_TYPES) {
      if (type === 'comment') continue;
      expect(COMMENTABLE_ENTITY_TYPES as readonly string[]).toContain(type);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* `media:read` — the permission that keeps a guest out of the photographs     */
/* -------------------------------------------------------------------------- */

describe('media:read (D15 §4)', () => {
  it('is held from `child` upwards and by no `guest`', () => {
    // Written against the matrix rather than against a list of role names, so
    // a future role inherits the rule instead of quietly missing it.
    expect(effectivePermissions('guest')).not.toContain('media:read');
    for (const role of ROLES) {
      if (role === 'guest') continue;
      expect(effectivePermissions(role), role).toContain('media:read');
    }
  });

  it('is a real narrowing: `guest` still reads the wall', () => {
    // The whole point. A guest keeps `member:read` — they see the card, the
    // body, the author and the thread — and loses only the bytes.
    const guest = effectivePermissions('guest');
    expect(guest).toContain('member:read');
    expect(guest).not.toContain('media:read');
  });

  it('is grantable to one person without touching the role', () => {
    // The reversibility that makes the safe default safe to take now: the
    // babysitter who genuinely should see the holiday photos is one row.
    expect(effectivePermissions('guest', ['media:read'])).toContain('media:read');
    // …and revocable from an adult, which is what a role-shaped check misses.
    expect(effectivePermissions('adult', [], ['media:read'])).not.toContain('media:read');
  });
});

/* -------------------------------------------------------------------------- */
/* Playback tickets                                                            */
/* -------------------------------------------------------------------------- */

const MEDIA_ID = '11111111-2222-4333-8444-555555555555';
const USER_ID = '99999999-8888-4777-8666-555555555555';

describe('playback tickets', () => {
  it('round-trips the object, the member and the expiry', () => {
    const now = new Date('2026-08-21T10:00:00.000Z');
    const ticket = mintMediaTicket(MEDIA_ID, USER_ID, now);
    expect(ticket).not.toBeNull();

    const parsed = parseMediaTicket(ticket?.token ?? '', now);
    expect(parsed?.mediaId).toBe(MEDIA_ID);
    expect(parsed?.userId).toBe(USER_ID);
    // Second precision, so the base36 payload stays short.
    expect(parsed?.expiresAt.getTime()).toBe(now.getTime() + MEDIA_TICKET_TTL_SECONDS * 1000);
  });

  it('hands the client a same-origin path, never a bucket URL', () => {
    const ticket = mintMediaTicket(MEDIA_ID, USER_ID);
    expect(ticket?.url.startsWith(`/api/media/${MEDIA_ID}/stream?t=`)).toBe(true);
  });

  it('refuses a tampered payload', () => {
    const now = new Date('2026-08-21T10:00:00.000Z');
    const token = mintMediaTicket(MEDIA_ID, USER_ID, now)?.token ?? '';
    const parts = token.split('.');

    // Point it at another object, keeping the signature.
    const otherMedia = [parts[0], 'a'.repeat(32), parts[2], parts[3], parts[4]].join('.');
    expect(parseMediaTicket(otherMedia, now)).toBeNull();

    // Claim to be somebody else.
    const otherUser = [parts[0], parts[1], 'b'.repeat(32), parts[3], parts[4]].join('.');
    expect(parseMediaTicket(otherUser, now)).toBeNull();

    // Extend your own expiry.
    const later = [parts[0], parts[1], parts[2], 'zzzzzzz', parts[4]].join('.');
    expect(parseMediaTicket(later, now)).toBeNull();

    // Flip one character of the signature.
    const signature = parts[4] ?? '';
    const flipped = [
      parts[0],
      parts[1],
      parts[2],
      parts[3],
      (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1),
    ].join('.');
    expect(parseMediaTicket(flipped, now)).toBeNull();
  });

  it('expires, and the expiry is what a stale `<video>` hits', () => {
    const minted = new Date('2026-08-21T10:00:00.000Z');
    const token = mintMediaTicket(MEDIA_ID, USER_ID, minted)?.token ?? '';

    const justBefore = new Date(minted.getTime() + (MEDIA_TICKET_TTL_SECONDS - 1) * 1000);
    expect(parseMediaTicket(token, justBefore)).not.toBeNull();

    const justAfter = new Date(minted.getTime() + (MEDIA_TICKET_TTL_SECONDS + 1) * 1000);
    expect(parseMediaTicket(token, justAfter)).toBeNull();
  });

  it('outlives the longest file the limits allow, so a playthrough never stalls', () => {
    // Audio is capped at ten minutes; a ticket that expired inside one would
    // break playback in the middle for no security gain anybody can name.
    const longest = Math.max(MEDIA_LIMITS.video.maxDurationMs, MEDIA_LIMITS.audio.maxDurationMs);
    expect(MEDIA_TICKET_TTL_SECONDS * 1000).toBeGreaterThan(longest);
  });

  it('refuses anything that is not one of ours, without throwing', () => {
    for (const junk of ['', 'nope', 'm1.a.b.c', `m2.${'a'.repeat(32)}.x.y.z`, 'x'.repeat(600)]) {
      expect(parseMediaTicket(junk)).toBeNull();
    }
  });

  it('will not mint for something that is not a uuid', () => {
    expect(mintMediaTicket('not-a-uuid', USER_ID)).toBeNull();
    expect(mintMediaTicket(MEDIA_ID, 'not-a-uuid')).toBeNull();
  });
});
