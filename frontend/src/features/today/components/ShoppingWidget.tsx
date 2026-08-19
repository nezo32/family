import { ShoppingCart } from 'lucide-react';
import { ROUTES } from '@/shared/lib/routes';
import { TODAY_RU, itemCount } from '../locale';
import type { DashboardShopping } from '../types';
import { WidgetCard } from './WidgetCard';

/**
 * Only the items somebody marked urgent.
 *
 * The full list is one tap away; thirty items on the home screen would turn it
 * into the shopping feature, which it is not.
 */
export function ShoppingWidget(props: { shopping: DashboardShopping }) {
  const { shopping } = props;

  return (
    <WidgetCard
      title={TODAY_RU.shoppingTitle}
      icon={ShoppingCart}
      meta={shopping.urgentCount > 0 ? itemCount(shopping.urgentCount) : undefined}
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
              {/* `quantity` is a decimal string on the wire, never a float (D6's
                  sibling rule for `numeric`) — render it verbatim. */}
              {item.quantity ? (
                <span className="text-muted-foreground">
                  {' '}
                  {item.quantity}
                  {item.unit ? ` ${item.unit}` : ''}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {shopping.neededCount > 0 ? (
        <p className="pt-3 text-xs text-muted-foreground">
          {TODAY_RU.shoppingNeededPrefix} {itemCount(shopping.neededCount)}.
        </p>
      ) : null}
    </WidgetCard>
  );
}
