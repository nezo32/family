import { Link } from 'react-router-dom';
import { Can } from '@/shared/auth/Can';
import { Button } from '@/shared/ui/button';
import { ROUTES } from '@/shared/lib/routes';
import { Section } from '@/shared/ui/section';
import { TODAY_RU } from '../locale';

/**
 * The «Сегодня свободно 🎉» state.
 *
 * A blank box would read as a failure — "did it not load?" — on the one screen
 * that must never look broken. So the empty day gets its own small
 * celebration: the sage `--surface-calm` wash, and a sentence that gives the
 * day back to the reader rather than nudging them to invent work.
 *
 * **What changed:** it now carries an action. §D of the design makes
 * `EmptyState.action` non-optional for exactly this reason — an empty screen is
 * an invitation, and a screen that only says "there is nothing" leaves a new
 * family member with nowhere to go. The two buttons are `ghost`, not filled:
 * this block is calm by definition and the one filled primary per view (§B4) is
 * not spent on "add something to a day you were told was free".
 *
 * They navigate rather than opening a create sheet in place. The sheet belongs
 * to the section that owns the record — putting a task composer on the home
 * screen is how «Все задачи» ended up on this screen twice.
 */
export function FreeDayCard() {
  return (
    <Section surface="calm" divided={false}>
      <div className="flex w-full max-w-row-measure flex-col gap-3 px-4 py-6">
        <p className="font-display text-[22px] leading-7 font-bold">{TODAY_RU.emptyTitle}</p>
        {/* Left-aligned, not centred: §B2 forbids centring more than two lines,
            and this description is three on a 320px screen. */}
        <p className="max-w-[42ch] text-[15px] leading-[22px] opacity-90">
          {TODAY_RU.emptyDescription}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Can perm="task:create">
            <Button asChild variant="ghost" className="h-11 bg-card/60">
              <Link to={ROUTES.tasks}>{TODAY_RU.emptyAddTask}</Link>
            </Button>
          </Can>
          <Can perm="event:create">
            <Button asChild variant="ghost" className="h-11 bg-card/60">
              <Link to={ROUTES.calendar}>{TODAY_RU.emptyAddEvent}</Link>
            </Button>
          </Can>
        </div>
      </div>
    </Section>
  );
}
