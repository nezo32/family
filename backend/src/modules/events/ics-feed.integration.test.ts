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

  /** A single, non-recurring event — what "I just added something" looks like. */
  async function createOneOff(title: string, dtstartLocal: string): Promise<string> {
    const response = await request(h.app, {
      method: 'POST',
      url: '/api/events/series',
      token: adult.accessToken,
      payload: {
        title,
        durationMinutes: 60,
        recurrence: {
          mode: 'once',
          dtstartLocal,
          timezone: 'Europe/Moscow',
          rdatesLocal: [],
          exdatesLocal: [],
        },
        attendeeIds: [],
      },
    });
    expect([200, 201]).toContain(response.statusCode);
    return response.json<{ id: string }>().id;
  }

  async function fetchFeed(token: string, headers?: Record<string, string>) {
    return request(h.app, {
      method: 'GET',
      url: `/api/events/feed.ics?token=${encodeURIComponent(token)}`,
      ...(headers ? { headers } : {}),
    });
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

  /**
   * The bug this block exists to prevent recurring.
   *
   * "I created an event and it never showed up on my iPhone" has two possible
   * causes and they need opposite fixes: the event is missing from the document
   * (a feed bug) or the phone never asked again (a freshness bug). These tests
   * pin the second one down, because it is the one that looks like nothing is
   * wrong — a 304 is a *correct-looking* response right up until the content it
   * claims is unchanged has in fact changed.
   */
  describe('freshness — what makes the phone come back', () => {
    it('changes the ETag and carries the new VEVENT once an event is added', async () => {
      const { token } = await feedToken(adult);

      const before = await fetchFeed(token);
      expectStatus(before, 200);
      const firstEtag = before.headers.etag as string;
      const firstModified = before.headers['last-modified'] as string;
      expect(firstEtag).toBeTruthy();
      expect(firstModified).toBeTruthy();
      expect(before.body).not.toContain('Внезапный ужин');

      await createOneOff('Внезапный ужин', '2026-09-12T19:00:00');

      const after = await fetchFeed(token);
      expectStatus(after, 200);

      // The two things the phone needs: a validator that says "different", and
      // the event itself in the body.
      expect(after.headers.etag).not.toBe(firstEtag);
      expect(parseIcs(after.body).entries.get('SUMMARY')?.join('\n') ?? '').toContain(
        'Внезапный ужин',
      );

      // `Last-Modified` must move forward too, or a client that validates on
      // dates rather than entity tags is told the calendar is unchanged.
      const secondModified = after.headers['last-modified'] as string;
      expect(Date.parse(secondModified)).toBeGreaterThan(Date.parse(firstModified));
    });

    it('answers the iPhone’s If-Modified-Since: 304 while unchanged, 200 once it changed', async () => {
      await createOneOff('Плавание', '2026-09-14T08:00:00');
      const { token } = await feedToken(adult);

      const first = await fetchFeed(token);
      expectStatus(first, 200);
      const lastModified = first.headers['last-modified'] as string;
      expect(lastModified).toBeTruthy();

      // iOS `dataaccessd` sends this header and never `If-None-Match`. Before
      // the feed emitted `Last-Modified` there was nothing here to answer.
      const unchanged = await fetchFeed(token, { 'if-modified-since': lastModified });
      expect(unchanged.statusCode).toBe(304);
      expect(unchanged.headers.etag).toBe(first.headers.etag);

      await createOneOff('Родительское собрание', '2026-09-15T18:30:00');

      const changed = await fetchFeed(token, { 'if-modified-since': lastModified });
      expectStatus(changed, 200);
      expect(parseIcs(changed.body).entries.get('SUMMARY')?.join('\n') ?? '').toContain(
        'Родительское собрание',
      );
    });

    it('does not serve a stale 304 after an event is deleted', async () => {
      await createOneOff('Останется', '2026-09-16T10:00:00');
      const doomed = await createOneOff('Исчезнет', '2026-09-17T10:00:00');
      const { token } = await feedToken(adult);

      const first = await fetchFeed(token);
      expectStatus(first, 200);
      const lastModified = first.headers['last-modified'] as string;

      const removed = await request(h.app, {
        method: 'DELETE',
        url: `/api/events/series/${doomed}`,
        token: adult.accessToken,
        payload: { scope: 'all' },
      });
      expectStatus(removed, 200);

      // A `Last-Modified` derived from "the newest event still in the document"
      // would move *backwards* here, the phone's If-Modified-Since would look
      // newer than it, and the deleted event would stay on the phone forever.
      const after = await fetchFeed(token, { 'if-modified-since': lastModified });
      expectStatus(after, 200);
      const summaries = parseIcs(after.body).entries.get('SUMMARY')?.join('\n') ?? '';
      expect(summaries).toContain('Останется');
      expect(summaries).not.toContain('Исчезнет');
    });

    it('advertises a poll interval a subscribing client can act on', async () => {
      const { token } = await feedToken(adult);
      const { entries } = parseIcs((await fetchFeed(token)).body);

      // Apple reads REFRESH-INTERVAL, Outlook and friends read X-PUBLISHED-TTL.
      // Both must be present and both must say the same thing, or the feed
      // advertises two schedules and gets whichever one the reader parsed.
      const refresh = entries.get('REFRESH-INTERVAL')?.[0];
      const ttl = entries.get('X-PUBLISHED-TTL')?.[0];
      expect(refresh).toBeTruthy();
      expect(ttl).toBe(refresh);

      // Minutes or whole hours, and no slower than hourly — beyond that the
      // calendar stops feeling like it belongs to the family.
      const match = /^PT(?:(\d+)H|(\d+)M)$/.exec(refresh ?? '');
      expect({ refresh, parsed: match !== null }).toEqual({ refresh, parsed: true });
      const minutes = match?.[1] !== undefined ? Number(match[1]) * 60 : Number(match?.[2]);
      expect(minutes).toBeGreaterThan(0);
      expect(minutes).toBeLessThanOrEqual(60);

      // A subscribing client needs these to treat the document as a feed at
      // all rather than as a one-off import.
      expect(entries.get('METHOD')).toEqual(['PUBLISH']);
      expect(entries.get('CALSCALE')).toEqual(['GREGORIAN']);
    });
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
