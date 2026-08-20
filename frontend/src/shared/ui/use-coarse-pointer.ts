import { useEffect, useState } from 'react';

/**
 * "Is the primary input device a finger?"
 *
 * ## Why `(pointer: coarse)` and not `display-mode: standalone`
 *
 * Every touch affordance in this app — bottom sheets instead of dialogs, row
 * swipes, long-press menus, pull-to-refresh, the 44px minimum target — is an
 * affordance of the *input device*, not a reward for installing the PWA.
 *
 * Gating on `display-mode: standalone` would:
 *
 *  - hide the gestures from whichever family member has not installed yet,
 *    which on the evidence of who installs PWAs is the grandmother — the person
 *    who most needs a large, forgiving swipe target;
 *  - make the whole interaction model untestable in a browser and undebuggable
 *    in devtools;
 *  - claim a phone in Safari has a different thumb from the same phone on the
 *    Home Screen.
 *
 * `display-mode: standalone` is genuinely required only for things that cannot
 * work otherwise — push permission and subscription, the install prompt, and
 * home-indicator-specific chrome. Those stay gated on standalone; this does
 * not. (Design §C-gestures/G2.)
 *
 * ## Why a hook and not a media query
 *
 * The purely visual parts of the same rule belong in CSS
 * (`@media (pointer: coarse)`). This hook exists for the decisions CSS cannot
 * make: which *component* renders — a `Dialog` or a `Drawer`, a `Popover` or a
 * sheet. You cannot express "render a different React tree" in a class list.
 *
 * It is live: a hybrid laptop that gains a touchscreen, a tablet that gets a
 * mouse plugged in, and a devtools device-emulation toggle all re-render.
 */
const COARSE_QUERY = '(pointer: coarse)';

/**
 * Synchronous read, for the initial render and for imperative code (event
 * handlers, one-shot decisions) that has no business subscribing.
 *
 * Falls back to `false` — a fine pointer — when `matchMedia` is unavailable
 * (jsdom without the stub, SSR). Fine-pointer is the safe default: it renders a
 * dialog with a visible close button and a footer, which works with a thumb,
 * whereas defaulting to coarse would render swipe-to-dismiss chrome for a mouse
 * user who has no way to swipe.
 */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(COARSE_QUERY).matches;
}

/** Live `(pointer: coarse)`. See the note above for why it is that query. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(isCoarsePointer);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COARSE_QUERY);
    const update = (): void => {
      setCoarse(query.matches);
    };
    // Re-read on mount: the first render may have happened before `matchMedia`
    // was patched in (tests), or on a server.
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  return coarse;
}
