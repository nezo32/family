import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  KEYBOARD_PROPERTY,
  MAX_SHORTFALL_PX,
  MIN_SHORTFALL_PX,
  SETTLE_MS,
  SHORTFALL_PROPERTY,
  initialState,
  installViewportInsets,
  isTextEntry,
  keyboardInset,
  nextInsets,
  type ViewportSample,
} from './viewport-insets';

/**
 * Two contracts are pinned here.
 *
 * **The keyboard inset includes `visualViewport.offsetTop`.** Leaving it out is
 * `vaul`'s bug — it lifts a sheet by the keyboard height *plus* however far iOS
 * has scrolled the visual viewport, which is a band of empty background under
 * the sheet, which is the defect that was reported. The first describe block
 * exists to stop that term ever being dropped again.
 *
 * **Neither correction may outlive the state it corrects.** Both properties are
 * removed, not zeroed, the moment the viewport is healthy again; a correction
 * left behind is a worse bug than the one it treats, because it moves chrome
 * off a screen that was fine.
 */

const FULL = 852;

function sample(over: Partial<ViewportSample> = {}): ViewportSample {
  return {
    innerWidth: 393,
    innerHeight: FULL,
    visualHeight: FULL,
    visualOffsetTop: 0,
    typing: false,
    ...over,
  };
}

describe('keyboardInset', () => {
  it('is nothing when the visual viewport fills the layout viewport', () => {
    expect(keyboardInset(sample())).toBe(0);
  });

  it('is the height the keyboard covers', () => {
    expect(keyboardInset(sample({ visualHeight: FULL - 336 }))).toBe(336);
  });

  it('subtracts the visual viewport scroll — the term vaul omits', () => {
    // iOS scrolled the visual viewport down by 40px to reveal the focused
    // input. Only 296px of the layout viewport's bottom is still covered.
    // vaul would answer 336 and lift the sheet 40px too far, which is the
    // band of background that was photographed under it.
    expect(keyboardInset(sample({ visualHeight: FULL - 336, visualOffsetTop: 40 }))).toBe(296);
  });

  it('never goes negative', () => {
    expect(keyboardInset(sample({ visualHeight: FULL + 20 }))).toBe(0);
  });
});

describe('nextInsets', () => {
  const state = () => initialState(sample());

  it('reports nothing on a viewport that has never shrunk', () => {
    expect(nextInsets(state(), sample(), true).insets).toEqual({ keyboard: 0, shortfall: 0 });
  });

  it('reports the keyboard inset in a browser tab as well as installed', () => {
    const overlaid = sample({ visualHeight: FULL - 336, typing: true });
    expect(nextInsets(state(), overlaid, false).insets.keyboard).toBe(336);
  });

  it('reports the band once the layout viewport comes back short', () => {
    const short = sample({ innerHeight: FULL - 59, visualHeight: FULL - 59 });
    expect(nextInsets(state(), short, true).insets.shortfall).toBe(59);
  });

  it('goes back to zero the moment the viewport recovers', () => {
    const short = sample({ innerHeight: FULL - 59, visualHeight: FULL - 59 });
    const dropped = nextInsets(state(), short, true);
    expect(dropped.insets.shortfall).toBe(59);
    expect(nextInsets(dropped.state, sample(), true).insets.shortfall).toBe(0);
  });

  it('never reports a shortfall in a browser tab, where the URL bar does that', () => {
    const short = sample({ innerHeight: FULL - 80, visualHeight: FULL - 80 });
    expect(nextInsets(state(), short, false).insets.shortfall).toBe(0);
  });

  it('stays silent while a text control has focus', () => {
    const typing = sample({ innerHeight: FULL - 336, visualHeight: FULL - 336, typing: true });
    expect(nextInsets(state(), typing, true).insets.shortfall).toBe(0);
  });

  it('stays silent while the keyboard overlays the visual viewport instead', () => {
    const overlaid = sample({ visualHeight: FULL - 336 });
    expect(nextInsets(state(), overlaid, true).insets.shortfall).toBe(0);
  });

  it('rebases instead of reporting a shortfall when the device rotates', () => {
    const landscape = sample({ innerWidth: 852, innerHeight: 393, visualHeight: 393 });
    const result = nextInsets(state(), landscape, true);
    expect(result.insets.shortfall).toBe(0);
    expect(result.state).toEqual({ width: 852, peak: 393 });
  });

  it('ignores a difference too small to be the defect', () => {
    const drop = MIN_SHORTFALL_PX - 1;
    const tiny = sample({ innerHeight: FULL - drop, visualHeight: FULL - drop });
    expect(nextInsets(state(), tiny, true).insets.shortfall).toBe(0);
  });

  it('refuses a difference too large to be the defect', () => {
    const drop = MAX_SHORTFALL_PX + 1;
    const huge = sample({ innerHeight: FULL - drop, visualHeight: FULL - drop });
    expect(nextInsets(state(), huge, true).insets.shortfall).toBe(0);
  });

  it('keeps the peak across a shrink so the next sample still sees the band', () => {
    const short = sample({ innerHeight: FULL - 40, visualHeight: FULL - 40 });
    const carried = nextInsets(state(), short, true).state;
    expect(carried.peak).toBe(FULL);
    expect(nextInsets(carried, short, true).insets.shortfall).toBe(40);
  });
});

