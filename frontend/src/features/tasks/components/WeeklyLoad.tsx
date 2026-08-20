import type { FairnessMember, PublicUser } from '@family/shared';
import { useCan } from '@/shared/auth/use-can';
import { Section } from '@/shared/ui/section';
import { MemberDisc, memberSlot } from '@/shared/ui/member-disc';
import { cn } from '@/shared/lib/utils';
import { TASKS_RU } from '../locale';

/**
 * «Нагрузка за неделю» — the one place the family sees its own distribution of
 * housework (§D2 side column, §D9).
 *
 * This is the component that survived the removal of the score system (D5), and
 * it only survived on terms. What it is: a picture of how one week's work split
 * across the household, so an adult can notice a lopsided week and start a
 * conversation. What it is deliberately **not**:
 *
 * - **No per-person totals.** There used to be «3 · 21 балл» beside every name.
 *   A number attached to a person, printed next to their siblings' numbers, is
 *   a scoreboard whatever the header says — and a child reading a smaller
 *   number next to a bigger one learns they are losing. The bars stayed; the
 *   numbers went, including from the `aria-label`, which used to read out
 *   «Паша: 40 % (своя доля 33 %)» and so handed a screen-reader user the exact
 *   scoreboard the sighted design refuses to draw. It now says «примерно
 *   поровну» / «больше своей доли» / «меньше своей доли» — the same judgement
 *   the bar makes, in words.
 * - **No ranking.** Members are listed alphabetically, never by effort, and
 *   there is no position, medal or arrow. The contract has no `rank` field for
 *   exactly this reason.
 * - **No score.** Nothing here accumulates across weeks. The window resets, and
 *   with it any sense that somebody is "behind".
 *
 * Each row compares one person to **their own fair share** — the tick on their
 * bar, derived from their rotation weight. Two children with different weights
 * can both sit exactly on their mark, and that is the point: the honest
 * question is "is the split about right", not "who did most".
 *
 * The bar is drawn in the member's own ramp colour (§B4), so the same person is
 * the same colour here, on their task rows and on their disc.
 */
export function WeeklyLoad(props: {
  members: readonly FairnessMember[];
  roster: readonly PublicUser[];
  imbalance: number;
}) {
  const { userId } = useCan();

  if (props.members.length === 0) return null;

  const rows = props.members
    .map((member) => ({
      member,
      user: props.roster.find((candidate) => candidate.id === member.userId),
    }))
    .sort((a, b) =>
      (a.user?.displayName ?? a.member.userId).localeCompare(
        b.user?.displayName ?? b.member.userId,
        'ru',
      ),
    );

  const verdict =
    props.imbalance < 0.25
      ? TASKS_RU.load.balanced
      : props.imbalance < 0.6
        ? TASKS_RU.load.slightlyOff
        : TASKS_RU.load.off;

  return (
    <Section label={TASKS_RU.load.title} divided={false} footnote={verdict}>
      <div className="flex max-w-row-measure flex-col gap-4 px-4 py-4">
        {rows.map(({ member, user }) => {
          const actual = Math.max(0, Math.min(1, member.actualShare));
          const fair = Math.max(0, Math.min(1, member.fairShare));
          const name = user?.displayName ?? '—';
          const slot = memberSlot(member.userId);

          return (
            <div key={member.userId} className="flex flex-col gap-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <MemberDisc
                  id={member.userId}
                  displayName={name}
                  highlighted={member.userId === userId}
                />
                <span className="truncate text-[15px] leading-[22px] text-foreground">{name}</span>
              </span>

              <div
                className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`${name}: ${shareVerdict(actual, fair)}`}
              >
                <div
                  className={cn('h-full rounded-full', FILL[slot])}
                  style={{ width: `${String(actual * 100)}%` }}
                />
                {/* The tick is the person's own fair share — the only comparison
                    this component makes, and it is with themselves. */}
                <div
                  aria-hidden
                  className="absolute inset-y-0 w-0.5 bg-foreground/50"
                  style={{ left: `calc(${String(fair * 100)}% - 1px)` }}
                />
              </div>

              {member.coveredForOthers > 0 ? (
                <p className="text-[13px] leading-[18px] font-medium text-muted-foreground">
                  {TASKS_RU.load.covered}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** Static strings, not `bg-member-${n}` — Tailwind never emits an interpolation. */
const FILL = {
  1: 'bg-member-1',
  2: 'bg-member-2',
  3: 'bg-member-3',
  4: 'bg-member-4',
  5: 'bg-member-5',
} as const;

/**
 * The bar, in words, for anyone who cannot see it — and deliberately **not** in
 * numbers. A 10 % band around a person's own fair share is inside the noise of
 * a seven-day window with three chores in it.
 */
function shareVerdict(actual: number, fair: number): string {
  const delta = actual - fair;
  if (Math.abs(delta) <= 0.1) return TASKS_RU.load.aboutRight;
  return delta > 0 ? TASKS_RU.load.aboveShare : TASKS_RU.load.belowShare;
}
