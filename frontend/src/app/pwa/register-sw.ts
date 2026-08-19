import { registerSW } from 'virtual:pwa-register';
import { toast } from 'sonner';

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
      // iOS keeps a PWA alive for days; without a periodic check a user who
      // never fully closes the app would run a month-old build.
      const HOURLY = 60 * 60 * 1000;
      setInterval(() => {
        if (navigator.onLine) void registration.update();
      }, HOURLY);
    },

    onRegisterError(error) {
      console.error('[pwa] service worker registration failed', error);
    },
  });
}
