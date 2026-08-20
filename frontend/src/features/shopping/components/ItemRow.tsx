import { Check, CloudOff, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import type { ShoppingItemResponse } from '@family/shared';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { cn } from '@/shared/lib/utils';
import { formatNumber } from '@/shared/lib/format';
import { SHOPPING_RU } from '../locale';

/**
 * One line of the list, and the most-tapped control in the app.
 *
 * Mobile rules applied here rather than in a stylesheet, because they are the
 * reason the component looks the way it does:
 *
 * - **the whole row is the target**, not a 16px checkbox. Minimum 56px tall,
 *   68px in shop mode — a coat sleeve and a moving trolley are not a mouse.
 * - **the tick is on the left**, where a right thumb reaches without regripping,
 *   and the destructive action is a small, separate control on the far side so
 *   the two are never confused at a glance.
 * - **`touch-action: manipulation`** kills the 300ms double-tap-zoom delay.
 * - **no horizontal overflow at 320px**: the name truncates, everything else
 *   is `shrink-0`.
 *
 * ## Editing without spoiling the tap
 *
 * «Изменить» and «Удалить» share one 44px overflow control on the far side —
 * the same footprint the bare delete button used to occupy. That is deliberate:
 * the row's whole job is to be an unmissable «купил» target, and every extra
 * control on it is width taken from the thing people actually tap. Putting the
 * edit affordance *inside* the row (an inline field, or tap-to-tick /
 * long-press-to-edit) would make the common action ambiguous in order to serve
 * the rare one. One menu costs one extra tap for a correction nobody makes
 * mid-aisle, and costs the tick nothing.
 *
 * In shop mode the menu disappears entirely, exactly as the delete button did:
 * that mode is for walking, and the row grows to 68px because a moving trolley
 * is the constraint.
 */
export function ItemRow(props: {
  item: ShoppingItemResponse;
  /** Still sitting in the outbox — rendered as «не отправлено». */
  pending: boolean;
  shopMode: boolean;
  canWrite: boolean;
  onToggle: (item: ShoppingItemResponse, bought: boolean) => void;
  onEdit?: (item: ShoppingItemResponse) => void;
  onDelete?: (item: ShoppingItemResponse) => void;
}) {
  const { item, shopMode, canWrite } = props;
  const onEdit = props.onEdit;
  const onDelete = props.onDelete;
  const showMenu = canWrite && !shopMode && (onEdit !== undefined || onDelete !== undefined);
  const bought = item.state === 'bought';
  const quantity = formatQuantity(item);

  return (
    <li
      className={cn(
        'flex items-stretch gap-1 rounded-xl border border-transparent bg-card transition-colors',
        item.isUrgent && !bought && 'border-destructive/30',
        bought && 'opacity-60',
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={bought}
        disabled={!canWrite}
        onClick={() => {
          props.onToggle(item, !bought);
        }}
        aria-label={bought ? SHOPPING_RU.markNeeded : SHOPPING_RU.markBought}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 text-left no-callout',
          'touch-manipulation outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'disabled:pointer-events-none disabled:opacity-60',
          shopMode ? 'min-h-17 py-3' : 'min-h-14 py-2',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'flex shrink-0 items-center justify-center rounded-lg border-2 transition-colors',
            shopMode ? 'size-11' : 'size-8',
            bought
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input bg-background',
          )}
        >
          {bought ? <Check className={shopMode ? 'size-7' : 'size-5'} /> : null}
        </span>

        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate font-medium text-foreground',
              shopMode ? 'text-lg' : 'text-base',
              bought && 'text-muted-foreground line-through',
            )}
          >
            {item.name}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {quantity ? (
              <span className={cn('font-medium', shopMode && 'text-sm')}>{quantity}</span>
            ) : null}
            {item.isUrgent && !bought ? (
              <span className="font-medium text-destructive">{SHOPPING_RU.urgent}</span>
            ) : null}
            {item.note ? <span className="truncate">{item.note}</span> : null}
            {props.pending ? (
              <span
                data-testid="pending-marker"
                className="inline-flex items-center gap-1 font-medium text-warning"
              >
                <CloudOff className="size-3" aria-hidden />
                {SHOPPING_RU.notSent}
              </span>
            ) : null}
          </span>
        </span>
      </button>

      {showMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={SHOPPING_RU.itemActions}
              className="my-1 mr-1 size-11 shrink-0 self-center text-muted-foreground"
            >
              <MoreVertical className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {onEdit ? (
              <DropdownMenuItem
                className="min-h-11"
                onSelect={() => {
                  onEdit(item);
                }}
              >
                <Pencil className="size-4" aria-hidden />
                {SHOPPING_RU.editItem}
              </DropdownMenuItem>
            ) : null}
            {onDelete ? (
              <DropdownMenuItem
                variant="destructive"
                className="min-h-11"
                onSelect={() => {
                  onDelete(item);
                }}
              >
                <Trash2 className="size-4" aria-hidden />
                {SHOPPING_RU.deleteItem}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

/** «2 кг», «3 шт», «1,5» — the unit is optional and the number is Russian-formatted. */
function formatQuantity(item: ShoppingItemResponse): string | null {
  if (item.quantity === null && !item.unit) return null;
  if (item.quantity === null) return item.unit;
  // `formatNumber` pads to a fixed number of decimals; a quantity wants a
  // *maximum* instead, so «1,5 кг» does not become «1,500 кг».
  const value = Number.isInteger(item.quantity)
    ? formatNumber(item.quantity)
    : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(item.quantity);
  return item.unit ? `${value} ${item.unit}` : value;
}
