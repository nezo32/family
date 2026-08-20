import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { mockMediaQuery, setMediaQuery } from '@/test/media';
import { isCoarsePointer, useCoarsePointer } from './use-coarse-pointer';

/**
 * The whole touch interaction model — sheets instead of dialogs, swipe rows,
 * long-press menus, pull-to-refresh — hangs off this one query, so the query
 * itself is the thing worth pinning down.
 *
 * It must be `(pointer: coarse)` and **not** `display-mode: standalone`. That is
 * not a stylistic preference: gating on standalone would hide every gesture
 * from whichever family member has not installed the PWA — most likely the
 * grandmother, the person who most needs a large forgiving swipe target — and
 * would make the entire model untestable in a browser. A regression here is
 * silent on the developer's installed phone and total for everyone else, which
 * is exactly the kind of thing a test exists for.
 */

function Probe() {
  return <span data-testid="probe">{useCoarsePointer() ? 'coarse' : 'fine'}</span>;
}

describe('useCoarsePointer', () => {
  it('gates on (pointer: coarse)', () => {
    mockMediaQuery(['(pointer: coarse)']);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('coarse');
    expect(window.matchMedia).toHaveBeenCalledWith('(pointer: coarse)');
  });

  it('does not gate on display-mode: standalone', () => {
    // An installed PWA on a desktop is still a mouse; a phone in Safari is
    // still a thumb. Only the pointer decides.
    mockMediaQuery(['(display-mode: standalone)']);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('fine');
  });

  it('reports a phone in the browser as coarse, not just an installed one', () => {
    mockMediaQuery(['(pointer: coarse)']); // no standalone in the list
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('coarse');
  });

  it('is live — a tablet that gains a mouse re-renders', () => {
    mockMediaQuery(['(pointer: coarse)']);
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('coarse');

    act(() => {
      setMediaQuery('(pointer: coarse)', false);
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('fine');
  });

  it('falls back to fine when matchMedia is unavailable', () => {
    // Fine is the safe default: it renders a dialog with a visible close button
    // and a footer, which a thumb can still operate. Defaulting to coarse would
    // give a mouse user swipe-to-dismiss chrome and no way to swipe.
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: undefined,
    });
    try {
      expect(isCoarsePointer()).toBe(false);
      render(<Probe />);
      expect(screen.getByTestId('probe')).toHaveTextContent('fine');
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: original,
      });
    }
  });
});
