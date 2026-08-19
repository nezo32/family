import type { ReactNode } from 'react';
import type { PublicUser } from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { Button } from '@/shared/ui/button';
import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { TASKS_RU } from '../locale';

/**
 * `assignee: 'me'` is a server-resolved literal, not our own id — the contract
 * is explicit that the client never guesses who it is.
 */
export type AssigneeFilter = { kind: 'all' } | { kind: 'me' } | { kind: 'user'; userId: string };

export interface TaskFilterState {
  assignee: AssigneeFilter;
  category: string | null;
  showDone: boolean;
}

export const DEFAULT_FILTERS: TaskFilterState = {
  assignee: { kind: 'all' },
  category: null,
  showDone: false,
};

function FilterChip(props: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={cn(
        'inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm transition-colors',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        props.active
          ? 'border-primary bg-primary/10 font-medium text-foreground'
          : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}

/**
 * Assignee + category filters.
 *
 * Wraps rather than scrolls horizontally: at 320 px a scrolling filter strip
 * hides half the family behind an invisible affordance, and a page that can be
 * dragged sideways at all feels broken in an installed PWA.
 */
export function TaskFilters(props: {
  value: TaskFilterState;
  onChange: (value: TaskFilterState) => void;
  members: readonly PublicUser[];
  categories: readonly string[];
}) {
  const { scopeFor } = useCan();
  const seesEveryone = scopeFor('task:read') === 'any';
  const { value, onChange } = props;
  const dirty =
    value.assignee.kind !== 'all' || value.category !== null || value.showDone !== false;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label={TASKS_RU.filters.assignee}>
        <FilterChip
          active={value.assignee.kind === 'all'}
          onClick={() => {
            onChange({ ...value, assignee: { kind: 'all' } });
          }}
        >
          {TASKS_RU.filters.everyone}
        </FilterChip>
        <FilterChip
          active={value.assignee.kind === 'me'}
          onClick={() => {
            onChange({ ...value, assignee: { kind: 'me' } });
          }}
        >
          {TASKS_RU.filters.mine}
        </FilterChip>
        {seesEveryone
          ? props.members.map((member) => (
              <FilterChip
                key={member.id}
                active={value.assignee.kind === 'user' && value.assignee.userId === member.id}
                onClick={() => {
                  onChange({ ...value, assignee: { kind: 'user', userId: member.id } });
                }}
              >
                <UserAvatar user={member} size="xs" />
                <span className="max-w-24 truncate">{member.displayName}</span>
              </FilterChip>
            ))
          : null}
      </div>

      {props.categories.length > 0 ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label={TASKS_RU.filters.category}>
          <FilterChip
            active={value.category === null}
            onClick={() => {
              onChange({ ...value, category: null });
            }}
          >
            {TASKS_RU.filters.allCategories}
          </FilterChip>
          {props.categories.map((category) => (
            <FilterChip
              key={category}
              active={value.category === category}
              onClick={() => {
                onChange({ ...value, category });
              }}
            >
              {category}
            </FilterChip>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <FilterChip
          active={value.showDone}
          onClick={() => {
            onChange({ ...value, showDone: !value.showDone });
          }}
        >
          {TASKS_RU.filters.showDone}
        </FilterChip>
        {dirty ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11"
            onClick={() => {
              onChange(DEFAULT_FILTERS);
            }}
          >
            {COMMON.clear}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
