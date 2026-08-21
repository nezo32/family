import { useMemo, useState } from 'react';
import { PiggyBank, Plus } from 'lucide-react';
import { SideColumn } from '@/app/layout/SideColumn';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { Section, SectionStack } from '@/shared/ui/section';
import { ArchiveToggle } from '@/shared/components/ArchiveToggle';
import { EmptyState } from '@/shared/components/EmptyState';
import { ErrorState } from '@/shared/components/ErrorState';
import { PageHeader } from '@/shared/components/PageHeader';
import { formatMoney } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { GOALS_RU, activeCountLabel, reachedCountLabel } from '../locale';
import type { GoalScope } from '../api';
import { groupGoals } from '../grouping';
import { useGoalAbilities, useGoals, useRoster } from '../hooks';
import { GoalCard } from '../components/GoalCard';
import { GoalFormDialog } from '../components/GoalFormDialog';

/**
 * «Копилки» — the goal list (§D4).
 *
 * **What the user came for:** "how close are we."
 *
 * ## What changed
 *
 * Rows instead of cards. The old grid gave three cards 570 of 900px of height
 * and each of them carried two indicators for one number — a percentage ring at
 * the top-left and a progress bar glued to the bottom edge — with «Пополнить»
 * floating at a different height in every card because the titles wrapped
 * differently. Five goals now read as one object with five bars down a single
 * left edge.
 *
 * The «Накоплено» figure is the screen's **one** display element (§B2: max one
 * per screen). It is the answer to the question the screen exists for, so it
 * goes first on a phone and into the side column on a desktop, where §C4 puts
 * the summary. Those are two renders of one block with one hidden at each
 * width, rather than a single instance in a slot that is right at one size and
 * wrong at the other — the block is static, has no state, and the hidden copy
 * leaves the accessibility tree with `display: none`.
 *
 * Reached goals drop to a `--surface-calm` group under «Собрано»: finished work
 * stays visible without competing with the goals still being saved for. An
 * archived goal gets the same treatment under «В архиве» — it used to be listed
 * and counted under «Копим», so two live goals and one archived one read as
 * «КОПИМ 3» and «3 цели в работе». The archive is history: `groupGoals` keeps it
 * out of every count and out of «Накоплено», so the display figure does not move
 * when the archive is revealed.
 *
 * «Показать архив» rides the **filter row**, right-aligned opposite the scope
 * tabs, and it is the *same component* Покупки renders — the only thing that
 * keeps the two screens from drifting apart again. It used to sit at the bottom
 * of the list, which is fine while there is a list and adrift in the middle of
 * an empty viewport when there is not. See `shared/components/ArchiveToggle.tsx`.
 *
 * Access is decided entirely by `useCan()` (D4): a child holds no `goal:*`
 * permission and never reaches this route, a teen holds `goal:read` only and so
 * sees every row with no write affordance at all. Nothing here branches on
 * `role`.
 */
