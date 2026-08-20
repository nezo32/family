import { Link } from 'react-router-dom';
import { ROUTES } from '@/shared/lib/routes';
import { Section } from '@/shared/ui/section';
import { MemberTick } from '@/shared/ui/member-disc';
import { TODAY_RU } from '../locale';
import type { DashboardShopping } from '../types';

/** Three rows is the point at which a home screen starts being a shopping list. */
const VISIBLE = 3;

/**
 * «Надо купить» — the urgent lines only (§D1).
 *
 * The full list is one tap away; thirty items on the home screen would turn it
 * into the shopping feature, which it is not. This renders nothing when nothing
 * is urgent — the previous build printed «Срочных покупок нет.» inside a card
 * with an icon and a footer link, which is 130px spent to report an absence.
 *
 * Renders only when the attention slot went to something more urgent (§C2); the
 * page decides that, not this component.
 */
export function ShoppingSection(props: { shopping: DashboardShopping }) {
  const items = props.shopping.urgent;
  if (items.length === 0) return null;

  const shown = items.slice(0, VISIBLE);

  return (
    <Section
      label={TODAY_RU.shoppingTitle}
      count={props.shopping.neededCount > 0 ? props.shopping.neededCount : undefined}
      action={
        <Link
          to={ROUTES.shopping}
          className="rounded-sm underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          ›
        </Link>
      }
    >
      {shown.map((item) => (
        <div
          key={item.id}
          className="flex min-h-14 w-full max-w-row-measure items-center gap-3 px-4 py-1.5"
        >
          {/* Urgent, so the rail is the warning colour — and the word «срочно»
              is on the meta line, because colour is never the only signal. */}
          <MemberTick tone="destructive" className="h-9" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[17px] leading-6 font-medium text-foreground">
              {item.name}
            </span>
            <span className="block truncate text-[13px] leading-[18px] font-medium text-muted-foreground">
              {[TODAY_RU.shoppingUrgent, item.listName].join(' · ')}
            </span>
          </span>
          {/* `quantity` is a decimal string on the wire, never a float (D6's
              sibling rule for `numeric`) — render it verbatim. */}
          {item.quantity ? (
            <span className="shrink-0 text-[13px] leading-[18px] font-medium text-muted-foreground tabular-nums">
              {item.quantity}
              {item.unit ? ` ${item.unit}` : ''}
            </span>
          ) : null}
        </div>
      ))}
    </Section>
  );
}
