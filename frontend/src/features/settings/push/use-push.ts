import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { settingsKeys } from '../api';
import {
  disablePush,
  enablePush,
  installReconcileLoop,
  isIos,
  isIosNonSafari,
  isPushReady,
  isStandalone,
  lastEnableOutcome,
  onPushReadinessChange,
  permissionState,
  primeRegistration,
  pushAvailability,
  pushReadiness,
  vapidPublicKey,
  type EnableOutcome,
  type EnableResult,
  type PushAvailability,
  type PushPermission,
  type PushReadiness,
  type ReconcileOutcome,
} from './push';

/**
 * The React face of the push module.
 *
 * It exists to keep three invariants out of component code:
 *
 * 1. **The registration is primed on mount, and priming is preparation rather
 *    than permission.** The click handler must never
 *    `await navigator.serviceWorker.ready` — on a cold start that await can
 *    outlast WebKit's five-second transient-activation window — so the
 *    registration is resolved here, ahead of any tap. It is *not* a gate:
 *    `ready` is a hint the UI may show, never a reason to refuse. The previous
 *    version disabled the enable control until it held, and because
 *    `serviceWorker.ready` stays pending forever when a worker cannot activate,
 *    one household ended up with a button that could never be pressed.
 * 2. **Readiness is subscribed to, not sampled once.** `usePush` re-reads it on
 *    every `onPushReadinessChange` notification — worker state changes, the
 *    registration poll, the VAPID key landing. Sampling it once, at the moment
 *    `primeRegistration()` resolved, is how a key that arrived 150 ms later
 *    pinned the control off for the whole session.
 * 3. **The reconcile loop runs for as long as any push UI is mounted.** iOS
 *    never fires `pushsubscriptionchange`, so re-POSTing `getSubscription()` on
 *    every `visibilitychange -> visible` is the only repair path there is.
 */

export interface PushState {
  availability: PushAvailability;
  permission: PushPermission;
  standalone: boolean;
  ios: boolean;
  /** iOS Chrome/Firefox/Yandex: cannot add to Home Screen at all. */
  iosNonSafari: boolean;
  /** The build shipped without `VITE_VAPID_PUBLIC_KEY`; subscribing can't work. */
  misconfigured: boolean;
  /**
   * A tap would succeed right now: the service worker is **active** and a key
   * is available.
   *
   * Use it to *describe* the state, never to disable the control. A tap made
   * while this is false produces WebKit's own error, which is diagnosable; a
   * tap we refuse produces nothing anybody can act on.
   */
  ready: boolean;
  /** Where the worker itself has got to, ignoring the VAPID key. */
  readiness: PushReadiness;
  /**
   * The worker has had {@link PUSH_STARTUP_GRACE_MS} and still has no active
   * version. Not "wait a bit longer" — something is wrong, and the honest next
   * step is «Диагностика уведомлений», not another restart of the app.
   */
  stalled: boolean;
  /** How the last enable attempt ended, this session. `null` before the first. */
  lastOutcome: EnableOutcome | null;
  /**
   * iOS accepted the tap, never showed a prompt, and still reports
   * `permission: 'default'` — WebKit bug 320551. The user has notifications
   * switched off for this app in iOS Settings and only Settings can undo it.
   * Do **not** re-offer the soft pre-prompt in this state; it loops forever.
   */
  blockedInSettings: boolean;
  /** Outcome of the last reconcile pass. `null` until the first one lands. */
  reconcile: ReconcileOutcome | null;
  /**
   * Permission is granted but the browser holds no subscription — the state that
   * renders «Уведомления отключились — включить снова?». Only a fresh user
   * gesture can fix it.
   */
  needsReEnable: boolean;
  /** True when this device is subscribed as far as the browser is concerned. */
  isEnabled: boolean;
  busy: boolean;
}

export interface UsePushResult extends PushState {
  /**
   * Turn push on. **Call this directly from `onClick`** — it is not `async`
   * and it reaches `pushManager.subscribe()`, the one call allowed to consume
   * the tap's transient activation, before it returns.
   *
   * Callable whatever {@link PushState.ready} says. It is allowed to fail; it
   * is not allowed to be unreachable.
   */
  enable: () => Promise<EnableResult>;
  disable: () => Promise<boolean>;
  /** Re-read the permission after the user changed it in OS settings. */
  refresh: () => void;
}

