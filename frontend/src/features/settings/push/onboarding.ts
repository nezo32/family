/**
 * When — if ever — to suggest notifications on our own initiative.
 *
 * `docs/research/ios-pwa-push.md` §13 is the specification, and the whole shape
 * of this file follows from one sentence in it: **the OS prompt can be shown
 * once, ever.** If the user taps «Не разрешать» there, `Notification.permission`
 * is permanently `'denied'` and the only way back is Настройки → Уведомления →
 * Семья, which no family member will find on their own.
 *
 * So nothing here ever reaches `pushManager.subscribe()`. This module
 * only decides whether we may show *our* card — the retryable one — and the
 * card only opens *our* dialog, and only that dialog's button spends the one
 * irreversible tap.
 *
 * The funnel, in order:
 *
 *  1. Never on first paint, and never to a signed-out visitor.
 *  2. Never in a browser where push cannot work at all. On iOS outside the
 *     installed app `window.Notification` is `undefined`, so the answer there is
 *     the *install* card, not this one — `pushAvailability()` reports
 *     `needs-install` and this module stands down.
 *  3. Never again after the OS prompt has been answered, either way.
 *  4. A dismissal is honoured for two weeks, and we ask at most three times
 *     across the life of the install. A suggestion that keeps coming back is
 *     indistinguishable from a bug.
 */

import { permissionState, pushAvailability } from './push';

export const PUSH_PROMPT_DISMISSED_KEY = 'family.push.promptDismissedAt';
export const PUSH_PROMPT_SHOWN_KEY = 'family.push.promptCount';

/** How long a «Не сейчас» is respected before the card may come back. */
export const PUSH_PROMPT_REOFFER_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** Total number of times we will ever raise this by ourselves. */
export const PUSH_PROMPT_MAX_OFFERS = 3;

/**
 * How many recorded engagements are required before we may ask.
 *
 * Two, not one, and the difference is the whole of §13 step 2 → step 4. Signing
 * in records the first (`features/auth/hooks.ts`); every successful write
 * records another (`app/providers.tsx`). So the threshold reads literally as
 * "signed in **and** done something real", which is the earliest moment at
 * which a notification offer is about something the user can picture — and the
 * OS prompt behind it is the one tap in this app that cannot be taken back.
 */
export const PUSH_PROMPT_ENGAGEMENT_THRESHOLD = 2;

/**
 * `localStorage` and not the server: this is a UI preference ("не показывай мне
 * это две недели"), not a credential, so D3 has nothing to say about it. Losing
 * it to iOS's 7-day cap on script-writable storage costs the user one extra
 * dismissal and nothing else.
 */
function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode: we will simply offer again next session.
  }
}

export function pushPromptOfferCount(): number {
  const raw = readLocal(PUSH_PROMPT_SHOWN_KEY);
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Call once when the card actually becomes visible, not when it is considered. */
export function recordPushPromptOffered(): number {
  const next = pushPromptOfferCount() + 1;
  writeLocal(PUSH_PROMPT_SHOWN_KEY, String(next));
  return next;
}

export function dismissPushPrompt(now: number = Date.now()): void {
  writeLocal(PUSH_PROMPT_DISMISSED_KEY, String(now));
}

/** True while a previous «Не сейчас» is still being honoured. */
export function isPushPromptDismissed(now: number = Date.now()): boolean {
  const raw = readLocal(PUSH_PROMPT_DISMISSED_KEY);
  if (raw === null) return false;
  const at = Number.parseInt(raw, 10);
  if (!Number.isFinite(at)) return false;
  return now - at < PUSH_PROMPT_REOFFER_AFTER_MS;
}

export interface ShouldOfferPushOptions {
  /** The caller knows a session exists and the user has done something real. */
  engaged: boolean;
  now?: number;
}

/**
 * The whole condition in one place.
 *
 * Deliberately conservative: when in doubt, stay quiet. A prompt at the wrong
 * moment costs the family notifications permanently, and there is no second
 * chance to get it right.
 */
export function shouldOfferPushPrompt(options: ShouldOfferPushOptions): boolean {
  if (!options.engaged) return false;
  // iOS in a Safari tab lands on `needs-install`: push cannot work until the app
  // is on the Home Screen, so the install card is the honest answer there.
  if (pushAvailability() !== 'available') return false;
  // `granted` — already on. `denied` — the one tap is spent and only iOS
  // Settings can undo it; repeating ourselves would just be noise.
  if (permissionState() !== 'default') return false;
  if (isPushPromptDismissed(options.now ?? Date.now())) return false;
  return pushPromptOfferCount() < PUSH_PROMPT_MAX_OFFERS;
}
