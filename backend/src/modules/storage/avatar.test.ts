import { describe, expect, it } from 'vitest';

import {
  avatarObjectKey,
  avatarUrlFor,
  buildAvatarObjectName,
  parseAvatarUrl,
} from './avatar.js';

/**
 * The URL ⇄ object-key mapping.
 *
 * `users.avatarUrl` is the *only* record of which object belongs to a member,
 * so this round trip is what makes "delete the previous object" possible at
 * all. It is also parsing attacker-adjacent input — the value in the column
 * came from us, but a bug here turns a hand-edited URL into a read of an
 * arbitrary bucket key.
 */

const USER = '11111111-2222-4333-8444-555555555555';

describe('avatar object naming', () => {
  it('round-trips a generated name through the URL', () => {
    const name = buildAvatarObjectName('image/webp');
    const parsed = parseAvatarUrl(avatarUrlFor(USER, name));

    expect(parsed).toEqual({
      userId: USER,
      objectName: name,
      key: avatarObjectKey(USER, name),
    });
    expect(parsed?.key).toBe(`avatars/${USER}/${name}`);
  });

  it('names the file by the sniffed type, never by the upload', () => {
    expect(buildAvatarObjectName('image/jpeg')).toMatch(/^[0-9a-f]{32}\.jpg$/);
    expect(buildAvatarObjectName('image/png')).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(buildAvatarObjectName('image/webp')).toMatch(/^[0-9a-f]{32}\.webp$/);
  });

  it('never generates the same name twice', () => {
    const names = new Set(Array.from({ length: 200 }, () => buildAvatarObjectName('image/webp')));
    expect(names.size).toBe(200);
  });
});

describe('parseAvatarUrl', () => {
  const name = 'a'.repeat(32) + '.webp';

  it('returns null for an OAuth provider avatar', () => {
    // Google and Telegram still write absolute URLs into this column. Treating
    // one as ours would mean issuing a DeleteObject against a key that does not
    // exist — harmless — and, worse, trying to stream it out of our bucket.
    expect(parseAvatarUrl('https://lh3.googleusercontent.com/a/ACg8ocK')).toBeNull();
    expect(parseAvatarUrl('https://t.me/i/userpic/320/abc.jpg')).toBeNull();
  });

  it('returns null for an absolute URL that mimics our path on another host', () => {
    expect(parseAvatarUrl(`https://evil.example/api/users/${USER}/avatar?v=${name}`)).toBeNull();
  });

  it('returns null for null, empty and unparseable input', () => {
    expect(parseAvatarUrl(null)).toBeNull();
    expect(parseAvatarUrl(undefined)).toBeNull();
    expect(parseAvatarUrl('')).toBeNull();
    expect(parseAvatarUrl('not a url at all ????')).toBeNull();
  });

  it('rejects a traversal attempt in the object name', () => {
    for (const evil of [
      '../../../etc/passwd',
      '..%2f..%2fsecret.png',
      'a/b.webp',
      `${'a'.repeat(32)}.webp/../../x`,
    ]) {
      expect(parseAvatarUrl(`/api/users/${USER}/avatar?v=${encodeURIComponent(evil)}`)).toBeNull();
    }
  });

  it('rejects an object name with a disallowed extension', () => {
    expect(parseAvatarUrl(`/api/users/${USER}/avatar?v=${'a'.repeat(32)}.svg`)).toBeNull();
    expect(parseAvatarUrl(`/api/users/${USER}/avatar?v=${'a'.repeat(32)}.html`)).toBeNull();
  });

  it('rejects a missing or wrong-length random part', () => {
    expect(parseAvatarUrl(`/api/users/${USER}/avatar`)).toBeNull();
    expect(parseAvatarUrl(`/api/users/${USER}/avatar?v=short.webp`)).toBeNull();
    expect(parseAvatarUrl(`/api/users/${USER}/avatar?v=${'z'.repeat(32)}.webp`)).toBeNull();
  });

  it('rejects a path that is not the avatar route', () => {
    expect(parseAvatarUrl(`/api/users/${USER}/avatar/extra?v=${name}`)).toBeNull();
    expect(parseAvatarUrl(`/api/users/${USER}?v=${name}`)).toBeNull();
    expect(parseAvatarUrl(`/api/members/${USER}/avatar?v=${name}`)).toBeNull();
  });
});
