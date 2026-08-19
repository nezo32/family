/**
 * Install-funnel detection and state.
 *
 * Why this file is bigger than "check the UA": on iOS the install step is not a
 * nicety, it is a hard gate. `window.Notification` is **`undefined`** in a
 * normal Safari tab, so nothing about reminders works until the app sits on the
 * Home Screen (`docs/research/ios-pwa-push.md` §1). At the same time iOS gives
 * us no `beforeinstallprompt`, no banner and no way to open the share sheet from
 * JS — the only tool we have is a well-timed set of instructions.
 *
 * Hence the rules encoded here (research §13):
 *
 *  - never on first load — the prompt waits for a signed-in user who has
 *    already done something real (`recordEngagement()`);
 *  - never when already installed — `display-mode: standalone` or the legacy
 *    `navigator.standalone`;
 *  - a dismissal is remembered for ~14 days, then we may ask once more;
 *  - iPadOS has reported the UA string `Macintosh` since iPadOS 13, so touch
 *    points are part of the detection;
 *  - Chrome / Firefox / Yandex / DuckDuckGo on iOS **cannot** add to the Home
 *    Screen at all: they get "open this in Safari", not the share-sheet steps.
 */

/* -------------------------------------------------------------------------- */
/* storage keys and timings                                                    */
/* -------------------------------------------------------------------------- */

export const INSTALL_DISMISSED_KEY = 'family.install.dismissedAt';
export const INSTALL_ENGAGEMENT_KEY = 'family.install.engagement';

/** How long a "Позже" is respected before the card may come back. */
export const INSTALL_REOFFER_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** Meaningful actions required before the card is allowed to appear at all. */
export const INSTALL_ENGAGEMENT_THRESHOLD = 1;

/**
 * `localStorage` is deliberate here and does not contradict D3: this is a UI
 * preference ("не показывай мне это две недели"), not a credential. Losing it to
 * iOS's 7-day script-writable storage cap costs the user one extra dismissal.
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
    // Private mode: the prompt will simply be offered again next session.
  }
}

/* -------------------------------------------------------------------------- */
/* platform detection                                                          */
/* -------------------------------------------------------------------------- */

function userAgent(): string {
  if (typeof navigator === 'undefined') return '';
  return navigator.userAgent;
}

function touchPoints(): number {
  if (typeof navigator === 'undefined') return 0;
  return navigator.maxTouchPoints;
}

/** Safari's pre-standard flag, still the only signal on older iOS. */
interface LegacyStandaloneNavigator {
  standalone?: boolean;
}

/** True when the app is running as an installed PWA (any platform). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const media = window.matchMedia?.('(display-mode: standalone)');
  if (media?.matches) return true;
  if (window.matchMedia?.('(display-mode: fullscreen)')?.matches) return true;
  const legacy = navigator as unknown as LegacyStandaloneNavigator;
  return legacy.standalone === true;
}

/**
 * iOS **or** iPadOS. The second half of the test is not optional: since
 * iPadOS 13 an iPad reports `Macintosh` in its UA and is otherwise
 * indistinguishable from a desktop Mac — except that a Mac has no touch points.
 */
export function isIOS(): boolean {
  const ua = userAgent();
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return ua.includes('Macintosh') && touchPoints() > 1;
}

/** iPad specifically — its share button lives in the *top* toolbar. */
export function isIPad(): boolean {
  const ua = userAgent();
  if (/iPad/.test(ua)) return true;
  return ua.includes('Macintosh') && touchPoints() > 1;
}

/**
 * Real Safari on iOS, as opposed to Chrome / Firefox / Edge / Opera / Yandex /
 * DuckDuckGo, all of which render with WebKit but ship their own UI and have no
 * "На экран «Домой»" item. Telling those users to look for a share sheet that
 * cannot install anything is the most confusing thing this screen could do.
 */
export function isIOSSafari(): boolean {
  if (!isIOS()) return false;
  const ua = userAgent();
  const otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|Yowser|DuckDuckGo|Brave|SamsungBrowser|GSA/i;
  if (otherBrowser.test(ua)) return false;
  // In-app web views (Telegram, VK, Instagram) drop the `Safari` token.
  return /Safari/.test(ua);
}

