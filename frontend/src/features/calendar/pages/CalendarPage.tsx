import { CalendarDays } from 'lucide-react';
import { Placeholder } from '@/app/pages/Placeholder';

/**
 * PLACEHOLDER — owned by the `features/calendar` feature agent.
 * Replace the body; keep the file path and the default export.
 */
export default function CalendarPage() {
  return <Placeholder title="Календарь" description="Общие события, дни рождения и напоминания." owner="features/calendar" icon={CalendarDays} />;
}
