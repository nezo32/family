import { Badge } from '@/shared/ui/badge';
import { cn } from '@/shared/lib/utils';
import { ADMIN_RU } from '../locale';
import { usePendingMemberCount } from '../hooks';

/**
 * The pending-approval count, for consumers outside this feature (the sidebar
 * entry, the Today screen, a tab-bar dot).
 *
 * Renders nothing at zero, and nothing at all for a user who may not see the
 * queue — `usePendingMemberCount()` never runs the request without
 * `member:approve`, so this component is safe to mount anywhere in the shell
 * without its own permission check.
 */
export function PendingCountBadge(props: { className?: string }) {
  const count = usePendingMemberCount();
  if (count <= 0) return null;

  return (
    <Badge
      aria-label={`${ADMIN_RU.pendingBadgeLabel}: ${String(count)}`}
      className={cn('min-w-5 justify-center px-1.5 tabular-nums', props.className)}
    >
      {count}
    </Badge>
  );
}
