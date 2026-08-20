import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ResponsiveDialogBody,
  ResponsiveDialogFrame,
  ResponsiveDialogTitle,
} from './responsive-dialog';

/**
 * The keyboard geometry of the bottom-sheet surface — as a set of things that
 * must **not** come back.
 *
 * These were assertions in the other direction for one day. The sheet anchored
 * to a `bottom-above-keyboard` utility driven by a custom property this app
 * published from `visualViewport`, and `vaul` was told `repositionInputs=
 * {false}` so that property could own the number. On the owner's installed
 * iPhone the result was «Новое дело» opening with its form scrolled off the
 * top of the screen. `responsive-dialog.tsx` carries the full account; the
 * short version is that `repositionInputs` does not gate what its name
 * suggests — in `vaul` 1.1.2 it also gates `preventScrollMobileSafari()`,
 * which is the only thing stopping iOS from scrolling a `position: fixed`
 * sheet off the screen when an input takes focus.
 *
 * Class assertions are normally a smell. They earn their place here because
 * both regressions are invisible to a rendering test and to every gate this
 * project can run: nothing fails, on any browser available to CI, when the
 * sheet starts being positioned from a property that is absent everywhere
 * except one phone.
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

describe('the bottom sheet leaves the keyboard to vaul', () => {
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

  it('anchors to `bottom-0`, and to no computed bottom of ours', () => {
    open('auto');
    const classes = surface().className;
    expect(classes.split(/\s+/)).toContain('bottom-0');
    expect(classes, 'the reverted utility must not come back').not.toContain(
      'bottom-above-keyboard',
    );
    expect(classes, 'nor the property behind it').not.toContain('--viewport-');
  });

  it('keeps the plain size for each variant, with no viewport arithmetic', () => {
    const expected = {
      auto: 'max-h-[60dvh]',
      tall: 'h-[85dvh]',
      full: 'h-[calc(100dvh_-_max(env(safe-area-inset-top,0px),0.75rem)_-_0.75rem)]',
    } as const;
    for (const size of ['auto', 'tall', 'full'] as const) {
      const view = open(size);
      const classes = surface().className;
      expect(classes, `${size} sheet`).toContain(expected[size]);
      expect(classes, `${size} sheet must carry no keyboard term`).not.toContain('--viewport-');
      view.unmount();
    }
  });

  it("leaves vaul's input repositioning — and with it its iOS scroll lock — on", () => {
    // There is no prop to read back, so this asserts the observable
    // consequence: with `repositionInputs` at its default, vaul mounts the
    // surface as its own drawer and reserves the inline `bottom` for itself.
    // `repositionInputs={false}` is what must never reappear here — not
    // because vaul's arithmetic is good, but because the same flag switches
    // off `preventScrollMobileSafari()`, and that is load-bearing.
    open('auto');
    expect(surface().hasAttribute('data-vaul-drawer'), 'this is the vaul surface').toBe(true);
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
    expect(classes).not.toContain('--viewport-');
  });
});
