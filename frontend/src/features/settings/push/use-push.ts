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
  permissionState,
  primeRegistration,
  pushAvailability,
  vapidPublicKey,
  type EnableOutcome,
  type EnableResult,
  type PushAvailability,
  type PushPermission,
  type ReconcileOutcome,
} from './push';

/**
 * The React face of the push module.
 *
 * It exists to keep two invariants out of component code:
 *
 * 1. **The registration is primed on mount and the control waits for it.** The
 *    click handler must never `await navigator.serviceWorker.ready` — on a cold
 *    start that await can outlast WebKit's five-second transient-activation
 *    window — and `subscribe()` throws `InvalidStateError` if the worker is not
 *    yet active. `ready` is the gate; the button stays disabled until it holds.
 * 2. **The reconcile loop runs for as long as any push UI is mounted.** iOS
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
   * A tap could actually succeed right now: the service worker is **active**
   * and a key is available. Gate the enable control on this — `subscribe()`
   * throws `InvalidStateError` against a merely-installing worker, and awaiting
   * readiness inside the tap risks the five-second activation window.
   */
  ready: boolean;
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

  // Prime the SW registration well before any button is pressed.
  //
  // Two separate reasons, and both are load-bearing. `subscribe()` throws
  // `InvalidStateError: Subscribing for push requires an active service worker`
  // if the worker is only installing — the state on the very first launch after
  // an install, which is exactly when somebody first looks for notifications.
  // And awaiting `serviceWorker.ready` *inside* the tap can outlast WebKit's
  // five-second transient-activation window on a cold start. So we resolve it
  // here and keep the button disabled until it lands.
  useEffect(() => {
    void primeRegistration().then(() => {
      if (mounted.current) setReady(isPushReady());
    });
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
