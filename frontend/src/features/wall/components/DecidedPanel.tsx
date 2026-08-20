import { Section } from '@/shared/ui/section';
import { ValueRow } from '@/shared/ui/value-row';
import { decidedOption, usePolls } from '../hooks';
import { WALL_RU } from '../locale';

/** Family memory, not an archive browser: the last few questions we settled. */
const SHOWN = 5;

/**
 * «Что решили» — the questions the family has finished with.
 *
 * A closed poll leaves the board, because a board holds what is currently up.
 * But «мы же решили ехать на дачу» is a real conversation, so the decisions
 * stay one glance away in the side column, as rows that state the answer rather
 * than as cards that re-litigate it: no bars, no options, no percentages, no
 * comments. The question and what we decided.
 *
 * A tie is reported as a tie (`decidedOption` returns `null` when two options
 * are level at the top) rather than resolved by array order. «Решили: на дачу»
 * when half the family said «в город» is the kind of quiet lie a family app
 * cannot afford.
 *
 * ## Empty, loading and failed all render nothing, deliberately
 *
 * There is no invitation this panel could offer — the way to create a poll is
 * the board's one door, and a second copy of it under a heading that exists
 * only to say the heading is empty is the "same button twice" defect. And
 * nothing here is actionable: a retry row for a retrospective list nobody asked
 * for is chrome on a board that loaded perfectly well. So the rule for this
 * screen is: **a panel that cannot say what to do next does not render.**
 */
export function DecidedPanel() {
  const query = usePolls('closed');

  const polls = (query.data?.pages.flatMap((page) => page.items) ?? []).slice(0, SHOWN);
  if (polls.length === 0) return null;

  return (
    <Section label={WALL_RU.polls.decidedLabel} surface="card">
      {polls.map((poll) => {
        const decided = decidedOption(poll);
        return (
          <ValueRow
            key={poll.id}
            label={poll.question}
            hint={decided ? WALL_RU.polls.decidedOn(decided.label) : WALL_RU.polls.decidedTie}
          />
        );
      })}
    </Section>
  );
}
