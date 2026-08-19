import { ROLE_DESCRIPTIONS_RU, ROLE_LABELS_RU, type Role, type UserStatus } from '@family/shared';
import { Badge } from '@/shared/ui/badge';
import { FAMILY_RU } from '../locale';

/**
 * The member's role, in words rather than jargon.
 *
 * `title` carries `ROLE_DESCRIPTIONS_RU` so the label is explainable on a
 * desktop hover; the detail sheet repeats the description in full for touch,
 * where there is no hover to discover.
 *
 * This is **display copy only** — never an access decision (D4).
 */
export function RoleBadge(props: { role: Role; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={props.className}
      title={ROLE_DESCRIPTIONS_RU[props.role]}
    >
      {ROLE_LABELS_RU[props.role]}
    </Badge>
  );
}

/** Only the states that are worth interrupting the roster for. `active` is silent. */
export function StatusBadge(props: { status: UserStatus }) {
  if (props.status === 'active') return null;

  if (props.status === 'suspended') {
    return <Badge variant="destructive">{FAMILY_RU.statusSuspended}</Badge>;
  }
  if (props.status === 'pending_approval') {
    return <Badge variant="secondary">{FAMILY_RU.statusPending}</Badge>;
  }
  return <Badge variant="outline">{FAMILY_RU.statusRejected}</Badge>;
}
