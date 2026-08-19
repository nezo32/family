import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { settingsKeys } from '../api';
import {
  disablePush,
  enablePush,
  installReconcileLoop,
  isIos,
  isIosNonSafari,
  isStandalone,
  permissionState,
  primeRegistration,
  pushAvailability,
  VAPID_PUBLIC_KEY,
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
 * 1. **The registration is primed on mount**, so the click handler never has to
 *    `await navigator.serviceWorker.ready` and never spends the user-activation
 *    token before `Notification.requestPermission()`.
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
   * Turn push on. **Call this directly from `onClick`** — it is not `async` and
   * it fires `Notification.requestPermission()` synchronously.
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

  // Prime the SW registration well before any button is pressed. Awaiting
  // `serviceWorker.ready` inside the click handler would cost us the gesture.
  useEffect(() => {
    void primeRegistration();
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
  }, []);

  const enable = useCallback((): Promise<EnableResult> => {
    setBusy(true);
    // No await before this call — `enablePush` is synchronous up to and
    // including `Notification.requestPermission()`.
    return enablePush()
      .then((result) => {
        if (mounted.current) {
          setPermission(permissionState());
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
    misconfigured: availability === 'available' && VAPID_PUBLIC_KEY.length === 0,
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
