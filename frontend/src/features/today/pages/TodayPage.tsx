import { Sun } from 'lucide-react';
import { Placeholder } from '@/app/pages/Placeholder';

/**
 * PLACEHOLDER — owned by the `features/today` feature agent.
 * Replace the body; keep the file path and the default export.
 */
export default function TodayPage() {
  return (
    <Placeholder
      title="Сегодня"
      description="Дела, события и напоминания на сегодня."
      owner="features/today"
      icon={Sun}
    />
  );
}
