import { useEffect } from 'react';

/**
 * Where the bottom of the screen actually is, in JavaScript, because on iOS
 * neither `bottom: 0` nor `100dvh` can be trusted once the software keyboard
 * has been up.
 *
 * ## The two defects this measures around
 *
 * Reported from the owner's installed app on iOS 26.6: «после открытия
 * клавиатуры мобильной — снизу появляется отступ». A band of empty background
 * appears between the bottom edge of a bottom sheet — and of the tab bar — and
 * the bottom of the display, and it stays.
 *
 * **1. The keyboard overlays the page instead of shrinking it.** WebKit
 * implements only `interactive-widget=resizes-visual`: the *visual* viewport
 * shrinks and scrolls, the *layout* viewport does not move, so `position:
 * fixed; bottom: 0` puts a sheet behind the keyboard rather than above it. The
 * spec's opt-out — `interactive-widget=resizes-content` in the viewport meta —
 * is not available: WebKit only enabled the flag in trunk on 2026-08-13
 * (`MetaViewportInteractiveWidgetEnabled`, true on PLATFORM(COCOA)), so no
 * shipping Safari has it and the key is discarded with a console warning. See
 * `index.html`.
 *
 * `--viewport-keyboard` is how much of the layout viewport's bottom the
 * keyboard is covering, **including `visualViewport.offsetTop`**. That term is
 * the whole point. `vaul` does the same repositioning for its drawers with
 * `innerHeight - visualViewport.height` and no `offsetTop`, and only on
 * `resize` — never on `scroll`. iOS scrolls the visual viewport to reveal a
 * focused input, so `offsetTop` becomes tens of pixels and never changes back
 * for as long as the sheet is open, and `vaul` lifts the sheet by that much too
 * far. That is a band of empty background under a bottom sheet, which is the
 * photograph that came with the report. `ResponsiveDialogFrame` therefore
 * passes `repositionInputs={false}` and uses this instead.
 *
 * **2. The layout viewport is left short.** Separately, and only in an
 * installed app, WebKit can come back from the keyboard with the layout
 * viewport shorter than the window and never restore it — Apple 158055568, "a
 * bottom gap appearing on layouts with viewport-sized fixed containers", noted
 * as fixed in Safari 26.1 and still reported on 26.x. Then `bottom: 0` is above
 * the physical bottom of the display with nothing painted underneath.
 * `--viewport-shortfall` is the height of that band.
 *
 * ## Why both are safe to ship untested on the device
 *
 * Both properties are **absent** unless the page is in one of those two states,
 * and both are removed — not zeroed — the instant it leaves. On every browser
 * that behaves, `calc()` falls through to the `0px` default and the computed
 * geometry is bit-for-bit what it was before this module existed; that was
 * measured at 320, iPhone 15 and 1440 in both themes, and `keyboard-viewport.
 * spec.ts` keeps measuring it.
 *
 * The shortfall carries three further guards, because it is the one that could
 * push chrome *off* the screen if it fired wrongly:
 *
 * 1. **Standalone only.** In a browser tab the URL bar legitimately grows and
 *    shrinks `innerHeight` by 50–90px on every scroll. Installed, there is no
 *    URL bar, so a drop is the defect.
 * 2. **Never while typing, and never while the keyboard is overlaying.** Both
 *    of those shrink a viewport for real and legitimately.
 * 3. **Dead-banded and clamped**, and only applied after it has held for
 *    `SETTLE_MS` — the keyboard animates out over ~250ms and `focusout` fires
 *    at the start of that.
 */

/** How much of the layout viewport's bottom the keyboard is covering. */
export const KEYBOARD_PROPERTY = '--viewport-keyboard';

/** How far the bottom of the layout viewport is above the bottom of the screen. */
export const SHORTFALL_PROPERTY = '--viewport-shortfall';

/** Under this it is sub-pixel rounding or a scrollbar, not a stale viewport. */
export const MIN_SHORTFALL_PX = 8;

/**
 * Over this, whatever shrank the viewport was not a keyboard artefact — and a
 * correction this large would throw the chrome off the screen rather than onto
 * it. The reported residue is tens of pixels.
 */
export const MAX_SHORTFALL_PX = 240;

/** How long a shortfall must hold before it is applied. Zero applies at once. */
export const SETTLE_MS = 400;

export interface ViewportSample {
  innerWidth: number;
  innerHeight: number;
  /** `visualViewport.height`, or `innerHeight` where there is none. */
  visualHeight: number;
  /** `visualViewport.offsetTop` — how far the visual viewport has been scrolled. */
  visualOffsetTop: number;
  /** A text-entry control has focus, so a keyboard is up or on its way out. */
  typing: boolean;
}

export interface InsetState {
  /** Width the peak was observed at; a change means a rotation, not a defect. */
  width: number;
  /** Tallest layout viewport seen at that width. */
  peak: number;
}

export interface Insets {
  keyboard: number;
  shortfall: number;
}

export function initialState(sample: ViewportSample): InsetState {
  return { width: sample.innerWidth, peak: sample.innerHeight };
}

