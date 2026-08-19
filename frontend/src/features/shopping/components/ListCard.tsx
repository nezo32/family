import { Link } from 'react-router-dom';
import { ChevronRight, ShoppingBasket } from 'lucide-react';
import type { ShoppingListResponse } from '@family/shared';
import { cn } from '@/shared/lib/utils';
import { displayEmoji } from '@/shared/lib/emoji';
import { SHOPPING_RU } from '../locale';

/**
 * One list on the overview screen.
 *
 * A whole-card `<Link>` rather than a card with a link inside it: the target is
 * the entire 72px row, which is what a thumb in a coat pocket actually hits.
 * The needed-count is the number people scan for, so it gets the accent colour
 * and the larger type; the total is context.
 */
export function ListCard(props: { list: ShoppingListResponse; to: string }) {
  const { list } = props;
  // The `icon` field is free-form; seeded lists hold lucide names like
  // `spray-can`, which rendered as clipped text inside the coloured circle.
  const emoji = displayEmoji(list.icon);
  return (
    <li>
      <Link
        to={props.to}
        className={cn(
          'flex min-h-18 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5',
          'touch-manipulation no-callout outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          list.isArchived && 'opacity-60',
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
        <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  );
}
