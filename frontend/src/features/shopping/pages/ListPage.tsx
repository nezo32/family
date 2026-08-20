import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { useLiveScreen } from '@/shared/sync';
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
  useUpdateItem,
  useWakeLock,
} from '../hooks';
import { boughtTail } from '../grouping';
import { AisleList } from '../components/AisleList';
import { FrequentStrip } from '../components/FrequentStrip';
import { EditItemDialog } from '../components/EditItemDialog';
import { ListActionsMenu } from '../components/ListActionsMenu';
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
 * ### Where the composer sits
 *
 * At the **bottom** on phones — that is where the thumb is, and where the
 * keyboard will not cover the list being typed into. Two things make that true
 * rather than merely intended:
 *
 *  - `min-h-app-content` on the page. Without it the page is only as tall as
 *    its content, so on a list with two items the "bottom" of the page was
 *    two-thirds of the way up the screen and the composer floated there with
 *    ~700px of empty background under it.
 *  - the `sticky` offset is the height of the tab bar, not `0`. `bottom-0`
 *    pins to the bottom of the *viewport*, which on a phone is behind the tab
 *    bar; on a list long enough to scroll the composer disappeared under it.
 *
 * It deliberately does **not** carry `pb-safe`. The home indicator is the tab
 * bar's problem — it is the thing physically sitting on it — and `AppShell`
 * has already reserved that inset once. Paying it again here is what put a
 * second 34px band in the middle of the screen.
 */
export default function ListPage() {
  const listId = useActiveListId();
  const { can } = useCan();
  const canWrite = can('shopping:write');

  const sync = useShoppingSync();
  const [shopMode, setShopMode] = useShopMode();
  useWakeLock(shopMode);

  /**
   * Two people in a shop with the same list open is the case the whole change
   * feed was written for (D12), so this screen — and only this screen — asks
   * for the 5-second poll instead of the usual 15. It costs battery, which is
   * why it is opt-in and why it ends when the page unmounts.
   */
  useLiveScreen();

  const navigate = useNavigate();
  /*
   * `includeArchived: true` on purpose. The overview asks for the active lists
   * only, so with the default query an archived list opened from a shared link
   * — or the list you have this second archived from the menu below — resolves
   * to `undefined`, the header falls back to «Покупки» and the menu that just
   * archived it disappears. Reading the superset costs one extra cached query
   * and keeps the screen coherent either side of the tap.
   */
  const lists = useShoppingLists(true);
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
  const updateItem = useUpdateItem(listId ?? '');
  /*
   * The row being corrected, held by id rather than by value: the cache row is
   * the source of truth, so an optimistic patch (or somebody else's edit
   * arriving) is reflected in the open dialog instead of being shadowed by a
   * stale copy taken at the moment the menu was tapped.
   */
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const clearBought = useClearBought(listId ?? '');

  const boughtCount = boughtTail(items).length;
  const editingItem = items.find((row) => row.id === editingItemId) ?? null;

  if (listId === null) {
    return (
      <EmptyState
        icon={ShoppingCart}
        title={SHOPPING_RU.listsEmptyTitle}
        description={SHOPPING_RU.listsEmptyDescription}
        // No list id in the URL: there is no list to fill, so the only useful
        // move is back to the ones that exist.
        action={
          <Button asChild variant="outline" className="h-11">
            <Link to={ROUTES.shopping}>{SHOPPING_RU.backToLists}</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col',
        // Fill the screen so "the bottom of the page" is the bottom of the
        // screen. Phones only — from `md` up there is no tab bar to sit above
        // and the page is a normal document again.
        'min-h-app-content md:min-h-0',
        shopMode && 'text-[1.02rem]',
      )}
    >
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
            {list ? (
              <ListActionsMenu
                list={list}
                onDeleted={() => {
                  // The screen we are standing on no longer exists.
                  void navigate(ROUTES.shopping, { replace: true });
                }}
              />
            ) : null}
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
            /*
              Deliberately `null`, and the one place in the app where that is
              the right answer: §D6 — "Do not render an `EmptyState`
              illustration above a composer that is already the invitation."
              `QuickAddBar` is on screen directly below this, focused and
              waiting; a button here would be a second invitation to do the
              thing the reader is already looking at. Without write access
              there is nothing to offer either.
            */
            action={null}
          />
        ) : (
          <AisleList
            items={items}
            pendingIds={sync.pendingIds}
            shopMode={shopMode}
            canWrite={canWrite}
            onToggle={toggleItem}
            onEdit={(item) => {
              setEditingItemId(item.id);
            }}
            onDelete={(item) => {
              deleteItem.mutate(item.id);
            }}
          />
        )}
      </div>

      {canWrite ? (
        /*
         * Sticky at the bottom of the content column, above the tab bar.
         * `sticky` rather than `fixed`: a fixed element inside an iOS PWA jumps
         * around while the software keyboard animates in, and the shell owns
         * the real fixed chrome.
         *
         * `mt-auto` puts it against the bottom of the (now full-height) column;
         * the sticky offset keeps it there once the list is long enough to
         * scroll underneath it.
         */
        <div className="sticky bottom-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom,0px))] z-20 -mx-4 mt-auto border-t border-border bg-background/95 px-4 pt-3 pb-3 backdrop-blur-sm md:-mx-6 md:bottom-0 md:px-6">
          <QuickAddBar
            catalogue={catalogue}
            onAdd={(drafts) => addItems(drafts)}
            disabled={!canWrite}
          />
        </div>
      ) : null}

      {editingItem ? (
        <EditItemDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditingItemId(null);
          }}
          item={editingItem}
          pending={updateItem.isPending}
          onSave={(body) => {
            setEditingItemId(null);
            updateItem.mutate({ itemId: editingItem.id, body });
          }}
        />
      ) : null}
    </div>
  );
}
