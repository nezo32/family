import { Link } from 'react-router-dom';
import { ShoppingBasket } from 'lucide-react';
import type { ShoppingListResponse } from '@family/shared';
import { cn } from '@/shared/lib/utils';
import { displayEmoji } from '@/shared/lib/emoji';
import { SHOPPING_RU } from '../locale';
import { ListActionsMenu } from './ListActionsMenu';

/**
 * One list on the overview screen.
 *
 * The `<Link>` still covers everything that is not a control: the target is the
 * whole 72px row, which is what a thumb in a coat pocket actually hits. The
 * overflow menu is a **sibling** of the link rather than a button inside it —
 * nesting an interactive element in an anchor is invalid, and every tap on the
 * menu would also have navigated.
 *
 * It replaces the chevron rather than joining it. Two 44px controls plus the
 * badge plus the icon leave the name about forty pixels to live in at 320px,
 * and the row is obviously tappable without an arrow drawn on it.
 *
 * The needed-count is the number people scan for, so it gets the accent colour
 * and the larger type; the total is context.
 */
export function ListCard(props: { list: ShoppingListResponse; to: string }) {
  const { list } = props;
  // The `icon` field is free-form; seeded lists hold lucide names like
  // `spray-can`, which rendered as clipped text inside the coloured circle.
  const emoji = displayEmoji(list.icon);
  return (
    <li
      className={cn(
        'flex min-h-18 items-center rounded-xl border border-border bg-card pr-1.5',
        'focus-within:ring-[3px] focus-within:ring-ring/50',
        list.isArchived && 'opacity-60',
      )}
    >
      <Link
        to={props.to}
        className={cn(
          'flex min-h-18 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5',
          'touch-manipulation no-callout outline-none',
        )}
      >
        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"
          style={list.color ? { backgroundColor: list.color, color: '#fff' } : undefined}
        >
          {emoji ? (
            <span className="text-lg leading-none">{emoji}</span>
          ) : (
            <ShoppingBasket className="size-5" />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium text-foreground">{list.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {list.isArchived
              ? SHOPPING_RU.archived
              : SHOPPING_RU.counters(list.neededCount, list.totalCount)}
          </span>
        </span>

        {list.neededCount > 0 ? (
          <span className="shrink-0 rounded-full bg-primary px-2.5 py-1 text-sm font-semibold text-primary-foreground tabular-nums">
            {list.neededCount}
          </span>
        ) : null}
      </Link>

      {/* Renders nothing at all without `shopping:list:manage`. */}
      <ListActionsMenu list={list} />
    </li>
  );
}
