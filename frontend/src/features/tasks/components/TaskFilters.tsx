import { useState } from 'react';
import { Check, SlidersHorizontal } from 'lucide-react';
import type { PublicUser } from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { Button } from '@/shared/ui/button';
import { Switch } from '@/shared/ui/switch';
import { Section } from '@/shared/ui/section';
import { ValueRow } from '@/shared/ui/value-row';
import { ResponsiveDialog } from '@/shared/ui/responsive-dialog';
import { MemberDisc } from '@/shared/ui/member-disc';
import { cn } from '@/shared/lib/utils';
import { TASKS_RU } from '../locale';
import { DEFAULT_FILTERS, type TaskFilterState } from '../filters';

/**
 * Filters are not content, and they must not be the first 200px of the screen
 * (§D2).
 *
 * The phone screen used to open with a full-width clay button and **twelve
 * filter chips across four wrapped rows** — 2232px of page, of which the reader
 * saw a wall of pills before a single chore. Two things replace it:
 *
 *  - `TaskScopeBar` — a `Мои / Все` segmented control, which is the only filter
 *    anybody touches daily, plus **one** «Фильтры · N» row that opens a sheet.
 *    The count on that row is the discoverability: it is how you know a filter
 *    is on without the filters being on screen.
 *  - `TaskFilterPanel` — the same controls expanded as a real panel in the side
 *    column from 1088px up, which is the one place twelve chips are fine
 *    (§C4). Below that width the panel hides rather than collapsing to the
 *    bottom of the page: filters that sit *under* the list they filter are
 *    worse than no filters.
 */

/** Facets beyond the segmented control — what «Фильтры · N» is counting. */
export function activeFilterCount(value: TaskFilterState): number {
  let count = 0;
  if (value.assignee.kind === 'user') count += 1;
  if (value.category !== null) count += 1;
  if (value.showDone) count += 1;
  return count;
}

/* -------------------------------------------------------------------------- */
/* Phone / main column                                                         */
/* -------------------------------------------------------------------------- */