/**
 * How much of the layout viewport's bottom edge is not visible.
 *
 * `innerHeight - (visualViewport.height + visualViewport.offsetTop)`. The
 * `offsetTop` term is what `vaul` omits; without it the answer is the keyboard
 * height plus however far iOS has scrolled the visual viewport, which is too
 * much by exactly the band that was photographed.
 */
export function keyboardInset(sample: ViewportSample): number {
  return Math.max(
    0,
    Math.round(sample.innerHeight - (sample.visualHeight + sample.visualOffsetTop)),
  );
}

/**
 * The whole decision, as a pure function so it can be tested without a browser.
 *
 * `standalone` gates only the shortfall: the keyboard inset is a plain
 * measurement that is correct in a tab as well.
 */
export function nextInsets(
  state: InsetState,
  sample: ViewportSample,
  standalone: boolean,
): { state: InsetState; insets: Insets } {
  const keyboard = keyboardInset(sample);

  // A rotation (or a desktop window resize) changes what "full height" means.
  // Carrying the old peak across it would report the whole difference as a
  // defect, so the baseline restarts.
  if (sample.innerWidth !== state.width) {
    return { state: initialState(sample), insets: { keyboard, shortfall: 0 } };
  }

  const peak = Math.max(state.peak, sample.innerHeight);
  const carried: InsetState = { width: state.width, peak };
  const quiet: Insets = { keyboard, shortfall: 0 };

  if (!standalone) return { state: carried, insets: quiet };
  // A keyboard that is *currently* shrinking something is not this defect,
  // whichever of the two viewports it shrinks.
  if (sample.typing || keyboard > 0) return { state: carried, insets: quiet };

  const deficit = Math.round(peak - sample.innerHeight);
  if (deficit < MIN_SHORTFALL_PX || deficit > MAX_SHORTFALL_PX) {
    return { state: carried, insets: quiet };
  }
  return { state: carried, insets: { keyboard, shortfall: deficit } };
}

/** `<input type=text>`, `<textarea>`, and anything `contenteditable`. */
export function isTextEntry(element: Element | null): boolean {
  if (element === null) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  // `button`, `checkbox`, `radio`, `range`, `color`, `submit` open no keyboard.
  return !['button', 'checkbox', 'color', 'radio', 'range', 'reset', 'submit'].includes(
    element.type,
  );
}

function read(): ViewportSample {
  const visual = window.visualViewport;
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    visualHeight: visual?.height ?? window.innerHeight,
    visualOffsetTop: visual?.offsetTop ?? 0,
    typing: isTextEntry(document.activeElement),
  };
}

/**
 * Installs the watcher. Returns a teardown that removes every listener **and**
 * both custom properties, so unmounting leaves no trace either.
 *
 * Exported separately from the hook so a test can drive it without React.
 */
export function installViewportInsets(): () => void {
  const visual = window.visualViewport;
  // Without `visualViewport` there is nothing to measure and nothing to fix.
  if (!visual) return () => undefined;

  const standalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;

  const root = document.documentElement;
  let state = initialState(read());
  const applied: Insets = { keyboard: 0, shortfall: 0 };
  let timer: number | undefined;

  const write = (property: string, key: keyof Insets, value: number): void => {
    if (applied[key] === value) return;
    applied[key] = value;
    if (value === 0) root.style.removeProperty(property);
    else root.style.setProperty(property, `${String(value)}px`);
  };

  const update = (): void => {
    const result = nextInsets(state, read(), standalone);
    state = result.state;
    write(KEYBOARD_PROPERTY, 'keyboard', result.insets.keyboard);

    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    if (result.insets.shortfall === 0) {
      write(SHORTFALL_PROPERTY, 'shortfall', 0);
      return;
    }
    // Non-zero waits for the viewport to settle; see SETTLE_MS.
    timer = window.setTimeout(() => {
      timer = undefined;
      const settled = nextInsets(state, read(), standalone);
      state = settled.state;
      write(KEYBOARD_PROPERTY, 'keyboard', settled.insets.keyboard);
      write(SHORTFALL_PROPERTY, 'shortfall', settled.insets.shortfall);
    }, SETTLE_MS);
  };

  // `scroll` as well as `resize`: iOS scrolls the visual viewport to reveal a
  // focused input without resizing it again, and a listener that only watches
  // `resize` is left holding the offset the keyboard arrived with. That is the
  // omission in `vaul` that this replaces.
  visual.addEventListener('resize', update);
  visual.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  window.addEventListener('focusin', update);
  window.addEventListener('focusout', update);
  window.addEventListener('pageshow', update);

  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    visual.removeEventListener('resize', update);
    visual.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
    window.removeEventListener('focusin', update);
    window.removeEventListener('focusout', update);
    window.removeEventListener('pageshow', update);
    root.style.removeProperty(KEYBOARD_PROPERTY);
    root.style.removeProperty(SHORTFALL_PROPERTY);
  };
}

/** Mounted once, by `AppShell`. */
export function useViewportInsets(): void {
  useEffect(() => installViewportInsets(), []);
}
