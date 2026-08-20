import { Section, type SectionSurface } from '@/shared/ui/section';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { COMMON } from '@/shared/lib/i18n';
import { errorMessageRu } from '@/shared/api/errors-ru';
import { isAnsweredByMe, usePolls, useRoster } from '../hooks';
import { WALL_RU } from '../locale';
import { PollCard } from './PollCard';

/**
 * «Решаем вместе» — the open questions, at the top of the board.
 *
 * ## Why polls are on the board and not in a tab
 *
 * They used to be a parallel surface: a tab on a phone, a side-column panel on
 * a desktop. That is what forced Стена to mount a different component tree per
 * width, and it was the wrong shape anyway. «Куда едем на выходных?» is exactly
 * the kind of thing you pin to the board by the front door — it is a note, and
 * it is the *most* addressed-to-you note the family can leave. Putting it in a
 * tab meant it was invisible on the screen where it needed answering.
 *
 * So an open poll sits above the stream, and a poll the family has finished
 * leaves the board entirely (it turns up in «Что решили»). A board holds what is
 * currently up; it is not an archive.
 *
 * ## Band 2 (§C2)
 *
 * The tinted ground is **not** this component's decision. Стена has exactly one
 * attention block and it is chosen by a fixed precedence — an open poll nobody
 * has answered → a pinned announcement → nothing — so `WallPage` passes the
 * surface in. Two clay blocks stacked is two loud things, which is the failure
 * §C2 exists to prevent.
 *
 * ## Empty is not an empty state
 *
 * A board with no open question is not missing anything, so this renders
 * **nothing at all** rather than an `EmptyState` that would have to invent an
 * invitation. The way to ask the family something is the app bar's one door,
 * which is on screen at every width; a second copy of it inside a section that
 * exists only to say the section is empty is the "same button twice" defect the
 * previous pass flagged and could not fix from inside the panel.
 */
export function PollBoard(props: { surface: SectionSurface }) {
  const roster = useRoster();
  const query = usePolls('open');

  if (query.isPending) {
    return (
      <Section label={WALL_RU.board.pollsLabel} surface={props.surface}>
        <div className="space-y-2 px-4 py-3" aria-hidden>
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-11 w-full rounded-lg" />
          <Skeleton className="h-11 w-full rounded-lg" />
        </div>
      </Section>
    );
  }

  if (query.isError) {
    // Quiet, and never `role="alert"`: a side query that failed must not become
    // the loudest thing on a board that loaded perfectly well.
    return (
      <Section label={WALL_RU.board.pollsLabel} surface="card">
        <div className="flex w-full max-w-row-measure flex-wrap items-center justify-between gap-2 px-4 py-3">
          <p className="min-w-0 text-[15px] leading-[22px] text-muted-foreground">
            {errorMessageRu(query.error)}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            onClick={() => {
              void query.refetch();
            }}
          >
            {COMMON.retry}
          </Button>
        </div>
      </Section>
    );
  }

  const polls = query.data.pages.flatMap((page) => page.items);
  if (polls.length === 0) return null;

  const unanswered = polls.filter((poll) => !isAnsweredByMe(poll)).length;

  return (
    <Section
      label={WALL_RU.board.pollsLabel}
      // The count says how many questions are still waiting on *you*, which is
      // the only number on this screen anybody needs to act on. Absent when
      // there are none, so an answered board is silent rather than "0".
      count={unanswered > 0 ? WALL_RU.polls.needsYou : undefined}
      surface={props.surface}
    >
      {polls.map((poll) => (
        <PollCard key={poll.id} poll={poll} roster={roster} />
      ))}
    </Section>
  );
}
