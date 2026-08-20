import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockMediaQuery } from '@/test/media';
import { PullToRefresh } from './pull-to-refresh';

/**
 * §C-gestures/G6, and §F8 — the rule the whole component exists to keep.
 *
 * The one thing that must never happen here is `location.reload()`: in an
 * installed PWA a reload is a cold start that throws away the Query cache, the
 * shopping outbox and any half-typed form. So there is a test that asserts on
 * its absence, not just on the refetch's presence.
 */

function touch(type: string, x: number, y: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }],
  });
  act(() => {
    document.dispatchEvent(event);
  });
}

function pull(from: number, to: number): void {
  touch('touchstart', 160, from);
  touch('touchmove', 160, from + 10);
  touch('touchmove', 160, to);
  touch('touchend', 160, to);
}

let client: QueryClient;
let refetch: ReturnType<typeof vi.fn>;

function mount(): void {
  render(
    <QueryClientProvider client={client}>
      <PullToRefresh>
        <p>Сегодня</p>
      </PullToRefresh>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMediaQuery(['(pointer: coarse)']);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  refetch = vi.fn(async () => undefined);
  client.refetchQueries = refetch as unknown as QueryClient['refetchQueries'];
  Object.defineProperty(window, 'scrollY', { value: 0, writable: true, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.removeAttribute('data-scroll-locked');
});

describe('pull to refresh', () => {
  it('refetches the active queries', async () => {
    mount();

    pull(0, 120);
    // Let the refresh promise settle before the assertions, so the indicator's
    // state update happens inside `act`.
    await act(async () => {
      await Promise.resolve();
    });

    expect(refetch).toHaveBeenCalledWith({ type: 'active' });
  });

  /**
   * §F8 is a "never do X" rule, and jsdom's `Location` is not configurable, so
   * a spy cannot express it. The source itself can: a reload reintroduced here
   * would be invisible to every behavioural test in this file — the refetch
   * would still happen — and would cost a family member their half-typed form
   * the first time they pulled the screen.
   */
  it('contains no `location.reload` at all', () => {
    const source = readFileSync(
      join(import.meta.dirname, 'pull-to-refresh.tsx'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/location\s*\.\s*reload/);
  });

  it('does nothing when the pull stops short of the 64px threshold', () => {
    mount();
    pull(0, 40);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('does nothing anywhere but the very top of the page', () => {
    Object.defineProperty(window, 'scrollY', { value: 400, writable: true, configurable: true });
    mount();
    pull(0, 200);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('stays out of the way while a sheet is open', () => {
    // Radix and vaul both lock the body while a modal is up; a sheet's own drag
    // handle is a downward drag at the top of a surface, which is this gesture
    // aimed at something else.
    document.body.setAttribute('data-scroll-locked', '');
    mount();
    pull(0, 200);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('ignores an upward drag', () => {
    mount();
    touch('touchstart', 160, 300);
    touch('touchmove', 160, 200);
    touch('touchend', 160, 200);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('ignores a mostly-sideways drag', () => {
    mount();
    touch('touchstart', 160, 0);
    touch('touchmove', 300, 20);
    touch('touchmove', 340, 200);
    touch('touchend', 340, 200);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('is not offered to a mouse', () => {
    mockMediaQuery([]);
    mount();
    pull(0, 200);
    expect(refetch).not.toHaveBeenCalled();
  });
});
