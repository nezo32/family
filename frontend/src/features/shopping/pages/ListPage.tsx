import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, Eraser, ShoppingCart } from 'lucide-react';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { Can } from '@/shared/auth/Can';
import { useCan } from '@/shared/auth/use-can';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { Switch } from '@/shared/ui/switch';
import { Label } from '@/shared/ui/label';
import { ROUTES } from '@/shared/lib/routes';
import { cn } from '@/shared/lib/utils';
import { SHOPPING_RU } from '../locale';
import {
  useActiveListId,
  useAddItems,
  useCatalogueIndex,
  useClearBought,
  useDeleteItem,
  useFrequentSuggestions,
  useShopMode,
  useShoppingItems,
  useShoppingLists,
  useShoppingSync,
  useToggleItem,
  useWakeLock,
} from '../hooks';
import { boughtTail } from '../grouping';
import { AisleList } from '../components/AisleList';
import { FrequentStrip } from '../components/FrequentStrip';
import { OfflineBanner } from '../components/OfflineBanner';
import { QuickAddBar } from '../components/QuickAddBar';

/**
 * One shopping list — the screen this whole feature exists for.
 *
 * Default-exports a no-props component and reads `:listId` from the route (with
 * a `?list=` fallback), so the shell owner can mount it at `/shopping/:listId`
 * without touching anything here.
 *
 * ### «Я в магазине»
 *
 * A single switch that changes three things at once: 68px rows with 44px ticks,
 * larger type, and a screen wake-lock attempt. It is not a separate screen —
 * losing your place in the list because you flipped a mode is exactly the kind
 * of thing that gets an app deleted.
 *
 * The quick-add box sits at the **bottom** on phones, inside the safe area:
 * that is where the thumb is, and where the keyboard will not cover the list
 * being typed into.
 */
export default function ListPage() {
  const listId = useActiveListId();
  const { can } = useCan();
  const canWrite = can('shopping:write');

  const sync = useShoppingSync();
  const [shopMode, setShopMode] = useShopMode();
  useWakeLock(shopMode);

  const lists = useShoppingLists();
  const list = useMemo(
    () => lists.data?.find((candidate) => candidate.id === listId),
    [lists.data, listId],
  );

  const { data, isPending, isError, error, refetch } = useShoppingItems(listId);
  const items = useMemo(() => data?.items ?? [], [data]);

  const catalogue = useCatalogueIndex();
  const frequent = useFrequentSuggestions(items);
  const addItems = useAddItems(listId ?? '');
  const toggleItem = useToggleItem(listId ?? '');
  const deleteItem = useDeleteItem(listId ?? '');
  const clearBought = useClearBought(listId ?? '');

  const boughtCount = boughtTail(items).length;

  if (listId === null) {
    return (
      <EmptyState
        icon={ShoppingCart}
        title={SHOPPING_RU.listsEmptyTitle}
        description={SHOPPING_RU.listsEmptyDescription}
      />
    );
  }

  return (
    <div className={cn('flex min-h-0 flex-col', shopMode && 'text-[1.02rem]')}>
      <PageHeader
        eyebrow={
          <Link
            to={ROUTES.shopping}
            className="inline-flex min-h-11 items-center gap-1 text-muted-foreground"
          >
            <ChevronLeft className="size-4" aria-hidden />
            {SHOPPING_RU.backToLists}
          </Link>
        }
        title={list?.name ?? SHOPPING_RU.title}
        actions={
          <div className="flex items-center gap-2">
            <Label
              htmlFor="shop-mode"
              className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
            >
              <Switch
                id="shop-mode"
                aria-label={SHOPPING_RU.shopMode}
                checked={shopMode}
                onCheckedChange={setShopMode}
              />
              {SHOPPING_RU.shopMode}
            </Label>
            {boughtCount > 0 ? (
              <Can perm="shopping:list:manage">
                <Button
                  variant="ghost"
                  className="min-h-11"
                  disabled={clearBought.isPending}
                  onClick={() => {
                    clearBought.mutate();
                  }}
                >
                  <Eraser className="size-4" aria-hidden />
                  <span className="sr-only sm:not-sr-only">{SHOPPING_RU.clearBought}</span>
                </Button>
              </Can>
            ) : null}
          </div>
        }
      />

      <OfflineBanner
        className="mb-3"
        online={sync.online}
        pending={sync.pending}
        flushing={sync.flushing}
        onRetry={sync.flushNow}
      />

      {canWrite ? (
        <FrequentStrip
          className="mb-4"
          products={frequent}
          onAdd={(draft) => {
            void addItems([draft]);
          }}
        />
      ) : null}

      <div className="min-h-0 flex-1 pb-4">
        {isPending ? (
          <ul className="space-y-2" aria-busy>
            {[0, 1, 2, 3, 4].map((row) => (
              <li key={row}>
                <Skeleton className="h-14 w-full rounded-xl" />
              </li>
            ))}
          </ul>
        ) : isError ? (
          <ErrorState
            error={error}
            onRetry={() => {
              void refetch();
            }}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={ShoppingCart}
            title={SHOPPING_RU.itemsEmptyTitle}
            description={canWrite ? SHOPPING_RU.itemsEmptyDescription : SHOPPING_RU.noWriteAccess}
          />
        ) : (
          <AisleList
            items={items}
            pendingIds={sync.pendingIds}
            shopMode={shopMode}
            canWrite={canWrite}
            onToggle={toggleItem}
            onDelete={(item) => {
              deleteItem.mutate(item.id);
            }}
          />
        )}
      </div>

      {canWrite ? (
        /*
         * Sticky at the bottom of the content column, above the tab bar and
         * clear of the home indicator. `sticky` rather than `fixed`: a fixed
         * element inside an iOS PWA jumps around while the software keyboard
         * animates in, and the shell owns the real fixed chrome.
         */
        <div className="sticky bottom-0 z-20 -mx-4 border-t border-border bg-background/95 px-4 pt-3 pb-safe backdrop-blur-sm md:-mx-6 md:px-6">
          <QuickAddBar
            catalogue={catalogue}
            onAdd={(drafts) => addItems(drafts)}
            disabled={!canWrite}
          />
        </div>
      ) : null}
    </div>
  );
}
