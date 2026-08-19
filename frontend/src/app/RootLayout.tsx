import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { setNavigate } from '@/shared/api/navigation';

/**
 * The outermost route element.
 *
 * Its only job is to hand the imperative API layer a real `navigate` function,
 * so an involuntary redirect (401 → `/login`, 403 → `/auth/suspended`) is a
 * client-side transition instead of a full page reload that throws away the
 * query cache. `useNavigate` needs the router context, which is why this lives
 * in a route element rather than in `providers.tsx`.
 */
export function RootLayout() {
  const navigate = useNavigate();

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
