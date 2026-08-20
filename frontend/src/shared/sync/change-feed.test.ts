import { describe, expect, it } from 'vitest';
import { CHANGE_DOMAINS } from '@family/shared';
import {
  CHANGE_DOMAIN_KEYS,
  DEGRADED_POLL_MS,
  IDLE_POLL_MS,
  LIVE_POLL_MS,
  diffRevisions,
  pollIntervalMs,
} from './change-feed';

/**
 * The two rules of the change feed, as pure functions.
 *
 * `docs/CONVENTIONS.md` says not to test framework behaviour, so nothing here
 * asserts that TanStack Query honours `refetchIntervalInBackground` or
 * `networkMode`. `pollIntervalMs` exists precisely so *our* rule can be tested
 * without testing the library.
 */

describe('diffRevisions', () => {
  it('treats the first response as a baseline, not as a change', () => {
    // Otherwise every client would invalidate everything the moment it opened.
    expect(diffRevisions({}, { tasks: 5 })).toEqual([]);
  });

  it('reports nothing when nothing moved', () => {
    expect(diffRevisions({ tasks: 5 }, { tasks: 5 })).toEqual([]);
  });

  it('reports a domain whose counter advanced', () => {
    expect(diffRevisions({ tasks: 5 }, { tasks: 6 })).toEqual(['tasks']);
  });

  it('reports a domain whose counter went *backwards*', () => {
    // Redis was rebuilt and the counters restarted at 1. Every client is now
    // holding a number that is too high, and each must invalidate exactly once
    // and then be correct. This is why the comparison is `!==` and never `>`.
    expect(diffRevisions({ tasks: 5 }, { tasks: 1 })).toEqual(['tasks']);
  });

  it('does not treat a domain that disappeared as a change', () => {
    // The caller's permissions narrowed, so the server stopped sending it.
    // "The number went away" is not "the data moved", and the query it belongs
    // to is one this caller may no longer run.
    expect(diffRevisions({ tasks: 5, goals: 2 }, { tasks: 5 })).toEqual([]);
  });

  it('reports every domain that moved, and only those', () => {
    const changed = diffRevisions(
      { tasks: 1, goals: 1, shopping: 1 },
      { tasks: 2, goals: 1, shopping: 9 },
    );
    expect(changed.sort()).toEqual(['shopping', 'tasks']);
  });
});

describe('pollIntervalMs', () => {
  it('does not poll at all while the document is hidden', () => {
    // Locking an iPhone fires `visibilitychange → hidden`, so a phone in a
    // pocket costs the family nothing. `false`, not "slowly".
    expect(pollIntervalMs({ visible: false, live: true })).toBe(false);
    expect(pollIntervalMs({ visible: false, live: false })).toBe(false);
  });

  it('polls every five seconds while a live screen is mounted', () => {
    expect(pollIntervalMs({ visible: true, live: true })).toBe(LIVE_POLL_MS);
    expect(LIVE_POLL_MS).toBe(5_000);
  });

  it('polls every fifteen seconds otherwise', () => {
    expect(pollIntervalMs({ visible: true, live: false })).toBe(IDLE_POLL_MS);
    expect(IDLE_POLL_MS).toBe(15_000);
  });

  it('backs off a failing feed instead of hammering it', () => {
    // A missing or broken `/api/changes` must not cost four failing requests a
    // minute forever. The app still works on focus refetching alone.
    expect(pollIntervalMs({ visible: true, live: false, degraded: true })).toBe(DEGRADED_POLL_MS);
    // …and backing off beats the live rate: asking a dead route twelve times as
    // often buys nothing.
    expect(pollIntervalMs({ visible: true, live: true, degraded: true })).toBe(DEGRADED_POLL_MS);
    // A hidden tab still polls not at all, degraded or not.
    expect(pollIntervalMs({ visible: false, live: true, degraded: true })).toBe(false);
  });
});

describe('CHANGE_DOMAIN_KEYS', () => {
  it('covers every domain the server can send', () => {
    // A domain added to the shared contract with no keys here would arrive,
    // diff correctly, and invalidate nothing at all.
    expect(Object.keys(CHANGE_DOMAIN_KEYS).sort()).toEqual([...CHANGE_DOMAINS].sort());
  });

  it('fans «Сегодня» in from every domain that feeds it', () => {
    // The dashboard is a view over five domains, not a domain of its own.
    const feedsDashboard = Object.entries(CHANGE_DOMAIN_KEYS)
      .filter(([, keys]) => keys.some((key) => (key as string[])[0] === 'dashboard'))
      .map(([domain]) => domain)
      .sort();
    expect(feedsDashboard).toEqual(['events', 'goals', 'members', 'shopping', 'tasks', 'wall']);
  });

  it('routes the calendar under its own key root, which is not «events»', () => {
    expect(CHANGE_DOMAIN_KEYS.events).toContainEqual(['calendar']);
  });

  it('repairs the affordance list when the roster moves', () => {
    // A role change has to reach `['me']`, or the client keeps rendering
    // buttons the server will refuse for up to ten minutes.
    expect(CHANGE_DOMAIN_KEYS.members).toContainEqual(['me']);
  });

  it('keeps the inbox to itself', () => {
    // The bell is not on the dashboard, and a notification should not cost
    // every open client a dashboard refetch.
    expect(CHANGE_DOMAIN_KEYS.notifications).toEqual([['notifications']]);
  });
});
