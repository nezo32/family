import type { ProductSuggestion } from '@family/shared';
import { Plus } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { SHOPPING_RU } from '../locale';
import type { ItemDraft } from '../grouping';

/**
 * «Часто покупаем» — one tap adds the thing, no typing, no dialog.
 *
 * Ranked by the family's own `usage_count`; there is no external product
 * database anywhere in this app (D9), so every chip here is something this
 * household has actually bought before.
 *
 * The strip scrolls horizontally **inside itself**. The negative margin plus
 * matching padding lets the chips bleed to the screen edge (so the last one is
 * visibly cut off, which is what tells a thumb there is more) while the page
 * body still never scrolls sideways at 320px.
 */
export function FrequentStrip(props: {
  products: readonly ProductSuggestion[];
  disabled?: boolean;
  onAdd: (draft: ItemDraft) => void;
  className?: string;
}) {
  if (props.products.length === 0) return null;

  return (
    <section className={cn('min-w-0', props.className)} aria-label={SHOPPING_RU.frequent}>
      <h2 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {SHOPPING_RU.frequent}
      </h2>
      <ul
        data-scroll-pane
        className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:-mx-6 md:px-6 [&::-webkit-scrollbar]:hidden"
      >
        {props.products.map((product) => (
          <li key={product.id} className="snap-start">
            <button
              type="button"
              disabled={props.disabled}
              onClick={() => {
                props.onAdd({
                  name: product.name,
                  quantity: null,
                  unit: product.defaultUnit,
                  category: product.defaultCategory,
                  note: null,
                  isUrgent: false,
                });
              }}
              className={cn(
                'flex min-h-11 items-center gap-1.5 rounded-full border border-input bg-card px-3.5',
                'text-sm whitespace-nowrap text-foreground no-callout',
                'touch-manipulation disabled:opacity-50',
              )}
            >
              <Plus className="size-4 shrink-0 text-primary" aria-hidden />
              {product.name}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
