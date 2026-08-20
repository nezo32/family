import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Check, RotateCcw, SkipForward, UserPlus } from 'lucide-react';
import type { TaskOccurrenceResponse } from '@family/shared';

import { useCan } from '@/shared/auth/use-can';
import { ActionSheet, type ActionSheetItem } from '@/shared/ui/action-sheet';
import { ConfirmDialog } from '@/shared/components';
import { TASKS_RU } from '../locale';
import { taskDetailPath } from '../routes';
import {
  useClaimOccurrence,
  useCompleteOccurrence,
  useSkipOccurrence,
  useUncompleteOccurrence,
} from '../hooks';

/**
 * The action sheet a task row opens — from a long press (§G5) and from the
 * detail screen's own controls, which is the *visible* door §G1 requires.
 *
 * ## Why «Возьму на себя» lives here
 *
 * §D2 took it off the row deliberately. It used to be a button in a coloured
 * footer band under every chore, which doubled the height of a 56px row to
 * carry an action that applies only to the unassigned ones — and put a second
 * filled control on every line of a list. In the sheet it costs nothing when it
 * does not apply and reads as a decision when it does.
 *
 * ## What is *not* here
 *
 * «Удалить». Deleting a chore deletes its **series**, and every completed
 * occurrence's place in the family's history with it — that lives on the detail
 * screen behind a scope prompt, which is where a decision of that size belongs.
 * A long press is not a decision.
 *
 * «Пропустить» is here but it opens a confirmation rather than skipping: a
 * skipped chore is a permanent line in the history and there is no un-skip.
 */
export function TaskRowSheet(props: {
  occurrence: TaskOccurrenceResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { occurrence } = props;
  const { can } = useCan();
  const navigate = useNavigate();
  const complete = useCompleteOccurrence();
  const uncomplete = useUncompleteOccurrence();
  const claim = useClaimOccurrence();
  const skip = useSkipOccurrence();
  const [confirmingSkip, setConfirmingSkip] = useState(false);

  const isDone = occurrence.status === 'done';
  const closed = occurrence.status === 'skipped' || occurrence.status === 'cancelled';
  const mayComplete = can('task:complete', occurrence);
  // Resource-less on purpose: an unassigned chore is nobody's, so an ownership
  // test can only ever answer "no" — and claiming is the act that makes it
  // yours. Same reasoning as `AssigneeControl`.
  const mayClaim = !closed && !isDone && occurrence.assigneeId === null && can('task:complete');
  const maySkip = !closed && !isDone && can('task:update', occurrence);

  const items: ActionSheetItem[] = [];

  if (!closed && (mayComplete || isDone)) {
    items.push(
      isDone
        ? {
            id: 'uncomplete',
            label: TASKS_RU.card.uncomplete,
            icon: RotateCcw,
            onSelect: () => {
              uncomplete.mutate({ occurrenceId: occurrence.id });
            },
          }
        : {
            id: 'complete',
            label: TASKS_RU.card.complete,
            icon: Check,
            onSelect: () => {
              complete.mutate({ occurrenceId: occurrence.id });
            },
          },
    );
  }

  if (mayClaim) {
    items.push({
      id: 'claim',
      label: TASKS_RU.card.claim,
      icon: UserPlus,
      onSelect: () => {
        claim.mutate({ occurrenceId: occurrence.id });
      },
    });
  }

  if (maySkip) {
    items.push({
      id: 'skip',
      label: TASKS_RU.actions.skip,
      hint: TASKS_RU.skip.description,
      icon: SkipForward,
      onSelect: () => {
        setConfirmingSkip(true);
      },
    });
  }

  items.push({
    id: 'open',
    label: TASKS_RU.rowSheet.open,
    icon: ChevronRight,
    onSelect: () => {
      void navigate(taskDetailPath(occurrence.id));
    },
  });

  return (
    <>
      <ActionSheet
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={occurrence.title}
        description={TASKS_RU.rowSheet.description}
        items={items}
      />
      <ConfirmDialog
        open={confirmingSkip}
        onOpenChange={setConfirmingSkip}
        title={TASKS_RU.skip.title}
        description={TASKS_RU.skip.description}
        confirmLabel={TASKS_RU.skip.confirm}
        onConfirm={() => {
          skip.mutate({ occurrenceId: occurrence.id, body: { suppressFuture: false } });
        }}
      />
    </>
  );
}
