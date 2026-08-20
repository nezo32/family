import { useState } from 'react';
import { Archive, ArchiveRestore, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import type { ShoppingListResponse } from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog';
import { InlineSpinner } from '@/shared/components/LoadingScreen';
import { COMMON } from '@/shared/lib/i18n';
import { notify } from '@/shared/lib/toast';
import { cn } from '@/shared/lib/utils';
import { SHOPPING_RU } from '../locale';
import { useDeleteList, useUpdateList } from '../hooks';
import { EditListDialog } from './EditListDialog';

/**
 * Everything you can do *to* a list, in one overflow menu.
 *
 * Rendered on each card on the overview and in the header of the list you are
 * currently inside, so «удалить» is never more than two taps from wherever you
 * noticed you wanted it.
 *
 * ## Who sees it
 *
 * `shopping:list:manage`, checked with `useCan()` — never `role ===`. Children
 * hold `shopping:read` and `shopping:write`: they may add «мороженое» and tick
 * it off, and that is the participation this app is for. They must not find a
 * greyed-out «Удалить список» and wonder what they did wrong, so the whole
 * trigger is absent rather than disabled, and this component renders `null`.
 *
 * ## Archive first, delete last
 *
 * A family that is done with «Дача» wants it out of the way, not destroyed.
 * Archiving is a single tap with no confirmation and is fully reversible from
 * the same menu; deleting sits below a separator, wears the destructive colour,
 * and has to get past a dialog that says how many позиций go with it. The
 * dialog also points back at archiving, because the moment somebody is about to
 * destroy twelve rows is the right moment to mention the reversible option.
 */
export function ListActionsMenu(props: {
  list: ShoppingListResponse;
  /** Called after the server confirms the deletion — `ListPage` navigates away. */
  onDeleted?: () => void;
  className?: string;
}) {
  const { list } = props;
  const { can } = useCan();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const update = useUpdateList(list.id);
  const remove = useDeleteList(list.id);

  // Hooks first, gate second: an absent control, not a disabled one.
  if (!can('shopping:list:manage')) return null;

  const archive = (): void => {
    update.mutate(
      { isArchived: !list.isArchived },
      {
        onSuccess: () => {
          notify.success(
            list.isArchived ? SHOPPING_RU.listUnarchivedToast : SHOPPING_RU.listArchivedToast,
          );
        },
      },
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('size-11 shrink-0 text-muted-foreground', props.className)}
            aria-label={SHOPPING_RU.listActions}
          >
            <MoreVertical className="size-5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem
            className="min-h-11"
            onSelect={() => {
              setEditing(true);
            }}
          >
            <Pencil className="size-4" aria-hidden />
            {SHOPPING_RU.editList}
          </DropdownMenuItem>

          <DropdownMenuItem className="min-h-11" onSelect={archive}>
            {list.isArchived ? (
              <ArchiveRestore className="size-4" aria-hidden />
            ) : (
              <Archive className="size-4" aria-hidden />
            )}
            {list.isArchived ? SHOPPING_RU.unarchiveList : SHOPPING_RU.archiveList}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            variant="destructive"
            className="min-h-11"
            onSelect={() => {
              setConfirmingDelete(true);
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            {SHOPPING_RU.deleteList}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditListDialog
        open={editing}
        onOpenChange={setEditing}
        list={list}
        pending={update.isPending}
        onSave={(body) => {
          // Optimistic: the new name is on screen before the request lands, and
          // rolls back under an error toast if it does not.
          setEditing(false);
          update.mutate(body, {
            onSuccess: () => {
              notify.success(SHOPPING_RU.listUpdated);
            },
          });
        }}
      />

      {/*
        Built on `alert-dialog` here rather than reusing `shared/ConfirmDialog`,
        for one measured reason: that component's footer buttons come out 36px
        tall, and this is a destructive confirmation on a phone. Both buttons
        below are `min-h-11`.
      */}
      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{SHOPPING_RU.deleteListTitle(list.name)}</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block">{SHOPPING_RU.deleteListBody(list.totalCount)}</span>
              {list.isArchived ? null : (
                <span className="mt-2 block">{SHOPPING_RU.deleteListArchiveHint}</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11" disabled={remove.isPending}>
              {COMMON.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="min-h-11"
              disabled={remove.isPending}
              onClick={(event) => {
                // Radix closes on click; hold the dialog open under the spinner
                // until the server has actually answered.
                event.preventDefault();
                remove
                  .mutateAsync()
                  .then(() => {
                    setConfirmingDelete(false);
                    props.onDeleted?.();
                  })
                  // The mutation already surfaced the mapped Russian error, and
                  // the list is still on screen because the delete was never
                  // optimistic. Leave the dialog open so the retry is one tap.
                  .catch(() => undefined);
              }}
            >
              {remove.isPending ? <InlineSpinner className="mr-2" /> : null}
              {SHOPPING_RU.deleteList}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
