import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ROUTES, loginUrl } from '../lib/routes';
import { isApiError } from '../api/errors';
import { LoadingScreen } from '../components/LoadingScreen';
import { ErrorState } from '../components/ErrorState';
import { useCan } from './use-can';
import { useMe } from './use-me';

/**
 * Route guards.
 *
 * Two layers, used as React Router layout routes:
 *
 *   <RequireAuth>            — there must be a usable session
 *     <RequirePermission …>  — …and it must carry a specific permission
 *
 * Neither is a security boundary: the backend enforces both, and a
 * `pending_approval` user has no session at all (D3), so they cannot reach an
 * authenticated route in the first place. These exist so the app shows the
 * right screen instead of a cascade of failed requests.
 */

export function RequireAuth(props: { children?: ReactNode }): ReactNode {
  const location = useLocation();
  const { data: me, isPending, isError, error, refetch } = useMe();

  if (isPending) return <LoadingScreen />;

  if (isError) {
    // 401/403 → the API layer already cleared the token and started the
    // redirect; render the redirect declaratively too so we do not depend on
    // the imperative bridge having been installed.
    if (isApiError(error)) {
      if (error.status === 401) {
        return <Navigate to={loginUrl(location.pathname + location.search)} replace />;
      }
      if (error.code === 'ACCOUNT_PENDING_APPROVAL') return <Navigate to={ROUTES.authPending} replace />;
      if (error.code === 'ACCOUNT_REJECTED') return <Navigate to={ROUTES.authRejected} replace />;
      if (error.code === 'ACCOUNT_SUSPENDED') return <Navigate to={ROUTES.authSuspended} replace />;
    }
    // Network / 5xx: offer a retry rather than bouncing to the login screen,
    // which would look like "you were logged out" when the server just blinked.
    return <ErrorState error={error} onRetry={() => void refetch()} fullscreen />;
  }

  // Belt and braces: the server should never hand a session to a non-active
  // account, but if it ever does, land on the right explanation screen.
  if (me.status === 'pending_approval') return <Navigate to={ROUTES.authPending} replace />;
  if (me.status === 'rejected') return <Navigate to={ROUTES.authRejected} replace />;
  if (me.status === 'suspended') return <Navigate to={ROUTES.authSuspended} replace />;

  return props.children ?? <Outlet />;
}

/**
 * Permission-gated route. Must be nested inside `<RequireAuth>`.
 *
 * `perm` is the base permission — see `use-can.ts` for the `own`/`any` rules.
 * On denial we render an explanation rather than redirecting: a silent bounce
 * to `/` makes a shared link look broken.
 */
export function RequirePermission(props: {
  perm: string;
  /** Require every listed permission instead of just `perm`. */
  allOf?: string[];
  /** Require at least one of these. Takes precedence over `perm` when given. */
  anyOf?: string[];
  children?: ReactNode;
}): ReactNode {
  const { can, canAll, canAny, isReady } = useCan();

  if (!isReady) return <LoadingScreen />;

  const allowed = props.anyOf
    ? canAny(...props.anyOf)
    : props.allOf
      ? canAll(...props.allOf)
      : can(props.perm);

  if (!allowed) return <NoAccess />;

  return props.children ?? <Outlet />;
}

function NoAccess(): ReactNode {
  return (
    <ErrorState
      fullscreen
      title="Нет доступа"
      description="У вас нет прав на этот раздел. Если он вам нужен — попросите администратора семьи."
      retryLabel="На главную"
      onRetry={() => {
        window.location.assign(ROUTES.today);
      }}
    />
  );
}

/**
 * Inverse guard for `/login`: an already-authenticated user should not see the
 * sign-in screen — send them where they were headed.
 */
export function RedirectIfAuthenticated(props: { children?: ReactNode }): ReactNode {
  const location = useLocation();
  const { data: me, isPending } = useMe();

  if (isPending) return <LoadingScreen />;
  if (me && me.status === 'active') {
    const next = new URLSearchParams(location.search).get('next');
    return <Navigate to={next && next.startsWith('/') ? next : ROUTES.today} replace />;
  }
  return props.children ?? <Outlet />;
}
