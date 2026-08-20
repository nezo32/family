import { Section } from '@/shared/ui/section';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { MemberDisc } from '@/shared/ui/member-disc';
import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { errorMessageRu } from '@/shared/api/errors-ru';
import { useKudosTotals } from '../hooks';
import { WALL_RU } from '../locale';
import { BoardComposeInvite } from './BoardCompose';

/**
 * «Спасибо» — the warm corner of the board.
 *
 * ## The one design rule here is negative: nothing may read as a ranking
 *
 * Rows are alphabetical, never sorted by count. There is no place, no medal, no
 * «лидер недели». A member who has been thanked nothing appears in the same
 * list, at the same weight, as everyone else. The chip says **whether** somebody
 * was thanked this month and nothing more — «7 спасибо» beside a name is a
 * scoreboard whatever the heading says, and the family member reading the
 * smaller number learns exactly the wrong thing (D5).
 *
 * That rule holds out loud as well as on screen. The chip's visible text *is*
 * its accessible name, and `received` is never written into a `title`, an
 * `aria-label` or a tooltip anywhere in this file — a weekly-load bar on Семья
 * was once found reading «40 % (своя доля 33 %)» to a screen reader while
 * showing no numbers at all, which handed a blind family member the exact
 * scoreboard the sighted design refused to draw.
 *
 * ## Why this component owns nothing
 *
 * It used to carry the «Сказать спасибо» dialog in its own header, which made
 * it stateful, which is why Стена could not simply render it wherever the
 * layout wanted it. The composer now lives once, at the page level, behind the
 * board's one door (`BoardCompose`); this panel is a pure function of server
 * state and can therefore sit in the side column on a wide screen and at the
 * foot of the board on a phone, as one instance, with no media query and no
 * `useTwoColumn`.
 */
export function KudosPanel() {
  const totals = useKudosTotals();

  const rows = [...(totals.data?.items ?? [])].sort((left, right) =>
    left.displayName.localeCompare(right.displayName, 'ru'),
  );
  const nobodyThankedYet = rows.length > 0 && rows.every((row) => row.received === 0);

  /*
    «Сказать спасибо», not «Спасибо»: the section is already called Спасибо, and
    a heading and its button reading the same word is chrome that repeats (§A3).
  */
  const invite = (
    <BoardComposeInvite
      kind="kudos"
      label={WALL_RU.kudos.give}
      variant="ghost"
      className="h-11 px-2"
    />
  );

  if (totals.isPending) {
    return (
      <Section label={WALL_RU.kudos.title} action={invite} surface="card">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-3" aria-hidden>
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </Section>
    );
  }

  if (totals.isError) {
    return (
      <Section label={WALL_RU.kudos.title} action={invite} surface="card">
        <div className="flex w-full max-w-row-measure flex-wrap items-center justify-between gap-2 px-4 py-3">
          <p className="min-w-0 text-[15px] leading-[22px] text-muted-foreground">
            {errorMessageRu(totals.error)}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            onClick={() => {
              void totals.refetch();
            }}
          >
            {COMMON.retry}
          </Button>
        </div>
      </Section>
    );
  }

  if (rows.length === 0) return null;

  return (
    <Section
      label={WALL_RU.kudos.title}
      action={invite}
      surface="card"
      footnote={nobodyThankedYet ? WALL_RU.kudos.nobodyYet : WALL_RU.kudos.hint}
    >
      {rows.map((row) => (
        <div
          key={row.userId}
          className="flex min-h-14 w-full max-w-row-measure items-center gap-3 px-4 py-2"
        >
          <MemberDisc id={row.userId} displayName={row.displayName} size="md" />
          <span className="min-w-0 flex-1 truncate text-[17px] leading-6 font-medium">
            {row.displayName}
          </span>
          {/*
            Two words, never a number — and the same two words a screen reader
            hears, because the text is the label.
          */}
          <span
            className={cn(
              'shrink-0 rounded-full px-3 py-1 text-[13px] leading-[18px] font-medium',
              row.received > 0
                ? 'bg-surface-calm text-surface-calm-foreground'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {row.received > 0 ? WALL_RU.kudos.receivedSome : WALL_RU.kudos.receivedNone}
          </span>
        </div>
      ))}
    </Section>
  );
}