export function usePush(): UsePushResult {
  const queryClient = useQueryClient();
  const [permission, setPermission] = useState<PushPermission>(() => permissionState());
  const [reconcile, setReconcile] = useState<ReconcileOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(() => isPushReady());
  const [readiness, setReadiness] = useState<PushReadiness>(() => pushReadiness());
  const [lastOutcome, setLastOutcome] = useState<EnableOutcome | null>(() => lastEnableOutcome());
  const mounted = useRef(true);

  const availability = useMemo(() => pushAvailability(), []);
  const standalone = useMemo(() => isStandalone(), []);
  const ios = useMemo(() => isIos(), []);
  const iosNonSafari = useMemo(() => isIosNonSafari(), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Prime the SW registration well before any button is pressed, and then
  // *keep listening*.
  //
  // Priming is what lets the click handler reach `pushManager.subscribe()`
  // synchronously: awaiting `serviceWorker.ready` inside the tap can outlast
  // WebKit's five-second transient-activation window on a cold start. The
  // subscription to `onPushReadinessChange` is what stops the result being a
  // latch — the worker can activate, or the VAPID key can land, at any point
  // after `primeRegistration()` settles, and both have to reach the UI.
  useEffect(() => {
    const publish = () => {
      if (!mounted.current) return;
      setReady(isPushReady());
      setReadiness(pushReadiness());
    };
    const unsubscribe = onPushReadinessChange(publish);
    void primeRegistration().then(publish);
    publish();
    return unsubscribe;
  }, []);

  // The foreground repair loop (research doc §2). Also refreshes `lastSeenAt`
  // server-side on every resume, for free.
  useEffect(() => {
    return installReconcileLoop((outcome) => {
      if (!mounted.current) return;
      setReconcile(outcome);
      setPermission(permissionState());
      if (outcome === 'reposted') {
        void queryClient.invalidateQueries({ queryKey: settingsKeys.subscriptions() });
      }
    });
  }, [queryClient]);

  const refresh = useCallback(() => {
    setPermission(permissionState());
    setReady(isPushReady());
    setReadiness(pushReadiness());
    setLastOutcome(lastEnableOutcome());
  }, []);

  const enable = useCallback((): Promise<EnableResult> => {
    setBusy(true);
    // **No await before this call.** `enablePush` runs synchronously up to and
    // including `pushManager.subscribe()`, which is the one call allowed to
    // consume the tap's transient activation.
    return enablePush()
      .then((result) => {
        if (mounted.current) {
          setPermission(permissionState());
          setLastOutcome(result.outcome);
          if (result.outcome === 'enabled') setReconcile('reposted');
        }
        void queryClient.invalidateQueries({ queryKey: settingsKeys.notifications() });
        return result;
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  }, [queryClient]);

  const disable = useCallback((): Promise<boolean> => {
    setBusy(true);
    return disablePush()
      .then((ok) => {
        if (mounted.current && ok) setReconcile('missing');
        void queryClient.invalidateQueries({ queryKey: settingsKeys.notifications() });
        return ok;
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  }, [queryClient]);

  const isEnabled = permission === 'granted' && reconcile === 'reposted';

  return {
    availability,
    permission,
    standalone,
    ios,
    iosNonSafari,
    misconfigured: availability === 'available' && vapidPublicKey().length === 0,
    ready,
    readiness,
    stalled: readiness === 'stalled',
    lastOutcome,
    // iOS reports `permission: 'default'` in this state, so nothing else on the
    // device gives it away — only the outcome of a real attempt does.
    blockedInSettings: lastOutcome === 'blocked-in-settings',
    reconcile,
    // `missing` is only meaningful while permission is still granted: the
    // browser agreed to notify us and then quietly dropped the subscription.
    needsReEnable: permission === 'granted' && reconcile === 'missing',
    isEnabled,
    busy,
    enable,
    disable,
    refresh,
  };
}
