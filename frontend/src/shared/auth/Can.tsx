import type { ReactNode } from 'react';
import { useCan, type ScopedResource } from './use-can';

/**
 * Declarative permission gate.
 *
 * ```tsx
 * <Can perm="task:update" resource={task}>
 *   <Button onClick={edit}>Изменить</Button>
 * </Can>
 *
 * <Can perm="member:approve" fallback={<ReadOnlyBadge />}>…</Can>
 * ```
 *
 * `perm` is the **base** permission (`'task:update'`), not the scoped variant —
 * `useCan()` resolves `own` vs `any` against `resource`. See `use-can.ts`.
 *
 * While `/api/me` is still loading nothing is rendered: flashing "нет доступа"
 * and then the real content is worse than a beat of empty space.
 */
export function Can(props: {
  perm: string;
  /** Row being acted upon, for `own`-scoped permissions. */
  resource?: ScopedResource | null;
  /** Rendered when the permission is denied. Defaults to nothing. */
  fallback?: ReactNode;
  /** Rendered while `/api/me` is in flight. Defaults to nothing. */
  pending?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const { can, isReady } = useCan();
  if (!isReady) return props.pending ?? null;
  return can(props.perm, props.resource) ? props.children : (props.fallback ?? null);
}

/** `<Can>` for "any one of these". Handy for section-level navigation. */
export function CanAny(props: {
  perms: string[];
  fallback?: ReactNode;
  pending?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const { canAny, isReady } = useCan();
  if (!isReady) return props.pending ?? null;
  return canAny(...props.perms) ? props.children : (props.fallback ?? null);
}
