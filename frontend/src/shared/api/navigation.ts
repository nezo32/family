/**
 * A tiny bridge between the imperative API layer and React Router.
 *
 * The fetch wrapper has to be able to send the user to `/login` or to an
 * account-status screen, but it is not a component and cannot call
 * `useNavigate()`. `<RouterNavigationBridge />` (rendered inside the router in
 * `app/providers.tsx`) installs the real navigate function here; until then we
 * fall back to a full page load, which is always correct, just slower.
 */

export type Navigate = (to: string, options?: { replace?: boolean }) => void;

let navigate: Navigate | null = null;

export function setNavigate(fn: Navigate | null): void {
  navigate = fn;
}

/**
 * Navigate without a full reload when the router is mounted.
 * `replace` defaults to true: these are involuntary redirects and must not add
 * a history entry the back button can bounce off.
 */
export function redirectTo(to: string, options: { replace?: boolean } = {}): void {
  const replace = options.replace ?? true;
  if (navigate) {
    navigate(to, { replace });
    return;
  }
  if (typeof window === 'undefined') return;
  if (replace) window.location.replace(to);
  else window.location.assign(to);
}

/** Current path + search, safe to hand to `?next=` so we can come back after login. */
export function currentLocationPath(): string {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}`;
}
