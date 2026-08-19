import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, vi } from 'vitest';

/**
 * Global test setup.
 *
 * jsdom is missing a handful of browser APIs this app relies on. Stubbing them
 * here — rather than in each test — keeps component tests from failing for
 * reasons that have nothing to do with the code under test.
 */

beforeAll(() => {
  // `ThemeProvider` and any responsive hook call this on mount.
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string): MediaQueryList =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    });
  }

  // Radix primitives (Select, DropdownMenu, ScrollArea) need these.
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }

  if (!window.IntersectionObserver) {
    window.IntersectionObserver = class {
      root = null;
      rootMargin = '';
      thresholds: readonly number[] = [];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
  }

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(() => false);
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn();
  }

  // `AppShell` scroll restoration.
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;

  // jsdom ships its own `AbortController`, but `fetch`/`Request` come from
  // Node's undici, which brand-checks `signal` against *its* `AbortSignal` and
  // throws `Expected signal to be an instance of AbortSignal`. React Router 7's
  // data router constructs a `Request` for every navigation, so without this any
  // test that renders the router fails for a reason that has nothing to do with
  // the app. Retry construction without the signal when the brand check trips.
  const NativeRequest = globalThis.Request;
  globalThis.Request = new Proxy(NativeRequest, {
    construct(target, args: [RequestInfo | URL, RequestInit?]) {
      const [input, init] = args;
      try {
        return new target(input, init);
      } catch {
        const { signal: _signal, ...rest } = init ?? {};
        return new target(input, rest);
      }
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
