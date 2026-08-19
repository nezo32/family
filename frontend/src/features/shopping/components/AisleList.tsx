import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ShoppingItemResponse } from '@family/shared';
import { cn } from '@/shared/lib/utils';
import { SHOPPING_RU, plural } from '../locale';
import { boughtTail, groupByAisle, neededItems } from '../grouping';
import { ItemRow } from './ItemRow';

/**
 * The list itself: still-needed items grouped by aisle in store-walk order,
 * with everything already bought collapsed into a tail at the bottom.
 *
 * The collapsed tail matters more than it looks. Bought items must stay
 * reachable — «я случайно отметил» happens constantly — but they must not push
 * the things you still have to find below the fold while you are walking.
 */
export function AisleList(props: {
  items: readonly ShoppingItemResponse[];
  pendingIds: ReadonlySet<string>;
  shopMode: boolean;
  canWrite: boolean;
  onToggle: (item: ShoppingItemResponse, bought: boolean) => void;
  onDelete?: (item: ShoppingItemResponse) => void;
}) {
  const [tailOpen, setTailOpen] = useState(false);

  const needed = neededItems(props.items);
  const groups = groupByAisle(needed);
  const tail = boughtTail(props.items);

  const isPending = (item: ShoppingItemResponse): boolean =>
    props.pendingIds.has(item.id) || (item.clientId !== null && props.pendingIds.has(item.clientId));

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.category ?? '__none__'} aria-label={group.label}>
          <h2
            className={cn(
              'sticky top-0 z-10 -mx-1 bg-background/90 px-1 py-1.5 backdrop-blur-sm',
              'text-xs font-semibold tracking-wide text-muted-foreground uppercase',
            )}
          >
            {group.label}
          </h2>
          <ul className="space-y-1.5">
            {group.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                pending={isPending(item)}
                shopMode={props.shopMode}
                canWrite={props.canWrite}
                onToggle={props.onToggle}
                {...(props.onDelete ? { onDelete: props.onDelete } : {})}
              />
            ))}
          </ul>
        </section>
      ))}

      {tail.length > 0 ? (
        <section aria-label={SHOPPING_RU.boughtSection}>
          <button
            type="button"
            onClick={() => {
              setTailOpen((open) => !open);
            }}
            aria-expanded={tailOpen}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
          >
            <ChevronDown
              className={cn('size-4 transition-transform', tailOpen && 'rotate-180')}
              aria-hidden
            />
            {SHOPPING_RU.boughtSection}
            <span className="font-normal normal-case">
              {tail.length} {plural(tail.length, 'позиция', 'позиции', 'позиций')}
            </span>
          </button>
          {tailOpen ? (
            <ul className="mt-1.5 space-y-1.5">
              {tail.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  pending={isPending(item)}
                  shopMode={props.shopMode}
                  canWrite={props.canWrite}
                  onToggle={props.onToggle}
                  {...(props.onDelete ? { onDelete: props.onDelete } : {})}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
