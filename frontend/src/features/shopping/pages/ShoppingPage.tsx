import { useState } from 'react';
import { Plus, ShoppingBasket } from 'lucide-react';
import { ArchiveToggle } from '@/shared/components/ArchiveToggle';
import { PageHeader } from '@/shared/components/PageHeader';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { Can } from '@/shared/auth/Can';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { SHOPPING_RU } from '../locale';
import {
  shoppingListPath,
  useActiveListId,
  useCreateList,
  useShoppingLists,
  useShoppingSync,
} from '../hooks';
import { CreateListDialog } from '../components/CreateListDialog';
import { ListCard } from '../components/ListCard';
import { OfflineBanner } from '../components/OfflineBanner';
import ListPage from './ListPage';

/**
 * `/shopping` — the section entry point.
 *
 * With a list selected it renders {@link ListPage}; otherwise the overview
 * below. The delegation exists because the route contract in `app/router.tsx`
 * gives this feature exactly one path and this agent may not edit the shell —
 * see `shoppingListPath()` in `hooks.ts` for the one-line hookup that turns
 * `/shopping/:listId` into a real route.
 */
export default function ShoppingPage() {
  const activeListId = useActiveListId();
  if (activeListId !== null) return <ListPage />;
  return <ShoppingListsOverview />;
}

function ShoppingListsOverview() {
  const [creating, setCreating] = useState(false);
  /**
   * Archived lists are hidden by default — that is the point of archiving — but
   * something has to be able to show them again, or «Убрать в архив» is a
   * one-way door with a friendlier label than «Удалить».
   */
  const [showArchived, setShowArchived] = useState(false);
  const sync = useShoppingSync();
  const createList = useCreateList();
  const { data, isPending, isPlaceholderData, isError, error, refetch } =
    useShoppingLists(showArchived);

  return (
    <>
      <PageHeader
        title={SHOPPING_RU.title}
        description={SHOPPING_RU.subtitle}
        actions={
          <Can perm="shopping:list:manage">
            <Button
              className="min-h-11"
              onClick={() => {
                setCreating(true);
              }}
            >
              <Plus className="size-4" aria-hidden />
              {SHOPPING_RU.newList}
            </Button>
          </Can>
        }
      />

      <OfflineBanner
        className="mb-4"
        online={sync.online}
        pending={sync.pending}
        flushing={sync.flushing}
        onRetry={sync.flushNow}
      />

      {/*
        The filter row (§D5). Right-aligned above the first row — which is
        exactly where §D5 used to forbid it, and the reversal is deliberate:
        this control spent a pass at the bottom of the list, where it is fine
        with a list under it and adrift in the middle of the viewport without
        one. An empty Покупки is the first screen a new family sees.

        Покупки has no scope filter, so the control owns the row on its own and
        keeps its label at every width; on Копилки the same component seats the
        tabs to its left. The component is the only thing that keeps the two
        screens from drifting apart again.

        Not behind `shopping:list:manage`: showing history is a read, and
        `GET /shopping/lists?includeArchived=true` asks for `shopping:read`.
        Gating it here hid the archive from everyone who cannot archive — the
        children and teens who share these lists — while `/shopping/:id` still
        opened an archived list for them by URL.
      */}
      <ArchiveToggle
        className="mb-4"
        expanded={showArchived}
        onToggle={() => {
          setShowArchived((current) => !current);
        }}
        showLabel={SHOPPING_RU.showArchived}
        hideLabel={SHOPPING_RU.hideArchived}
        emptyHint={
          !isPending && !isPlaceholderData && !isError && data.every((list) => !list.isArchived)
            ? SHOPPING_RU.archiveEmpty
            : undefined
        }
      />

      {isPending ? (
        <ul className="space-y-2" aria-busy>
          {[0, 1, 2].map((row) => (
            <li key={row}>
              <Skeleton className="h-18 w-full rounded-xl" />
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
      ) : data.length === 0 ? (
        <EmptyState
          icon={ShoppingBasket}
          title={SHOPPING_RU.listsEmptyTitle}
          description={SHOPPING_RU.listsEmptyDescription}
          action={
            <Can perm="shopping:list:manage">
              <Button
                className="min-h-11"
                onClick={() => {
                  setCreating(true);
                }}
              >
                {SHOPPING_RU.createList}
              </Button>
            </Can>
          }
        />
      ) : (
        <ul className="space-y-2">
          {data.map((list) => (
            <ListCard key={list.id} list={list} to={shoppingListPath(list.id)} />
          ))}
        </ul>
      )}

      <CreateListDialog
        open={creating}
        onOpenChange={setCreating}
        pending={createList.isPending}
        onCreate={(name) => {
          createList.mutate(
            { name },
            {
              onSuccess: () => {
                setCreating(false);
              },
            },
          );
        }}
      />
    </>
  );
}
