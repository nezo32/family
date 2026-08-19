import { useState } from 'react';
import { UserPlus, Users } from 'lucide-react';
import type { PublicUser, TaskOccurrenceResponse } from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { cn } from '@/shared/lib/utils';
import { TASKS_RU } from '../locale';
import { useAssignOccurrence, useClaimOccurrence } from '../hooks';

/**
 * Who is doing this chore, and — for those who may change it — the picker.
 *
 * The gate is `useCan('task:assign')`, never `role === 'adult'` (D4): an admin
 * can grant a teenager `task:assign:any` per-user, and a role check would keep
 * the button hidden from them forever.
 */
export function AssigneeControl(props: {
  occurrence: TaskOccurrenceResponse;
  members: readonly PublicUser[];
  /** Compact inline rendering for list cards. */
  compact?: boolean;
}) {
  const { can, userId } = useCan();
  const [open, setOpen] = useState(false);
  const assign = useAssignOccurrence();
  const claim = useClaimOccurrence();

  const assignee = props.members.find((member) => member.id === props.occurrence.assigneeId);
  const mayAssign = can('task:assign');
  const closed = props.occurrence.status !== 'scheduled';
  const mayClaim =
    !closed && props.occurrence.assigneeId === null && can('task:complete', props.occurrence);

  const face = assignee ? (
    <span className="flex min-w-0 items-center gap-2">
      <UserAvatar user={assignee} size="xs" highlighted={assignee.id === userId} />
      <span className="truncate text-sm text-muted-foreground">{assignee.displayName}</span>
    </span>
  ) : (
    <span className="flex items-center gap-2 text-sm text-muted-foreground">
      <Users className="size-4" aria-hidden />
      {TASKS_RU.card.noAssignee}
    </span>
  );

  if (props.compact) {
    return face;
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {face}

      {mayAssign && !closed ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11"
          onClick={() => {
            setOpen(true);
          }}
        >
          <UserPlus className="size-4" aria-hidden />
          {assignee ? TASKS_RU.actions.reassign : TASKS_RU.actions.assign}
        </Button>
      ) : null}

      {!mayAssign && mayClaim ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="min-h-11"
          disabled={claim.isPending}
          onClick={() => {
            claim.mutate({ occurrenceId: props.occurrence.id });
          }}
        >
          {TASKS_RU.card.claim}
        </Button>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>{TASKS_RU.assign.title}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <AssigneeOption
              label={TASKS_RU.assign.nobody}
              selected={props.occurrence.assigneeId === null}
              onSelect={() => {
                assign.mutate({ occurrenceId: props.occurrence.id, assigneeId: null });
                setOpen(false);
              }}
            />
            {props.members.map((member) => (
              <AssigneeOption
                key={member.id}
                label={member.displayName}
                avatar={member}
                selected={props.occurrence.assigneeId === member.id}
                onSelect={() => {
                  assign.mutate({ occurrenceId: props.occurrence.id, assigneeId: member.id });
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AssigneeOption(props: {
  label: string;
  avatar?: PublicUser;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
        props.selected ? 'bg-primary/10 font-medium text-foreground' : 'hover:bg-accent',
      )}
    >
      {props.avatar ? <UserAvatar user={props.avatar} size="sm" /> : null}
      <span className="truncate">{props.label}</span>
    </button>
  );
}