export function TaskScopeBar(props: {
  value: TaskFilterState;
  onChange: (value: TaskFilterState) => void;
  members: readonly PublicUser[];
  categories: readonly string[];
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const active = activeFilterCount(props.value);
  const scoped = props.value.assignee.kind === 'user';

  return (
    <>
      <div className="flex max-w-row-measure items-center gap-3">
        {/*
          Two options, one row, 44px, never wraps (§F5). A person picked in the
          sheet leaves both segments unselected rather than lying about which
          one is on — the «Фильтры · 1» row beside it is what says who.
        */}
        <div
          role="radiogroup"
          aria-label={TASKS_RU.filters.assignee}
          className="flex h-11 w-fit shrink-0 items-center gap-1 rounded-lg bg-muted p-1"
        >
          <ScopeButton
            selected={!scoped && props.value.assignee.kind === 'me'}
            label={TASKS_RU.filters.mine}
            onClick={() => {
              props.onChange({ ...props.value, assignee: { kind: 'me' } });
            }}
          />
          <ScopeButton
            selected={!scoped && props.value.assignee.kind === 'all'}
            label={TASKS_RU.filters.everyone}
            onClick={() => {
              props.onChange({ ...props.value, assignee: { kind: 'all' } });
            }}
          />
        </div>

        <Button
          type="button"
          variant="ghost"
          className="ms-auto h-11 shrink-0 gap-2 text-muted-foreground min-[1088px]:hidden"
          onClick={() => {
            setSheetOpen(true);
          }}
        >
          <SlidersHorizontal className="size-4" aria-hidden />
          {TASKS_RU.filters.title}
          {active > 0 ? (
            <span className="flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[13px] leading-[18px] font-semibold text-primary-foreground tabular-nums">
              {active}
            </span>
          ) : null}
        </Button>
      </div>

      <ResponsiveDialog
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        size="tall"
        title={TASKS_RU.filters.title}
        footer={
          <>
            <Button
              variant="ghost"
              className="h-11"
              onClick={() => {
                props.onChange(DEFAULT_FILTERS);
              }}
            >
              {TASKS_RU.filters.reset}
            </Button>
            <Button
              className="h-11"
              onClick={() => {
                setSheetOpen(false);
              }}
            >
              {TASKS_RU.filters.apply}
            </Button>
          </>
        }
      >
        <FilterFacets {...props} />
      </ResponsiveDialog>
    </>
  );
}

function ScopeButton(props: { selected: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      onClick={props.onClick}
      className={cn(
        'flex h-9 min-w-16 items-center justify-center rounded-md px-3 text-[15px] leading-[22px] transition-colors',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        props.selected
          ? 'bg-card font-medium text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {props.label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Desktop side column                                                         */
/* -------------------------------------------------------------------------- */

export function TaskFilterPanel(props: {
  value: TaskFilterState;
  onChange: (value: TaskFilterState) => void;
  members: readonly PublicUser[];
  categories: readonly string[];
}) {
  return (
    <div className="hidden min-[1088px]:block">
      <Section
        label={TASKS_RU.filters.title}
        action={
          activeFilterCount(props.value) > 0 ? (
            <button
              type="button"
              className="rounded-sm underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              onClick={() => {
                props.onChange(DEFAULT_FILTERS);
              }}
            >
              {TASKS_RU.filters.reset}
            </button>
          ) : undefined
        }
      >
        <FilterFacets {...props} />
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The facets themselves — one implementation, two containers                  */
/* -------------------------------------------------------------------------- */

function FilterFacets(props: {
  value: TaskFilterState;
  onChange: (value: TaskFilterState) => void;
  members: readonly PublicUser[];
  categories: readonly string[];
}) {
  const { scopeFor } = useCan();
  const seesEveryone = scopeFor('task:read') === 'any';
  const { value, onChange } = props;

  return (
    <div className="flex flex-col">
      {seesEveryone && props.members.length > 0 ? (
        <>
          <FacetLabel>{TASKS_RU.filters.assignee}</FacetLabel>
          <OptionRow
            label={TASKS_RU.filters.everyone}
            selected={value.assignee.kind !== 'user'}
            onSelect={() => {
              onChange({ ...value, assignee: { kind: 'all' } });
            }}
          />
          {props.members.map((member) => (
            <OptionRow
              key={member.id}
              label={member.displayName}
              icon={<MemberDisc id={member.id} displayName={member.displayName} />}
              selected={value.assignee.kind === 'user' && value.assignee.userId === member.id}
              onSelect={() => {
                onChange({ ...value, assignee: { kind: 'user', userId: member.id } });
              }}
            />
          ))}
        </>
      ) : null}

      {props.categories.length > 0 ? (
        <>
          <FacetLabel>{TASKS_RU.filters.category}</FacetLabel>
          <OptionRow
            label={TASKS_RU.filters.allCategories}
            selected={value.category === null}
            onSelect={() => {
              onChange({ ...value, category: null });
            }}
          />
          {props.categories.map((category) => (
            <OptionRow
              key={category}
              label={category}
              selected={value.category === category}
              onSelect={() => {
                onChange({ ...value, category });
              }}
            />
          ))}
        </>
      ) : null}

      <ValueRow
        label={TASKS_RU.filters.showDone}
        trailing={
          <Switch
            checked={value.showDone}
            aria-label={TASKS_RU.filters.showDone}
            onCheckedChange={(checked) => {
              onChange({ ...value, showDone: checked });
            }}
          />
        }
      />
    </div>
  );
}

function FacetLabel(props: { children: React.ReactNode }) {
  return (
    <p className="px-4 pt-4 pb-1 text-[12px] leading-4 font-semibold tracking-[0.06em] text-muted-foreground uppercase">
      {props.children}
    </p>
  );
}

/**
 * A radio row, not a chip. A 2-column grid of variable-length Russian labels
 * produces ragged rows — «Никто — возьмёт любой» is two lines tall next to a
 * one-line «Павел» — and the whole set then reads as an undifferentiated field
 * of pills with no signal about what is selected (§F5).
 */
function OptionRow(props: {
  label: string;
  icon?: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <ValueRow
      label={props.label}
      icon={props.icon}
      onClick={props.onSelect}
      trailing={
        props.selected ? (
          <Check className="size-5 text-primary" aria-hidden />
        ) : (
          <span className="size-5" aria-hidden />
        )
      }
      linkProps={{ role: 'radio', 'aria-checked': props.selected }}
    />
  );
}
