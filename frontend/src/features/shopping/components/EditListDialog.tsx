import { useEffect, useRef, useState } from 'react';
import { Ban } from 'lucide-react';
import type { ShoppingListResponse, UpdateShoppingList } from '@family/shared';
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
import { displayEmoji } from '@/shared/lib/emoji';
import { cn } from '@/shared/lib/utils';
import { SHOPPING_RU } from '../locale';

/**
 * Rename / recolour one list.
 *
 * The three fields are exactly the three the contract lets a list carry
 * (`name`, `icon`, `color`); `isArchived` is a one-tap menu item rather than a
 * switch in here, because archiving is a decision about the list, not a
 * property of it, and burying it behind «Сохранить» would make the gentle
 * option feel heavier than deleting.
 */

/**
 * The same eight hues the moneybox pickers use — `--chart-1…5` from
 * `src/index.css` plus three more in the same lightness/chroma band. The
 * contract wants a literal `#RRGGBB` (stored data, not a CSS variable), so they
 * are inlined here rather than read from the theme.
 */
const LIST_COLORS = [
  '#DA6635', // clay
  '#43996C', // sage
  '#E3AD3E', // honey
  '#9F599D', // plum
  '#3B9AC5', // sky
  '#C1555D', // brick
  '#6179BD', // indigo
  '#259B9C', // teal
] as const;

/** Emoji, never a lucide name — see `shared/lib/emoji.ts` for why. */
const LIST_ICONS = ['🛒', '🥦', '🍞', '🥛', '🧴', '💊', '🧹', '🎁', '🐶', '🔧', '🏠', '🎂'] as const;

export function EditListDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  list: ShoppingListResponse;
  pending: boolean;
  onSave: (body: UpdateShoppingList) => void;
}) {
  const { list } = props;
  const [name, setName] = useState(list.name);
  // A stored lucide name is dropped rather than round-tripped: this picker
  // writes emoji, so opening the dialog is where an old `spray-can` retires.
  const [icon, setIcon] = useState<string | null>(() => displayEmoji(list.icon));
  const [color, setColor] = useState<string | null>(list.color);

  /*
   * Reset on the **open transition only**, never on a change to `list`.
   *
   * The obvious version of this effect depends on `list.name / icon / color`
   * so that reopening the dialog shows whatever somebody else has since saved.
   * It also means any background refetch of `/shopping/lists` that lands while
   * the dialog is open — React Query refetches on window focus, and this screen
   * is refetched by every mutation on it — throws away what the user has typed
   * and un-picks the icon they just chose. Losing a half-typed name to a
   * network event nobody asked for is worse than showing a name that is one
   * refetch stale, so the sync happens when the dialog opens and not again.
   */
  const wasOpen = useRef(props.open);
  useEffect(() => {
    if (props.open && !wasOpen.current) {
      setName(list.name);
      setIcon(displayEmoji(list.icon));
      setColor(list.color);
    }
    wasOpen.current = props.open;
  }, [props.open, list.name, list.icon, list.color]);

  const trimmed = name.trim();

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{SHOPPING_RU.editList}</DialogTitle>
          <DialogDescription>{SHOPPING_RU.editListDescription}</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length === 0) return;
            props.onSave({ name: trimmed, icon, color });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="shopping-list-edit-name">{SHOPPING_RU.listNameLabel}</Label>
            <Input
              id="shopping-list-edit-name"
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

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{SHOPPING_RU.listIconLabel}</legend>
            <div className="flex flex-wrap gap-2">
              {LIST_ICONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  aria-pressed={icon === emoji}
                  onClick={() => {
                    setIcon(icon === emoji ? null : emoji);
                  }}
                  className={cn(
                    'flex size-11 items-center justify-center rounded-xl border-2 text-lg',
                    icon === emoji ? 'border-foreground bg-accent' : 'border-transparent bg-muted',
                  )}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{SHOPPING_RU.listColorLabel}</legend>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-label={COMMON.none}
                aria-pressed={color === null}
                onClick={() => {
                  setColor(null);
                }}
                className={cn(
                  'flex size-11 items-center justify-center rounded-full border-2 bg-muted text-muted-foreground',
                  color === null ? 'border-foreground' : 'border-transparent',
                )}
              >
                <Ban className="size-4" aria-hidden />
              </button>
              {LIST_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={swatch}
                  aria-pressed={color === swatch}
                  onClick={() => {
                    setColor(swatch);
                  }}
                  className={cn(
                    'size-11 rounded-full border-2',
                    color === swatch ? 'border-foreground' : 'border-transparent',
                  )}
                  style={{ backgroundColor: swatch }}
                />
              ))}
            </div>
          </fieldset>

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
              {props.pending ? COMMON.saving : COMMON.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
