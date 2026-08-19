import { ShoppingCart } from 'lucide-react';
import { ROUTES } from '@/shared/lib/routes';
import { formatNumber } from '@/shared/lib/format';
import { TODAY_RU, itemCount } from '../locale';
import type { TodayShoppingSection } from '../types';
import { WidgetCard } from './WidgetCard';

/**
 * Only the items somebody marked urgent.
 *
 * The full list is one tap away; putting thirty items on the home screen turns
 * the screen into the shopping feature, which it is not.
 */
export function ShoppingWidget(props: { shopping: TodayShoppingSection }) {
  const { shopping } = props;

  return (
    <WidgetCard
      title={TODAY_RU.shoppingTitle}
      icon={ShoppingCart}
      meta={shopping.urgent.length > 0 ? itemCount(shopping.urgent.length) : undefined}
      linkTo={ROUTES.shopping}
      linkLabel={TODAY_RU.shoppingAll}
    >
      {shopping.urgent.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">{TODAY_RU.shoppingEmpty}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {shopping.urgent.slice(0, 8).map((item) => (
            <li
              key={item.id}
              className="max-w-full truncate rounded-full bg-secondary px-3 py-1.5 text-sm text-secondary-foreground"
            >
              {item.name}
              {item.quantity ? (
                <span className="text-muted-foreground">
                  {' '}
                  {formatNumber(item.quantity, Number.isInteger(item.quantity) ? 0 : 1)}
                  {item.unit ? ` ${item.unit}` : ''}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {shopping.pendingCount > 0 ? (
        <p className="pt-3 text-xs text-muted-foreground">
          {TODAY_RU.shoppingPendingPrefix} {itemCount(shopping.pendingCount)}.
        </p>
      ) : null}
    </WidgetCard>
  );
}
