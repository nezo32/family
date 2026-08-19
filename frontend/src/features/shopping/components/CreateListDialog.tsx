import { useState } from 'react';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { COMMON } from '@/shared/lib/i18n';
import { SHOPPING_RU } from '../locale';

/**
 * Creating a list is a rare, deliberate act, so it gets a dialog and the online
 * path — unlike items, it is never queued (see `useCreateList`).
 */
export function CreateListDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const trimmed = name.trim();

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setName('');
        props.onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{SHOPPING_RU.newList}</DialogTitle>
          <DialogDescription>{SHOPPING_RU.subtitle}</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length === 0) return;
            props.onCreate(trimmed);
            setName('');
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="shopping-list-name">{SHOPPING_RU.listNameLabel}</Label>
            <Input
              id="shopping-list-name"
              value={name}
              maxLength={80}
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder={SHOPPING_RU.listNamePlaceholder}
              // 16px on touch devices, or iOS zooms the viewport on focus.
              className="min-h-11 text-base md:text-base"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => {
                props.onOpenChange(false);
              }}
            >
              {COMMON.cancel}
            </Button>
            <Button
              type="submit"
              className="min-h-11"
              disabled={trimmed.length === 0 || props.pending}
            >
              {props.pending ? COMMON.saving : SHOPPING_RU.createList}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
