import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAccessToken } from '@/shared/api/token-store';
import { isAcksPendingMessage, isPushNavigateMessage, isTokenRequestMessage } from './messages';
import { flushAckQueue } from './push';

/**
 * The page half of the service-worker conversation.
 *
 * Three jobs, all of them consequences of platform limits rather than design
 * choices:
 *
 * 1. **Navigation.** `client.navigate()` is unreliable in a standalone iOS PWA —
 *    it can reload the app to `start_url` or silently do nothing — so
 *    `notificationclick` focuses the window and posts the path instead. This is
 *    what turns that message into a React Router navigation, preserving the
 *    running app rather than cold-starting it.
 * 2. **Lending the access token.** D3 keeps the access JWT in page memory, where
 *    a service worker cannot reach it. When the app happens to be open, the SW
 *    asks over a `MessagePort` and can send its D11 ack immediately.
 * 3. **Flushing the ack queue.** Every ack the SW could not deliver (the usual
 *    case: the push arrived with the app swiped away) waits in IndexedDB. We
 *    flush on mount, on every foreground, and whenever the SW nudges us.
 */
export function useServiceWorkerBridge(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;

      if (isPushNavigateMessage(data)) {
        // The SW already reduced this to a same-origin path via
        // `safeNavigatePath`; the guard here is belt-and-braces.
        if (data.url.startsWith('/') && !data.url.startsWith('//')) navigate(data.url);
        return;
      }

      if (isTokenRequestMessage(data)) {
        // Reply only over the port the SW supplied — never broadcast a token.
        event.ports[0]?.postMessage({ token: getAccessToken() });
        return;
      }

      if (isAcksPendingMessage(data)) {
        void flushAckQueue();
      }
    };

    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
  }, [navigate]);

  // Foreground flush. `visibilitychange` rather than `focus`: an installed iOS
  // PWA resumes from a cold start often enough that `focus` alone misses it.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'visible') void flushAckQueue();
    };
    flush();
    document.addEventListener('visibilitychange', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
    };
  }, []);
}
