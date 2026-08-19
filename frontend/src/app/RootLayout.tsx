import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { setNavigate } from '@/shared/api/navigation';
import { useServiceWorkerBridge } from '@/features/settings/push/sw-bridge';

/**
 * The outermost route element.
 *
 * Its job is to hand the imperative API layer a real `navigate` function, so an
 * involuntary redirect (401 → `/login`, 403 → `/auth/suspended`) is a
 * client-side transition instead of a full page reload that throws away the
 * query cache. `useNavigate` needs the router context, which is why this lives
 * in a route element rather than in `providers.tsx`.
 *
 * It also mounts the service-worker bridge, for the same reason: a tap on a push
 * notification has to become a React Router navigation (`client.navigate()` is
 * unreliable in a standalone iOS PWA), and the D11 ack queue has to be flushed
 * on every foreground. Both need router context and must be alive on every
 * screen, not only under `/settings`.
 */
export function RootLayout() {
  const navigate = useNavigate();
  useServiceWorkerBridge();

  useEffect(() => {
    setNavigate((to, options) => {
      void navigate(to, { replace: options?.replace ?? true });
    });
    return () => {
      setNavigate(null);
    };
  }, [navigate]);

  return <Outlet />;
}
