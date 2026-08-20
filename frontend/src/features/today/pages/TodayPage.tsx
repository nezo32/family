import { useCallback, useMemo } from 'react';
import { Moon, Sun, Sunrise, Sunset } from 'lucide-react';
import type { ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { ErrorState } from '@/shared/components/ErrorState';
import { PageHeader } from '@/shared/components/PageHeader';
import { SideColumn } from '@/app/layout/SideColumn';
import { useCan } from '@/shared/auth/use-can';
import { useMe } from '@/shared/auth/use-me';
import { ROUTES } from '@/shared/lib/routes';
import { formatTime } from '@/shared/lib/format';
import { longDayLabel } from '@/shared/lib/i18n';
import { Section, SectionStack } from '@/shared/ui/section';
import { AttentionBlock, pickAttention } from '../components/AttentionBlock';
import { ApprovalsSection } from '../components/ApprovalsSection';
import { EventsSection } from '../components/EventsSection';
import { FreeDayCard } from '../components/FreeDayCard';
import { GoalSection } from '../components/GoalSection';
import { ShoppingSection } from '../components/ShoppingSection';
import { TaskRow } from '../components/TaskRow';
import { TodaySkeleton } from '../components/TodaySkeleton';
import { WeekStrip } from '../components/WeekStrip';
import { isDayEmpty, useCompleteTask, useToday, useWeek } from '../hooks';
import { TODAY_RU } from '../locale';

/**
 * «Сегодня» — the home screen, composed as the four bands of §C2.
 *
 * ```
 *  1 TITLE      greeting + date            ← app bar on ≥ md, display face below
 *  2 ATTENTION  exactly one block          ← overdue → approvals → urgent shopping
 *  3 BODY       hairline-separated rows    ← Мои дела · Сегодня и завтра · Надо купить
 *  4 QUIET      «Сегодня в семье закрыли…» ← meta, no box
 * ```
 *
 * ## What this replaces, and why
 *
 * The previous version stacked six `WidgetCard`s of near-identical weight and
 * height — 1661px of them on an 844px screen — each with its own icon, its own
 * count and its own «Все задачи ›» footer row. The phrase «Все задачи» appeared
 * **twice on one screen**, ~330px went on footer chrome alone, and because
 * nothing was louder than anything else the three-second question ("does
 * anything need me before I put my shoes on?") was never answered.
 *
 * Three rules do the work:
 *
 *  1. **One loud thing.** `pickAttention` chooses a single block for the tinted
 *     ground by a fixed precedence. Everything that loses becomes a quiet
 *     section in band 3 — it does not disappear, it stops shouting.
 *  2. **Rows, not tiles.** `Section` puts the label, the count and the *one*
 *     link outside the surface at `meta` weight, and the surface holds nothing
 *     but hairline-separated rows.
 *  3. **One link per section**, on the header. Never a footer row per card.
 *
 * ## The greeting, at two sizes, from one node
 *
 * `PageHeader` hoists band 1 into `TopAppBar` from `md` up (§C4). The same
 * title node therefore has to be a 28/700 display line on a phone and a 17/600
 * bar title on a desktop — so the responsive classes live on the node itself
 * rather than the page rendering it twice and hiding one copy.
 *
 * ## Permissions
 *
 * Resolved with `useCan()`, never with `role ===` (D4). The server already
 * sends `null` for a section the caller may not read; the client gate is the
 * second lock on the same door, so a backend regression cannot put a rouble
 * figure in front of a child.
 */
export default function TodayPage() {
  const { can, isReady } = useCan();
  const { data: me } = useMe();

  const canReadTasks = can('task:read');
  const canReadEvents = can('event:read');
  const canReadShopping = can('shopping:read');
  const canReadGoals = can('goal:read');
  const canApproveMembers = can('member:approve');

  const today = useToday();
  const week = useWeek(isReady && (canReadTasks || canReadEvents));
  const complete = useCompleteTask();

  const onComplete = useCallback(
    (occurrenceId: string) => {
      complete.mutate(occurrenceId);
    },
    [complete],
  );

  const data = today.data;

  const greeting = useMemo(() => greetingNow(), []);

  const title = (
    <span className="flex items-center gap-2">
      <greeting.Icon className="size-6 shrink-0 text-primary md:size-5" aria-hidden />
      <span
        // 28/700 display on a phone, where this line *is* the page's one
        // display element; 17/600 in the app bar from `md` up, where the same
        // node is portalled into a 56px bar (§B2, §C4).
        className="truncate font-display text-[28px] leading-[34px] font-bold md:text-[17px] md:leading-6 md:font-semibold"
      >
        {me?.user.displayName
          ? `${greeting.text}, ${me.user.displayName.trim().split(/\s+/)[0] ?? ''}`
          : greeting.text}
      </span>
    </span>
  );

  // `isReady` is part of the loading state on purpose: rendering before
  // `/api/me` resolves would flash sections that then disappear.
  if (!isReady || (today.isPending && !data)) return <TodaySkeleton title={title} />;

  if (!data) {
    return (
      <>
        <PageHeader displayTitle title={title} />
        <ErrorState
          error={today.error}
          title={TODAY_RU.errorTitle}
          onRetry={() => void today.refetch()}
        />
      </>
    );
  }

  const { tasks, events } = data;
  const goals = canReadGoals ? data.goals : null;
  const shopping = canReadShopping ? data.shopping : null;
  const approvals = canApproveMembers ? data.pendingApprovals : null;
  const overdue = canReadTasks ? tasks.overdue : [];

  const attention = pickAttention({ overdue, approvals, shopping });
  const dayIsFree = isDayEmpty(data);

  return (
    <>
      <PageHeader displayTitle title={title} description={longDayLabel(dayAnchor(data.today))} />

      <SectionStack>
        {dayIsFree ? <FreeDayCard /> : null}

        {/* Band 2 — at most one, chosen above. */}
        <AttentionBlock
          kind={attention}
          overdue={overdue}
          approvals={approvals}
          shopping={shopping}
          onComplete={onComplete}
        />

        {/* Band 3. */}
        {canReadTasks && !dayIsFree ? (
          <Section
            label={TODAY_RU.tasksTitle}
            count={tasks.dueToday.length > 0 ? tasks.dueToday.length : undefined}
            action={
              <Link
                to={ROUTES.tasks}
                className="rounded-sm underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {TODAY_RU.linkAll} ›
              </Link>
            }
            // Band 4: quiet, meta, no box. The only place the day's closed work
            // is counted — and it counts the *family*, not a person (D5).
            footnote={
              tasks.doneTodayCount > 0 ? TODAY_RU.tasksDoneToday(tasks.doneTodayCount) : undefined
            }
          >
            {tasks.dueToday.length === 0 ? (
              <p className="max-w-row-measure px-4 py-4 text-[15px] leading-[22px] text-muted-foreground">
                {tasks.doneTodayCount > 0 ? TODAY_RU.tasksAllDone : TODAY_RU.tasksFree}
              </p>
            ) : (
              tasks.dueToday.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  canComplete={can('task:complete', task)}
                  onComplete={onComplete}
                />
              ))
            )}
          </Section>
        ) : null}

        {canReadEvents && !dayIsFree ? <EventsSection events={events} /> : null}

        {/* Only when the attention slot went to something more urgent — the
            same list must never be on screen twice. */}
        {shopping && attention !== 'shopping' ? <ShoppingSection shopping={shopping} /> : null}
      </SectionStack>

      {/*
        §C4 for Сегодня: Неделя · Копилка · Заявки. The order here is also the
        phone order, because below 1088px the shell appends this column verbatim
        under the one above — except «Неделя», which is wide-screen enrichment
        and hides itself rather than adding 230px to a phone (see `WeekStrip`).
      */}
      <SideColumn>
        <SectionStack>
          <WeekStrip week={week.data} />
          {goals ? <GoalSection milestone={goals.nearestMilestone} /> : null}
          {approvals && attention !== 'approvals' ? <ApprovalsSection members={approvals} /> : null}
        </SectionStack>
      </SideColumn>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* The greeting                                                                */
/* -------------------------------------------------------------------------- */

/**
 * «Доброе утро» — the first line of the app, every single day.
 *
 * The hour comes from `formatTime(new Date())`, i.e. the **family** timezone,
 * not the device one (D2). A parent on a business trip in Bangkok should be
 * greeted with the family's morning — the same one the clock in the kitchen
 * shows.
 */
function greetingNow(): { text: string; Icon: ComponentType<{ className?: string }> } {
  const hour = Number(formatTime(new Date()).slice(0, 2));
  if (!Number.isFinite(hour)) return { text: TODAY_RU.greetingFallback, Icon: Sun };
  if (hour >= 5 && hour < 12) return { text: TODAY_RU.greetingMorning, Icon: Sunrise };
  if (hour >= 12 && hour < 18) return { text: TODAY_RU.greetingDay, Icon: Sun };
  if (hour >= 18 && hour < 23) return { text: TODAY_RU.greetingEvening, Icon: Sunset };
  return { text: TODAY_RU.greetingNight, Icon: Moon };
}

/**
 * The payload's `today` is a family-local calendar date. Anchoring it at noon
 * UTC before formatting keeps it on the right day in every timezone the family
 * might be reading from — a bare `YYYY-MM-DD` parses as midnight UTC and reads
 * as the previous day west of Greenwich.
 */
function dayAnchor(date: string | undefined): Date {
  return date ? new Date(`${date}T12:00:00Z`) : new Date();
}
