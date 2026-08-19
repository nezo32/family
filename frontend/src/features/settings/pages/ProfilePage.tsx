import { User } from 'lucide-react';
import { Placeholder } from '@/app/pages/Placeholder';

/**
 * PLACEHOLDER — owned by the `features/settings` feature agent.
 * Replace the body; keep the file path and the default export.
 */
export default function ProfilePage() {
  return (
    <Placeholder
      title="Профиль"
      description="Имя, аватар, часовой пояс."
      owner="features/settings"
      icon={User}
    />
  );
}