export type InstallPlatform =
  /** Already installed — say nothing, ever. */
  | 'standalone'
  /** iPhone/iPad in Safari: show the share-sheet instructions. */
  | 'ios-safari'
  /** iPhone/iPad in another browser: tell them to open Safari. */
  | 'ios-other-browser'
  /** Chromium desktop/Android: a real `beforeinstallprompt` button. */
  | 'chromium'
  /** Anything else (desktop Firefox/Safari): generic hint, low priority. */
  | 'other';

export function detectInstallPlatform(): InstallPlatform {
  if (isStandalone()) return 'standalone';
  if (isIOS()) return isIOSSafari() ? 'ios-safari' : 'ios-other-browser';
  if (deferredPrompt !== null) return 'chromium';
  return 'other';
}

/* -------------------------------------------------------------------------- */
/* beforeinstallprompt (Chromium only)                                         */
/* -------------------------------------------------------------------------- */

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt: () => Promise<void>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const promptListeners = new Set<(event: BeforeInstallPromptEvent | null) => void>();

function setDeferredPrompt(event: BeforeInstallPromptEvent | null): void {
  deferredPrompt = event;
  for (const listener of promptListeners) listener(event);
}

/**
 * Chromium fires `beforeinstallprompt` early — usually well before the user has
 * signed in, and therefore long before our card is allowed to appear. Capturing
 * it at module scope keeps the event alive so the button still works minutes
 * later; the browser only lets us call `prompt()` once per event, so it is
 * dropped after use.
 */
function captureBeforeInstallPrompt(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (event: Event) => {
    // Suppress Chrome's own mini-infobar; we ask at our own, better moment.
    event.preventDefault();
    setDeferredPrompt(event as BeforeInstallPromptEvent);
  });
  window.addEventListener('appinstalled', () => {
    setDeferredPrompt(null);
    dismissInstallPrompt();
  });
}

captureBeforeInstallPrompt();

export function getDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

export function onDeferredInstallPromptChange(
  listener: (event: BeforeInstallPromptEvent | null) => void,
): () => void {
  promptListeners.add(listener);
  return () => {
    promptListeners.delete(listener);
  };
}

export type InstallPromptResult = 'accepted' | 'dismissed' | 'unavailable';

/** Fire the real Chromium install prompt. Must be called from a user gesture. */
export async function promptInstall(): Promise<InstallPromptResult> {
  const event = deferredPrompt;
  if (!event) return 'unavailable';
  await event.prompt();
  const choice = await event.userChoice;
  // The event is single-use, whatever the outcome.
  setDeferredPrompt(null);
  return choice.outcome;
}

/* -------------------------------------------------------------------------- */
/* engagement + dismissal                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Call this when the user completes a *real* action (created a task, ticked
 * something off, added an item). It is the gate that keeps the install card off
 * the first screen a new member ever sees.
 */
export function recordEngagement(): number {
  const next = engagementCount() + 1;
  writeLocal(INSTALL_ENGAGEMENT_KEY, String(next));
  return next;
}

export function engagementCount(): number {
  const raw = readLocal(INSTALL_ENGAGEMENT_KEY);
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function dismissInstallPrompt(now: number = Date.now()): void {
  writeLocal(INSTALL_DISMISSED_KEY, String(now));
}

/** True while a previous "Позже" is still being honoured. */
export function isInstallPromptDismissed(now: number = Date.now()): boolean {
  const raw = readLocal(INSTALL_DISMISSED_KEY);
  if (raw === null) return false;
  const at = Number.parseInt(raw, 10);
  if (!Number.isFinite(at)) return false;
  return now - at < INSTALL_REOFFER_AFTER_MS;
}

export interface ShouldOfferOptions {
  /** Override the engagement gate (the caller already knows the user acted). */
  engaged?: boolean;
  now?: number;
}

/**
 * The whole funnel condition in one place.
 *
 * Deliberately conservative: when in doubt, do not ask. An install card shown at
 * the wrong moment is dismissed forever; one shown after the user has already
 * got value out of the app is the difference between push working and not.
 */
export function shouldOfferInstall(options: ShouldOfferOptions = {}): boolean {
  const now = options.now ?? Date.now();
  const platform = detectInstallPlatform();
  if (platform === 'standalone') return false;
  if (isInstallPromptDismissed(now)) return false;

  const engaged = options.engaged ?? engagementCount() >= INSTALL_ENGAGEMENT_THRESHOLD;
  if (!engaged) return false;

  // Desktop browsers without an install hook have nothing useful to show.
  return platform !== 'other';
}
