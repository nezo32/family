import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hasTestDb } from '../../test/db.js';
import {
  closeHarness,
  createMember,
  createOwner,
  expectStatus,
  request,
  resetDatabase,
  startHarness,
  type Harness,
  type TestUser,
} from '../../test/harness.js';

/**
 * The subscribed calendar feed, end to end.
 *
 * `ics.service.ts` is well unit-tested for folding, escaping and stamping. What
 * only an integration test can answer is whether the *route* is reachable
 * without a session (iOS Calendar has no way to run our refresh flow), whether
 * the document it emits parses, and whether rotating the token really kills the
 * old URL — the last one depends on a revocation epoch stored on the user row,
 * so a mocked repository proves nothing.
 */
describe.skipIf(!hasTestDb)('ICS feed (integration)', () => {
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

  async function feedToken(user: TestUser): Promise<{ token: string; url: string }> {
    const response = await request(h.app, {
      method: 'GET',
      url: '/api/events/feed/token',
      token: user.accessToken,
    });
    expectStatus(response, 200);
    return response.json<{ token: string; url: string }>();
  }

  async function createEvent(title: string): Promise<string> {
    const response = await request(h.app, {
      method: 'POST',
      url: '/api/events/series',
      token: adult.accessToken,
      payload: {
        title,
        location: 'Дом',
        durationMinutes: 90,
        recurrence: {
          mode: 'preset',
          preset: { kind: 'weekly', interval: 1, weekdays: ['MO'] },
          ends: { type: 'after', count: 3 },
          dtstartLocal: '2026-09-07T19:00:00',
          timezone: 'Europe/Moscow',
          rdatesLocal: [],
          exdatesLocal: [],
        },
        attendeeIds: [],
      },
    });
    expect([200, 201]).toContain(response.statusCode);
    return (response.json<{ id: string }>()).id;
  }

  /* -------------------------- a tiny ICS reader ------------------------- */

  /**
   * Unfolds and splits an ICS document.
   *
   * Deliberately hand-rolled rather than pulled from a library: the point is to
   * assert that the bytes on the wire satisfy RFC 5545's *structural* rules —
   * CRLF endings, ≤75-octet lines, matched BEGIN/END — which a forgiving parser
   * would paper over.
   */
  function parseIcs(body: string): { lines: string[]; entries: Map<string, string[]> } {
    expect(body.endsWith('\r\n')).toBe(true);

    for (const raw of body.split('\r\n')) {
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(75);
    }

    // Unfold: a leading space or tab continues the previous line.
    const lines: string[] = [];
    for (const raw of body.split('\r\n')) {
      if (raw === '') continue;
      if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length > 0) {
        lines[lines.length - 1] += raw.slice(1);
      } else {
        lines.push(raw);
      }
    }

    const entries = new Map<string, string[]>();
    for (const line of lines) {
      const colon = line.indexOf(':');
      const name = (colon === -1 ? line : line.slice(0, colon)).split(';')[0] ?? line;
      const value = colon === -1 ? '' : line.slice(colon + 1);
      entries.set(name, [...(entries.get(name) ?? []), value]);
    }
    return { lines, entries };
  }

  it('serves a parseable calendar to a token-only request', async () => {
    await createEvent('Тренировка');
    const { token, url } = await feedToken(adult);

    expect(url).toContain('/api/events/feed.ics?token=');

    // No bearer token, no cookie — exactly what iOS Calendar sends.
    const response = await request(h.app, {
      method: 'GET',
      url: `/api/events/feed.ics?token=${encodeURIComponent(token)}`,
    });
    expectStatus(response, 200);
    expect(response.headers['content-type']).toContain('text/calendar');
    expect(response.headers['cache-control']).toContain('private');

    const { lines, entries } = parseIcs(response.body);

    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines[lines.length - 1]).toBe('END:VCALENDAR');
    expect(entries.get('VERSION')).toEqual(['2.0']);
    expect(entries.get('PRODID')?.[0]).toContain('Family');

    // Every BEGIN has its END, and the events made it in.
    const begins = lines.filter((l) => l === 'BEGIN:VEVENT').length;
    const ends = lines.filter((l) => l === 'END:VEVENT').length;
    expect(begins).toBe(ends);
    expect(begins).toBe(3);

    // Each VEVENT carries the three properties a client needs to show it.
    expect(entries.get('UID')).toHaveLength(3);
    expect(entries.get('DTSTART')).toHaveLength(3);
    expect(entries.get('SUMMARY')?.every((s) => s.includes('Тренировка'))).toBe(true);

    // UIDs are stable identities, not random per fetch.
    const again = await request(h.app, {
      method: 'GET',
      url: `/api/events/feed.ics?token=${encodeURIComponent(token)}`,
    });
    expectStatus(again, 200);
    expect(parseIcs(again.body).entries.get('UID')).toEqual(entries.get('UID'));
  });

  it('honours If-None-Match with a 304', async () => {
    await createEvent('Ужин');
    const { token } = await feedToken(adult);

    const first = await request(h.app, {
      method: 'GET',
      url: `/api/events/feed.ics?token=${encodeURIComponent(token)}`,
    });
    expectStatus(first, 200);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const second = await request(h.app, {
      method: 'GET',
      url: `/api/events/feed.ics?token=${encodeURIComponent(token)}`,
      headers: { 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
  });

  it('kills the old URL when the token is rotated', async () => {
    await createEvent('Секция');
    const { token: original } = await feedToken(adult);

    const before = await request(h.app, {
      method: 'GET',
      url: `/api/events/feed.ics?token=${encodeURIComponent(original)}`,
    });
    expectStatus(before, 200);

    const rotate = await request(h.app, {
      method: 'POST',
      url: '/api/events/feed/token/rotate',
      token: adult.accessToken,
      payload: {},
    });
    expectStatus(rotate, 200);
    const rotated = (rotate.json<{ token: string }>()).token;
    expect(rotated).not.toBe(original);

    // The new link works…
    const withNew = await request(h.app, {
      method: 'GET',
      url: `/api/events/feed.ics?token=${encodeURIComponent(rotated)}`,
    });
    expectStatus(withNew, 200);

    // …and the old one is gone. 404, not 401: a revoked link must not confirm
    // that a feed exists at this URL.
    const withOld = await request(h.app, {
      method: 'GET',
      url: `/api/events/feed.ics?token=${encodeURIComponent(original)}`,
    });
    expect(withOld.statusCode).toBe(404);
  });

  it('refuses a forged, truncated or foreign token with a 404', async () => {
    const { token } = await feedToken(adult);

    const tampered = [
      'garbage',
      token.slice(0, -4),
      `${token}x`,
      token.replace(/^f1\./, 'f2.'),
    ];

    for (const candidate of tampered) {
      const response = await request(h.app, {
        method: 'GET',
        url: `/api/events/feed.ics?token=${encodeURIComponent(candidate)}`,
      });
      expect({ candidate, status: response.statusCode }).toEqual({ candidate, status: 404 });
    }
  });

  it('gives every member their own feed, and one member cannot read another’s', async () => {
    const mine = await feedToken(adult);
    const theirs = await feedToken(owner);
    expect(mine.token).not.toBe(theirs.token);

    // The token identifies the viewer, so a private event of the owner's must
    // not appear in the adult's document.
    const secret = await request(h.app, {
      method: 'POST',
      url: '/api/events/series',
      token: owner.accessToken,
      payload: {
        title: 'Сюрприз на день рождения',
        durationMinutes: 60,
        visibility: 'private',
        recurrence: {
          mode: 'once',
          dtstartLocal: '2026-09-10T12:00:00',
          timezone: 'Europe/Moscow',
          rdatesLocal: [],
          exdatesLocal: [],
        },
        attendeeIds: [],
      },
    });
    expect([200, 201]).toContain(secret.statusCode);

    const ownerFeed = await request(h.app, {
      method: 'GET',
      url: `/api/events/feed.ics?token=${encodeURIComponent(theirs.token)}`,
    });
    expectStatus(ownerFeed, 200);
    expect(parseIcs(ownerFeed.body).entries.get('SUMMARY')?.join('\n') ?? '').toContain('Сюрприз');

    const adultFeed = await request(h.app, {
      method: 'GET',
      url: `/api/events/feed.ics?token=${encodeURIComponent(mine.token)}`,
    });
    expectStatus(adultFeed, 200);

    // Compare on the unfolded document so a line break cannot hide the title.
    const unfolded = parseIcs(adultFeed.body)
      .entries.get('SUMMARY')
      ?.join('\n');
    expect(unfolded ?? '').not.toContain('Сюрприз');
  });
});
