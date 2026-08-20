import { vi } from 'vitest';

/**
 * A controllable `window.matchMedia`.
 *
 * jsdom ships a `matchMedia` that answers `false` to everything and never
 * changes, which makes it useless for the one thing this app asks a media query
 * for: *which component renders* — a `Dialog` or a `Drawer`, a `Popover` or a
 * sheet. These helpers let a test say "this is a phone" and, more importantly,
 * "this stopped being a phone", so the live-update path is covered rather than
 * assumed.
 *
 * Matching is deliberately literal: a query matches only if the test listed it.
 * A component that quietly changes which media query it gates on therefore
 * fails its test instead of silently falling through to `false`.
 */

interface FakeList {
  matches: boolean;
  media: string;
  listeners: Set<(event: MediaQueryListEvent) => void>;
}

let registry: Map<string, FakeList> | null = null;

/**
 * Install a `matchMedia` that reports the given queries as matching.
 *
 * ```ts
 * mockMediaQuery(['(pointer: coarse)']);   // a phone
 * mockMediaQuery([]);                      // a mouse
 * ```
 */
export function mockMediaQuery(matching: readonly string[]): void {
  const lists = new Map<string, FakeList>();
  registry = lists;

  const matchMedia = (query: string): MediaQueryList => {
    const existing = lists.get(query);
    if (existing) return asMediaQueryList(existing);
    const created: FakeList = {
      matches: matching.includes(query),
      media: query,
      listeners: new Set(),
    };
    lists.set(query, created);
    return asMediaQueryList(created);
  };

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn(matchMedia),
  });
}

/** Flip a query and notify its subscribers, as a real browser would. */
export function setMediaQuery(query: string, matches: boolean): void {
  const list = registry?.get(query);
  if (!list) throw new Error(`No component subscribed to ${query}`);
  list.matches = matches;
  const event = { matches, media: query } as MediaQueryListEvent;
  for (const listener of list.listeners) listener(event);
}

function asMediaQueryList(list: FakeList): MediaQueryList {
  return {
    get matches() {
      return list.matches;
    },
    media: list.media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      list.listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      list.listeners.delete(listener);
    },
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}
