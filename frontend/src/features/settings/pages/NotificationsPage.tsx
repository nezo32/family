import { BellRing } from 'lucide-react';
import { Placeholder } from '@/app/pages/Placeholder';

/**
 * PLACEHOLDER — owned by the `features/settings` feature agent.
 * Replace the body; keep the file path and the default export.
 */
export default function NotificationsPage() {
  return <Placeholder title="Уведомления" description="Каналы, тихие часы и напоминания." owner="features/settings" icon={BellRing} />;
}
