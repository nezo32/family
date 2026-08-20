import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ResponsiveDialogBody,
  ResponsiveDialogFrame,
  ResponsiveDialogTitle,
} from './responsive-dialog';

/**
 * The keyboard geometry of the bottom-sheet surface.
 *
 * These are class assertions, which is normally a smell — but the classes are
 * the whole mechanism here, and both of the ways this fix can silently stop
 * working are invisible to a rendering test: the surface reverting to
 * `bottom-0`, and `vaul` being handed the keyboard problem again. Neither shows
 * up as a failure anywhere else, and neither can be seen on a device this
 * project has no access to. `keyboard-viewport.spec.ts` measures what the
 * classes resolve to; this measures that the sheet still carries them.
 */

function coarse(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('pointer: coarse') ? matches : false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

function surface(): HTMLElement {
  return screen.getByTestId('surface').closest('[data-slot="responsive-dialog"]') as HTMLElement;
}

describe('the bottom sheet is placed relative to the keyboard, not the layout viewport', () => {
  beforeEach(() => {
    coarse(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function open(size: 'auto' | 'tall' | 'full') {
    return render(
      <ResponsiveDialogFrame open size={size} onOpenChange={() => undefined}>
        <ResponsiveDialogTitle>Действия</ResponsiveDialogTitle>
        <ResponsiveDialogBody>
          <span data-testid="surface">содержимое</span>
        </ResponsiveDialogBody>
      </ResponsiveDialogFrame>,
    );
  }

  it('anchors to `bottom-above-keyboard`, never to `bottom-0`', () => {
    open('auto');
    const classes = surface().className;
    expect(classes).toContain('bottom-above-keyboard');
    // `bottom-0` would put the sheet behind the keyboard on iOS, which is the
    // half of the reported defect that is not WebKit's fault.
    expect(classes.split(/\s+/)).not.toContain('bottom-0');
  });

  it('caps its height by the keyboard inset, so lifting it cannot push the header off', () => {
    for (const size of ['auto', 'tall', 'full'] as const) {
      const view = open(size);
      expect(surface().className, `${size} sheet`).toContain('var(--viewport-keyboard,0px)');
      view.unmount();
    }
  });

  it('takes the keyboard away from vaul', () => {
    // `repositionInputs` is vaul's own avoidance. It computes the lift as
    // `innerHeight - visualViewport.height` with no `offsetTop` term and no
    // `scroll` listener, which over-lifts the sheet by however far iOS has
    // scrolled the visual viewport and leaves a band of background under it —
    // the photograph that came with the report. Turning it off is what makes
    // `--viewport-keyboard` the single source of the number.
    open('auto');
    expect(surface().hasAttribute('data-vaul-drawer'), 'this is the vaul surface').toBe(true);
    expect(
      surface().style.bottom,
      'vaul must not be writing an inline bottom of its own',
    ).toBe('');
  });
});

describe('the dialog surface on a fine pointer is untouched', () => {
  beforeEach(() => {
    coarse(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is still centred, with no keyboard geometry', () => {
    render(
      <ResponsiveDialogFrame open size="auto" onOpenChange={() => undefined}>
        <ResponsiveDialogTitle>Действия</ResponsiveDialogTitle>
        <ResponsiveDialogBody>
          <span data-testid="surface">содержимое</span>
        </ResponsiveDialogBody>
      </ResponsiveDialogFrame>,
    );
    const classes = surface().className;
    expect(classes).not.toContain('bottom-above-keyboard');
    expect(classes).not.toContain('--viewport-keyboard');
  });
});
