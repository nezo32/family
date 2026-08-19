import { Moon, Sun, Sunrise, Sunset } from 'lucide-react';
import type { ComponentType } from 'react';
import { PageHeader } from '@/shared/components/PageHeader';
import { formatTime } from '@/shared/lib/format';
import { longDayLabel } from '@/shared/lib/i18n';
import { TODAY_RU, eventCount, taskCount } from '../locale';

/**
 * «Доброе утро, Паша» — the first line of the app, every single day.
 *
 * Two details that matter more than they look:
 *
 *  - The hour comes from `formatTime(new Date())`, i.e. the **family**
 *    timezone, not the device one (D2). A parent on a business trip in Bangkok
 *    should be greeted with the family's morning, the same one the clock in the
 *    kitchen shows.
 *  - The name is the first word of `displayName`. «Доброе утро, Павел
 *    Иванович» is a bank, not a home.
 */
export function GreetingHeader(props: {
  displayName: string | undefined;
  /** The payload's `today`, `YYYY-MM-DD` in the caller's timezone. */
  date: string | undefined;
  tasks: number;
  events: number;
}) {
  const { greeting, Icon } = greetingNow();
  const firstName = props.displayName?.trim().split(/\s+/)[0];

  const summary = [
    props.tasks > 0 ? taskCount(props.tasks) : null,
    props.events > 0 ? eventCount(props.events) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <PageHeader
      title={
        <span className="flex items-center gap-2">
          <Icon className="size-6 shrink-0 text-primary" aria-hidden />
          <span className="truncate">{firstName ? `${greeting}, ${firstName}` : greeting}</span>
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-x-2">
          <span className="first-letter:uppercase">{dayText(props.date)}</span>
          {summary ? <span aria-hidden>·</span> : null}
          {summary ? <span>{summary}</span> : null}
        </span>
      }
    />
  );
}

function greetingNow(): { greeting: string; Icon: ComponentType<{ className?: string }> } {
  const hour = Number(formatTime(new Date()).slice(0, 2));
  if (!Number.isFinite(hour)) return { greeting: TODAY_RU.greetingFallback, Icon: Sun };
  if (hour >= 5 && hour < 12) return { greeting: TODAY_RU.greetingMorning, Icon: Sunrise };
  if (hour >= 12 && hour < 18) return { greeting: TODAY_RU.greetingDay, Icon: Sun };
  if (hour >= 18 && hour < 23) return { greeting: TODAY_RU.greetingEvening, Icon: Sunset };
  return { greeting: TODAY_RU.greetingNight, Icon: Moon };
}

/**
 * The payload's date is a family-local calendar date. Anchoring it at noon UTC
 * before formatting keeps it on the right day in every timezone the family
 * might be reading from.
 */
function dayText(date: string | undefined): string {
  return longDayLabel(date ? new Date(`${date}T12:00:00Z`) : new Date());
}
