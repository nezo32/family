import { registerSW } from 'virtual:pwa-register';
import { toast } from 'sonner';
import {
  noteServiceWorkerRegistration,
  primeRegistration,
  recordRegistrationError,
} from '@/features/settings/push/push';

/**
 * Service-worker registration.
 *
 * `injectRegister: null` in `vite.config.ts` means the plugin does not inject
 * any registration code — we do it here so the update prompt is ours, in
 * Russian, and so it never interrupts the user mid-edit.
 *
 * `registerType: 'prompt'` is deliberate: an installed PWA that swaps its
 * assets from under a half-filled form loses the user's work. We ask.
 */
export function registerServiceWorker(): void {
  if (import.meta.env.SSR) return;

  // Start resolving the registration at boot, outside any gesture. Push cannot
  // await this inside a click handler — the tap carries five seconds of
  // transient activation and a cold `ready` can outlast it.
  void primeRegistration();

  const updateSW = registerSW({
    immediate: true,

    onNeedRefresh() {
      toast('Доступна новая версия', {
        description: 'Обновите приложение, чтобы получить последние изменения.',
        duration: Infinity,
        action: {
          label: 'Обновить',
          onClick: () => {
            void updateSW(true);
          },
        },
        cancel: { label: 'Позже', onClick: () => undefined },
      });
    },

    onOfflineReady() {
      toast.success('Приложение готово к работе офлайн');
    },

    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      // The earliest moment a push subscription has something to be attempted
      // against. This callback fires as soon as `register()` resolves — before
      // the worker activates, and long before `navigator.serviceWorker.ready`
      // settles on a cold first install. Handing the registration over here is
      // what lets a tap reach `pushManager.subscribe()` and collect WebKit's
      // own `InvalidStateError` instead of a refusal we invented.
      noteServiceWorkerRegistration(registration);

      // iOS keeps a PWA alive for days; without a periodic check a user who
      // never fully closes the app would run a month-old build.
      const HOURLY = 60 * 60 * 1000;
      setInterval(() => {
        if (navigator.onLine) void registration.update();
      }, HOURLY);
    },

    onRegisterError(error) {
      console.error('[pwa] service worker registration failed', error);
      // Without this the failure is invisible to the app: `serviceWorker.ready`
      // simply never settles, and every push surface reports "still starting"
      // for ever. Recorded so «Диагностика уведомлений» can name it.
      recordRegistrationError(error);
    },
  });
}
