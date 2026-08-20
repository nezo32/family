import { useEffect, useRef } from 'react';

/**
 * **Exactly one media element plays at a time, app-wide** (§D7.14.5).
 *
 * Without this, scrolling past a playing clip leaves sound coming out of a card
 * nobody can see — which on a phone, in a house, is genuinely alarming. It is
 * also the reason the rule is app-wide and not per-card: two cards are the
 * common case and the reader has no way to find the one that is talking.
 *
 * A module-level variable rather than context, for the same reason
 * `hooks.ts` keeps `selfWrite` as one: the elements that need to agree are in
 * unrelated subtrees with no common owner but the page, and one variable set
 * immediately before `play()` is easier to verify than a provider threaded
 * through the feed, the head, the thread and the viewer.
 *
 * Nothing here ever *starts* playback. Every `play()` in this feature is on a
 * user gesture, which is both §D7.14.5's rule and — on iOS — not negotiable:
 * `RequiresUserGestureForAudioPlayback` defaults true on `IOS_FAMILY`, and
 * `RequireUserGestureForVideoDueToLowPowerMode` blocks video on a phone in Low
 * Power Mode **with no muted exemption** (`MediaElementSession.cpp`, verified
 * against WebKit `main` 2026-08-21 — the condition tests only `isVideo()` and
 * the gesture state, and never consults `muted`). So a card that autoplayed on
 * one family member's phone would show a still on another's at 18 % battery,
 * with no explanation anybody could give. One rule, everywhere, no conditions.
 */

let current: HTMLMediaElement | null = null;

/** Pause whatever is playing and remember `element` as the one that may. */
export function claimPlayback(element: HTMLMediaElement): void {
  if (current && current !== element) current.pause();
  current = element;
}

export function releasePlayback(element: HTMLMediaElement): void {
  if (current === element) current = null;
}

/** Test seam. Nothing in the app calls this. */
export function stopAllPlayback(): void {
  current?.pause();
  current = null;
}

/**
 * **A playing element pauses when it leaves the viewport.**
 *
 * The automatic half of the rule above: `claimPlayback` handles "somebody
 * started a second one", this handles "the reader scrolled away from the first".
 * `threshold: 0` means it fires when the last pixel goes, not when the element
 * is half gone — a card that pauses while a third of it is still on screen
 * would read as a bug.
 *
 * `IntersectionObserver` is unavailable in jsdom, so the guard is not
 * defensive programming: it is what lets a card render in a unit test.
 */
export function usePauseOffscreen(ref: React.RefObject<HTMLMediaElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (!record.isIntersecting && !element.paused) element.pause();
        }
      },
      { threshold: 0 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
}

/**
 * Registers an element with the single-player rule for its whole lifetime.
 *
 * Returns the ref to hang on the element. Unmounting releases the claim, so a
 * card scrolled out of an unvirtualised list — or a thread that closed — cannot
 * leave a dangling reference to a detached element that the next `play()` would
 * then call `pause()` on.
 */
export function useExclusivePlayback<T extends HTMLMediaElement>(): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const element = ref.current;
    return () => {
      if (element) releasePlayback(element);
    };
  }, []);

  return ref;
}