export default function GoalsPage() {
  const [scope, setScope] = useState<GoalScope>('all');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const abilities = useGoalAbilities();
  const { byId: roster } = useRoster();
  const { data, isPending, isPlaceholderData, isError, error, refetch } = useGoals({
    scope,
    includeArchived,
  });

  const goals = useMemo(() => data?.items ?? [], [data]);
  const { open, reached, archived, summarised, totalSaved } = useMemo(
    () => groupGoals(goals),
    [goals],
  );

  const createButton = abilities.canCreate ? (
    <Button
      className="h-11"
      onClick={() => {
        setCreateOpen(true);
      }}
    >
      <Plus className="size-4" aria-hidden />
      {GOALS_RU.createGoal}
    </Button>
  ) : null;

  // Counted from the live goals only: revealing history must not move the
  // figure the screen exists to answer.
  const summary =
    summarised.length > 0 ? (
      <Section label={GOALS_RU.summarySaved} divided={false} surface="none" bodyClassName="px-4">
        <p className="font-display text-[28px] leading-[34px] font-bold text-foreground tabular-nums">
          {formatMoney(totalSaved)}
        </p>
        <p className="text-[13px] leading-[18px] font-medium text-muted-foreground">
          {[
            activeCountLabel(open.length),
            reached.length > 0 ? reachedCountLabel(reached.length) : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' · ')}
        </p>
      </Section>
    ) : null;

  return (
    <>
      <PageHeader title={GOALS_RU.title} actions={createButton} />

      <div className="flex flex-col gap-6">
        {/* Phone: the display figure leads, because it is the answer. */}
        {summary ? <div className="min-[1088px]:hidden">{summary}</div> : null}

        {/* The filter row: scope tabs on the left, «Показать архив» right-
            aligned opposite them (§D5). One row, one component — the same one
            Покупки renders. */}
        <ArchiveToggle
          tabs={<ScopeBar value={scope} onChange={setScope} />}
          expanded={includeArchived}
          onToggle={() => {
            setIncludeArchived((value) => !value);
          }}
          showLabel={GOALS_RU.showArchived}
          hideLabel={GOALS_RU.hideArchived}
          // Only once the wider query has actually answered: while the old
          // list is still on screen the archive is not empty, it is unknown.
          emptyHint={
            archived.length === 0 && !isPending && !isPlaceholderData && !isError
              ? GOALS_RU.archiveEmpty
              : undefined
          }
        />

        {isPending ? (
          <GoalListSkeleton />
        ) : isError ? (
          <ErrorState
            error={error}
            onRetry={() => {
              void refetch();
            }}
          />
        ) : goals.length === 0 ? (
          <EmptyState
            icon={PiggyBank}
            title={scope === 'all' ? GOALS_RU.emptyTitle : GOALS_RU.emptyFiltered}
            description={
              scope !== 'all'
                ? GOALS_RU.emptyFilteredDescription
                : abilities.canCreate
                  ? GOALS_RU.emptyDescription
                  : GOALS_RU.emptyReadOnlyDescription
            }
            action={createButton}
          />
        ) : (
          <SectionStack>
            {open.length > 0 ? (
              <Section label={GOALS_RU.groupOpen} count={open.length}>
                {open.map((goal) => (
                  <GoalCard key={goal.id} goal={goal} roster={roster} />
                ))}
              </Section>
            ) : null}

            {reached.length > 0 ? (
              <Section label={GOALS_RU.groupReached} count={reached.length} surface="calm">
                {reached.map((goal) => (
                  <GoalCard key={goal.id} goal={goal} roster={roster} />
                ))}
              </Section>
            ) : null}

            {/* Its own group, on the calm ground «Собрано» uses: a goal that is
                put away is not one the family is saving for, and it used to be
                rendered and counted under «Копим». */}
            {archived.length > 0 ? (
              <Section label={GOALS_RU.groupArchived} count={archived.length} surface="calm">
                {archived.map((goal) => (
                  <GoalCard key={goal.id} goal={goal} roster={roster} />
                ))}
              </Section>
            ) : null}
          </SectionStack>
        )}
      </div>

      {/* §C4: Сводка. Desktop only — on a phone it is already at the top,
          which is where a display figure that answers the screen belongs. */}
      <SideColumn>
        {summary ? <div className="hidden min-[1088px]:block">{summary}</div> : null}
      </SideColumn>

      {abilities.canCreate ? (
        <GoalFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
    </>
  );
}

/**
 * Все / Семейные / Мои — three short, mutually-exclusive options used daily,
 * which is exactly the case §F5 keeps as a single-row segmented control. It
 * never wraps.
 */
function ScopeBar(props: { value: GoalScope; onChange: (value: GoalScope) => void }) {
  const options: { value: GoalScope; label: string }[] = [
    { value: 'all', label: GOALS_RU.scopeAll },
    { value: 'family', label: GOALS_RU.scopeFamily },
    { value: 'mine', label: GOALS_RU.scopeMine },
  ];

  return (
    <div
      role="radiogroup"
      aria-label={GOALS_RU.title}
      className="flex h-11 w-fit items-center gap-1 rounded-lg bg-muted p-1"
    >
      {options.map((option) => {
        const selected = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              props.onChange(option.value);
            }}
            className={cn(
              'flex h-9 items-center justify-center rounded-md px-3 text-[15px] leading-[22px] transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
              selected
                ? 'bg-card font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Rows at 76px — the geometry `GoalCard` actually produces, title + bar + meta. */
function GoalListSkeleton() {
  return (
    <div className="flex flex-col" aria-hidden>
      <div className="flex items-center justify-between px-4 pb-2">
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="max-w-row-measure overflow-hidden rounded-xl border border-border bg-card">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center gap-3">
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-10 shrink-0" />
            </div>
            <Skeleton className="h-1.5 w-full rounded-full" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        ))}
      </div>
    </div>
  );
}
