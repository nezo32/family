import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/utils';
import { initials } from '@/shared/lib/format';

/**
 * A person, as a coloured disc with their initial (§B4, "the second device").
 *
 * ```
 *  (П)  (М)  (Л)      ← assignee, attendee, contributor, requester, author
 * ```
 *
 * ## Why this exists next to `UserAvatar`
 *
 * `UserAvatar` renders an uploaded photo and falls back to initials on a tint
 * derived from a hash of the id — `oklch(0.88 0.06 <hash>)`, i.e. any of 360
 * hues, most of which are not in this app's palette. On `today-desktop-light`
 * that produced a pink «БН» disc sitting on a sand card. The palette is
 * deliberately kept whole (§B1), so a person's colour has to come *out of it*.
 *
 * This component is the small, identity-only face: five perceptually-spaced
 * ramp colours, one per member, used identically everywhere a human appears —
 * the disc, the day-rail tick, the event bar, the load bars. It is not a
 * replacement for `UserAvatar`; where a photo is the point (the profile screen,
 * the member sheet) `UserAvatar` still wins.
 *
 * ## Departure from §B4, stated rather than smuggled
 *
 * §B4 says `chart-{(sortOrder % 5) + 1}`. `sortOrder` exists only on the
 * **admin** projection of a member (`memberListItemSchema`); `publicUserSchema`
 * — what every screen but Участники actually receives — does not carry it, so
 * a child's client literally cannot compute it. The slot is therefore derived
 * from the user id, which is stable, available everywhere, and gives the same
 * member the same colour on every screen and every device. `sortOrder` is
 * accepted as an override wherever a caller does have it, so an admin screen
 * and a phone still agree.
 *
 * ## Never colour alone (§B4)
 *
 * Every disc carries the member's initial, and every disc has an accessible
 * name. Assume one of the five is colour-blind.
 */

export type MemberSlot = 1 | 2 | 3 | 4 | 5;

/**
 * Static class strings, not `bg-member-${slot}`. Tailwind scans source text: an
 * interpolated class name is never emitted and the disc renders transparent.
 */
const SLOT_CLASS: Record<MemberSlot, string> = {
  1: 'bg-member-1/15 text-member-1',
  2: 'bg-member-2/15 text-member-2',
  3: 'bg-member-3/15 text-member-3',
  4: 'bg-member-4/15 text-member-4',
  5: 'bg-member-5/15 text-member-5',
};

/** The same five colours at full strength, for the 3px day-rail tick (§C3). */
const SLOT_TICK: Record<MemberSlot, string> = {
  1: 'bg-member-1',
  2: 'bg-member-2',
  3: 'bg-member-3',
  4: 'bg-member-4',
  5: 'bg-member-5',
};

/**
 * `id` → one of five slots.
 *
 * A plain sum-of-codepoints hash: the ids are UUIDs, so their characters are
 * already uniformly distributed and anything cleverer buys nothing. What
 * matters is that it is *pure* — the same string must give the same slot in
 * this render, the next render and on somebody else's phone.
 */
export function memberSlot(seed: string | null | undefined, sortOrder?: number | null): MemberSlot {
  if (typeof sortOrder === 'number' && Number.isFinite(sortOrder)) {
    return ((Math.abs(Math.trunc(sortOrder)) % 5) + 1) as MemberSlot;
  }
  if (!seed) return 1;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100_000;
  }
  return ((hash % 5) + 1) as MemberSlot;
}

/** Tailwind classes for a member's 3px rail tick / event bar. */
export function memberTickClass(seed: string | null | undefined, sortOrder?: number | null): string {
  return SLOT_TICK[memberSlot(seed, sortOrder)];
}

const SIZE_CLASS = {
  /** The list default: 24px, next to a 17px row title. */
  sm: 'size-6 text-[10px]',
  /** A row that is about the person — the roster, the approvals queue. */
  md: 'size-8 text-xs',
  /** The picker: five faces across a 390px sheet (§F5). */
  lg: 'size-16 text-xl',
} as const;

export type MemberDiscSize = keyof typeof SIZE_CLASS;

export interface MemberDiscProps {
  /** Stable identity. Falls back to the name when a row carries no id. */
  id?: string | null;
  displayName: string;
  /** Admin projections carry it; everything else derives from `id`. */
  sortOrder?: number | null;
  size?: MemberDiscSize;
  /**
   * Ring highlight for «это вы». Uses `ring-offset` so two overlapping discs in
   * a group still separate.
   */
  highlighted?: boolean;
  /**
   * By default the disc is decorative and the name is next to it in the row.
   * Set this where the disc is the *only* thing naming the person.
   */
  labelled?: boolean;
  className?: string;
}

export function MemberDisc({
  id,
  displayName,
  sortOrder,
  size = 'sm',
  highlighted = false,
  labelled = false,
  className,
}: MemberDiscProps) {
  const slot = memberSlot(id ?? displayName, sortOrder);

  return (
    <span
      data-slot="member-disc"
      data-member-slot={slot}
      {...(labelled ? { role: 'img', 'aria-label': displayName } : { 'aria-hidden': true })}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold select-none',
        SIZE_CLASS[size],
        SLOT_CLASS[slot],
        highlighted && 'ring-2 ring-ring/60 ring-offset-2 ring-offset-background',
        className,
      )}
      title={labelled ? undefined : displayName}
    >
      {initials(displayName)}
    </span>
  );
}

/**
 * Overlapping discs, capped, with «+N» for the rest — «(П)(М) +2».
 *
 * Capped at four by default because a fifth disc at 24px with a −8px overlap
 * stops being five faces and starts being a smear.
 */
export function MemberDiscGroup(props: {
  members: readonly { id?: string | null; displayName: string; sortOrder?: number | null }[];
  max?: number;
  size?: MemberDiscSize;
  className?: string;
}) {
  const max = props.max ?? 4;
  const shown = props.members.slice(0, max);
  const rest = props.members.length - shown.length;
  if (shown.length === 0) return null;

  return (
    <span className={cn('flex items-center -space-x-1.5', props.className)}>
      {shown.map((member, index) => (
        <MemberDisc
          key={member.id ?? `${member.displayName}-${String(index)}`}
          id={member.id ?? null}
          displayName={member.displayName}
          sortOrder={member.sortOrder ?? null}
          size={props.size ?? 'sm'}
          className="ring-2 ring-card"
        />
      ))}
      {rest > 0 ? (
        <span className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-card">
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The 3px tick that hangs a row off the day rail (§C3), in a member's colour or
 * a status colour.
 *
 * Kept here rather than in `day-rail.tsx` because "what colour is a person" is
 * this file's job, and the rail should not have to know.
 */
export function MemberTick(props: {
  /** `null` renders the neutral tick: nobody is assigned yet. */
  seed?: string | null;
  sortOrder?: number | null;
  /** Overrides the member colour: overdue rows lead with `--destructive` (§B4). */
  tone?: 'member' | 'destructive' | 'muted' | 'success';
  className?: string;
  children?: ReactNode;
}) {
  const tone = props.tone ?? 'member';
  const colour =
    tone === 'destructive'
      ? 'bg-destructive'
      : tone === 'success'
        ? 'bg-success'
        : tone === 'muted' || !props.seed
          ? 'bg-border'
          : memberTickClass(props.seed, props.sortOrder);

  return (
    <span
      aria-hidden
      data-slot="member-tick"
      className={cn('w-[3px] shrink-0 self-stretch rounded-full', colour, props.className)}
    />
  );
}
