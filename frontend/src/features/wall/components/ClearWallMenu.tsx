import { useState } from 'react';
import { Eraser, MoreHorizontal } from 'lucide-react';
import { useCan } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/components';
import { ActionSheet, type ActionSheetItem } from '@/shared/ui/action-sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { useCoarsePointer } from '@/shared/ui/use-coarse-pointer';
import { useClearWall } from '../hooks';
import { WALL_RU } from '../locale';

/**
 * The app bar's `⋯` on Стена, which has exactly one item (§D7.11).
 *
 * ## «Очистить доску» is a horizon, not a delete
 *
 * The owner asked for a way to clear the wall. A board could draw the line at
 * its tail; a feed has no tail, so the line has to become a real object:
 * `family_settings.wall_cleared_at`. The feed then returns only rows created
 * after it and **nothing is deleted** — no post, no comment, no reaction, no
 * kudos, no poll, no activity row. A bulk delete is the one irreversible
 * operation in this app that could remove several hundred rows on a single
 * confirm, including other people's words and other people's thank-yous.
 *
 * ## Who may, and why it is this permission
 *
 * `settings:manage` — admin and owner. The horizon lives on the singleton
 * family settings row (D1), so the permission that governs family settings
 * governs it. `post:delete:any` is an adult's licence to moderate one note
 * somebody wrote, which is a different kind of authority from resetting what
 * six people see. A reader without it sees **no `⋯` item — not a disabled
 * one**, and therefore no `⋯` at all.
 *
 * The confirm names what happens *and what stays*, because a clear that
 * visibly leaves the open polls at the top otherwise reads as broken. It
 * carries no row count: «Уберём 247 записей» makes the action feel bigger or
 * smaller than it is, and it is not a number the reader can act on.
 */
export function ClearWallMenu() {
  const { can } = useCan();
  const coarse = useCoarsePointer();
  const clear = useClearWall();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (!can('settings:manage')) return null;

  const items: ActionSheetItem[] = [
    {
      id: 'clear',
      label: WALL_RU.clear.action,
      icon: Eraser,
      tone: 'destructive',
      onSelect: () => {
        setConfirming(true);
      },
    },
  ];

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-11 text-muted-foreground"
      aria-label={WALL_RU.clear.menuAria}
      {...(coarse
        ? {
            onClick: () => {
              setSheetOpen(true);
            },
          }
        : {})}
    >
      <MoreHorizontal className="size-5" aria-hidden />
    </Button>
  );

  return (
    <>
      {coarse ? (
        trigger
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                setConfirming(true);
              }}
            >
              <Eraser className="size-4" aria-hidden />
              {WALL_RU.clear.action}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <ActionSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title={WALL_RU.title}
        description={WALL_RU.clear.menuAria}
        items={items}
      />

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={WALL_RU.clear.confirmTitle}
        description={WALL_RU.clear.confirmDescription}
        confirmLabel={WALL_RU.clear.confirmLabel}
        onConfirm={() => {
          clear.mutate();
        }}
      />
    </>
  );
}
