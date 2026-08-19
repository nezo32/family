export { Can, CanAny } from './Can';
export { RedirectIfAuthenticated, RequireAuth, RequirePermission } from './require-auth';
export {
  evaluate,
  isOwnedBy,
  resolveScopeFor,
  useCan,
  type CanFn,
  type PermissionScope,
  type ScopedResource,
  type UseCanResult,
} from './use-can';
export { meKeys, useInvalidateMe, useIsAuthLoading, useMe } from './use-me';
export { familyWeekStart, toDayPickerWeekStart, type DayPickerWeekStart } from './week-start';

/**
 * The `/api/me` shape itself is **not** re-exported here.
 *
 * It is `meResponseSchema` / `MeResponse` in `@family/shared`, imported from
 * there by both sides of the wire. A local alias is how the previous flat
 * duplicate started.
 */
