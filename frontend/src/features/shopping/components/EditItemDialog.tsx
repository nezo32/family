import { useEffect, useId, useRef, useState } from 'react';
import type { ShoppingItemResponse, UpdateShoppingItem } from '@family/shared';
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
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';
import { COMMON } from '@/shared/lib/i18n';
import { AISLE_ORDER, SHOPPING_RU } from '../locale';

/**
 * Correct one line of the list.
 *
 * A dialog, not an inline row editor, and the reason is the row itself: it is
 * one big «купил» target with a 44px tick, and the whole design of this screen
 * is that a thumb in a shop cannot miss it. Growing fields inside that row —
 * or turning a tap into "tap to tick, long-press to edit" — makes the common
 * action ambiguous to serve the rare one. The edit lives one tap away in the
 * row's overflow menu, and in shop mode it is not offered at all: walking past
 * the freezers is not when anybody retypes a note.
 *
 * Every text input is 16px on touch, without exception. Anything smaller and
 * iOS zooms the viewport on focus and does not zoom back — the quantity field
 * is the classic offender because a number field *looks* like it wants to be
 * small.
 */
export function EditItemDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ShoppingItemResponse;
  pending: boolean;
  onSave: (body: UpdateShoppingItem) => void;
}) {
  const { item } = props;
  const fieldId = useId();
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(() => formatQuantity(item.quantity));
  const [unit, setUnit] = useState(item.unit ?? '');
  const [category, setCategory] = useState(item.category ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [isUrgent, setUrgent] = useState(item.isUrgent);

  /*
   * Load from the row on the **open transition only**.
   *
   * Depending on the row's fields here instead would refill the form from the
   * cache every time `/shopping/lists/:id/items` refetched — on window focus,
   * after every outbox flush, after somebody else's toggle — and wipe whatever
   * the user was halfway through typing. The row is read once, when the dialog
   * opens; from then on the form is the user's.
   */
  const wasOpen = useRef(props.open);
  useEffect(() => {
    if (props.open && !wasOpen.current) {
      setName(item.name);
      setQuantity(formatQuantity(item.quantity));
      setUnit(item.unit ?? '');
      setCategory(item.category ?? '');
      setNote(item.note ?? '');
      setUrgent(item.isUrgent);
    }
    wasOpen.current = props.open;
  }, [props.open, item.name, item.quantity, item.unit, item.category, item.note, item.isUrgent]);

  const parsedQuantity = parseQuantity(quantity);
  const trimmedName = name.trim();
  const quantityInvalid = parsedQuantity === 'invalid';
  const canSave = trimmedName.length > 0 && !quantityInvalid && !props.pending;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{SHOPPING_RU.editItem}</DialogTitle>
          <DialogDescription>{SHOPPING_RU.editItemDescription}</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            // `canSave` folds in `!quantityInvalid`, which narrows
            // `parsedQuantity` to `number | null` for the payload below.
            if (!canSave) return;
            props.onSave({
              name: trimmedName,
              quantity: parsedQuantity,
              unit: unit.trim() === '' ? null : unit.trim(),
              category: category.trim() === '' ? null : category.trim(),
              note: note.trim() === '' ? null : note.trim(),
              isUrgent,
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-name`}>{SHOPPING_RU.itemNameLabel}</Label>
            <Input
              id={`${fieldId}-name`}
              value={name}
              maxLength={160}
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
              }}
              className="min-h-11 text-base md:text-base"
            />
          </div>

          <div className="flex gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor={`${fieldId}-quantity`}>{SHOPPING_RU.itemQuantityLabel}</Label>
              <Input
                id={`${fieldId}-quantity`}
                value={quantity}
                // `inputMode` rather than `type="number"`: the numeric keypad
                // without the spinner, the Safari scroll-wheel hazard or the
                // browser's own idea of what a decimal separator looks like.
                inputMode="decimal"
                aria-invalid={quantityInvalid}
                onChange={(event) => {
                  setQuantity(event.target.value);
                }}
                className="min-h-11 text-base md:text-base"
              />
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor={`${fieldId}-unit`}>{SHOPPING_RU.itemUnitLabel}</Label>
              <Input
                id={`${fieldId}-unit`}
                value={unit}
                maxLength={24}
                placeholder={SHOPPING_RU.itemUnitPlaceholder}
                onChange={(event) => {
                  setUnit(event.target.value);
                }}
                className="min-h-11 text-base md:text-base"
              />
            </div>
          </div>
          {quantityInvalid ? (
            <p className="text-xs font-medium text-destructive" role="alert">
              {SHOPPING_RU.itemQuantityInvalid}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-category`}>{SHOPPING_RU.itemCategoryLabel}</Label>
            <Input
              id={`${fieldId}-category`}
              value={category}
              maxLength={64}
              list={`${fieldId}-aisles`}
              placeholder={SHOPPING_RU.itemCategoryPlaceholder}
              onChange={(event) => {
                setCategory(event.target.value);
              }}
              className="min-h-11 text-base md:text-base"
            />
            {/* Suggestions, not a закрытый список: a family invents its own отделы. */}
            <datalist id={`${fieldId}-aisles`}>
              {AISLE_ORDER.map((aisle) => (
                <option key={aisle} value={aisle} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">{SHOPPING_RU.itemCategoryHint}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-note`}>{SHOPPING_RU.itemNoteLabel}</Label>
            <Textarea
              id={`${fieldId}-note`}
              value={note}
              rows={2}
              maxLength={500}
              placeholder={SHOPPING_RU.itemNotePlaceholder}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              className="text-base md:text-base"
            />
          </div>

          <Label
            htmlFor={`${fieldId}-urgent`}
            className="flex min-h-11 cursor-pointer items-center justify-between gap-3"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">{SHOPPING_RU.itemUrgentLabel}</span>
              <span className="block text-xs font-normal text-muted-foreground">
                {SHOPPING_RU.itemUrgentHint}
              </span>
            </span>
            <Switch id={`${fieldId}-urgent`} checked={isUrgent} onCheckedChange={setUrgent} />
          </Label>

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
            <Button type="submit" className="min-h-11" disabled={!canSave}>
              {props.pending ? COMMON.saving : COMMON.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** `1.5` → `1,5`. The field is Russian-facing, so it shows a comma. */
function formatQuantity(quantity: number | null): string {
  if (quantity === null) return '';
  return String(quantity).replace('.', ',');
}

/**
 * `''` → `null` (no quantity is a perfectly good answer), a positive number →
 * that number, anything else → `'invalid'`.
 *
 * Both separators are accepted because a Russian keyboard offers a comma and a
 * numeric keypad offers a full stop, and the person typing does not care which
 * one this field happens to prefer.
 */
function parseQuantity(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100_000) return 'invalid';
  return parsed;
}
