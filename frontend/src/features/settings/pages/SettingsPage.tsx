import { Settings } from 'lucide-react';
import { Placeholder } from '@/app/pages/Placeholder';

/**
 * PLACEHOLDER — owned by the `features/settings` feature agent.
 * Replace the body; keep the file path and the default export.
 */
export default function SettingsPage() {
  return <Placeholder title="Настройки" description="Профиль, уведомления и способы входа." owner="features/settings" icon={Settings} />;
}