describe('isTextEntry', () => {
  it('recognises the controls that raise a keyboard and skips the ones that do not', () => {
    const text = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const area = document.createElement('textarea');
    const button = document.createElement('button');

    expect(isTextEntry(text)).toBe(true);
    expect(isTextEntry(area)).toBe(true);
    expect(isTextEntry(checkbox)).toBe(false);
    expect(isTextEntry(button)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('installViewportInsets', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    let teardown = cleanups.pop();
    while (teardown !== undefined) {
      teardown();
      teardown = cleanups.pop();
    }
    const style = document.documentElement.style;
    style.removeProperty(KEYBOARD_PROPERTY);
    style.removeProperty(SHORTFALL_PROPERTY);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** jsdom has no `visualViewport`; this is the minimum the module reads. */
  function stubVisualViewport(): { set: (height: number, offsetTop: number) => void } {
    const listeners = new Set<() => void>();
    const state = { height: FULL, offsetTop: 0 };
    vi.stubGlobal('visualViewport', {
      get height() {
        return state.height;
      },
      get offsetTop() {
        return state.offsetTop;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    });
    return {
      set(height: number, offsetTop: number) {
        state.height = height;
        state.offsetTop = offsetTop;
        for (const fn of listeners) fn();
      },
    };
  }

  function install(standalone: boolean): () => void {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(display-mode: standalone)' ? standalone : false,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    const teardown = installViewportInsets();
    cleanups.push(teardown);
    return teardown;
  }

  function resizeTo(height: number): void {
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
    window.dispatchEvent(new Event('resize'));
  }

  function read(property: string): string {
    return document.documentElement.style.getPropertyValue(property);
  }

  it('publishes the keyboard inset while it is up and removes it afterwards', () => {
    Object.defineProperty(window, 'innerHeight', { value: FULL, configurable: true });
    const visual = stubVisualViewport();
    install(true);

    visual.set(FULL - 336, 40);
    expect(read(KEYBOARD_PROPERTY), 'the offsetTop term is subtracted').toBe('296px');

    visual.set(FULL, 0);
    expect(read(KEYBOARD_PROPERTY)).toBe('');
    expect(document.documentElement.getAttribute('style') ?? '').not.toContain(KEYBOARD_PROPERTY);
  });

  it('does not correct a shortfall in a browser tab', () => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'innerHeight', { value: FULL, configurable: true });
    stubVisualViewport();
    install(false);

    // A URL bar shrinking the viewport is exactly the false positive the
    // standalone gate exists to refuse.
    resizeTo(FULL - 80);
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(read(SHORTFALL_PROPERTY)).toBe('');
  });

  it('publishes the band after it settles, and removes the property when it goes', () => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'innerHeight', { value: FULL, configurable: true });
    const visual = stubVisualViewport();
    install(true);

    visual.set(FULL - 59, 0);
    resizeTo(FULL - 59);
    // Not applied on the first frame: the keyboard is still animating out.
    expect(read(SHORTFALL_PROPERTY)).toBe('');

    vi.advanceTimersByTime(SETTLE_MS);
    expect(read(SHORTFALL_PROPERTY)).toBe('59px');

    visual.set(FULL, 0);
    resizeTo(FULL);
    // Recovery is immediate, and it *removes* the property rather than
    // setting it to zero — nothing is left behind.
    expect(read(SHORTFALL_PROPERTY)).toBe('');
    expect(document.documentElement.getAttribute('style') ?? '').not.toContain(SHORTFALL_PROPERTY);
  });

  it('never applies a shortfall that has already gone by the time it settles', () => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'innerHeight', { value: FULL, configurable: true });
    const visual = stubVisualViewport();
    install(true);

    visual.set(FULL - 59, 0);
    resizeTo(FULL - 59);
    visual.set(FULL, 0);
    Object.defineProperty(window, 'innerHeight', { value: FULL, configurable: true });
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(read(SHORTFALL_PROPERTY)).toBe('');
  });

  it('leaves nothing behind when it is torn down mid-correction', () => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'innerHeight', { value: FULL, configurable: true });
    const visual = stubVisualViewport();
    const teardown = install(true);

    visual.set(FULL - 59, 0);
    resizeTo(FULL - 59);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(read(SHORTFALL_PROPERTY)).toBe('59px');

    teardown();
    expect(read(SHORTFALL_PROPERTY)).toBe('');
    expect(read(KEYBOARD_PROPERTY)).toBe('');

    // And it is genuinely unsubscribed.
    resizeTo(FULL - 59);
    vi.advanceTimersByTime(SETTLE_MS * 2);
    expect(read(SHORTFALL_PROPERTY)).toBe('');
  });

  it('does nothing at all where there is no visualViewport', () => {
    vi.stubGlobal('visualViewport', undefined);
    const teardown = install(true);
    resizeTo(FULL - 59);
    expect(read(SHORTFALL_PROPERTY)).toBe('');
    expect(read(KEYBOARD_PROPERTY)).toBe('');
    teardown();
  });
});
