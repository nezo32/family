import { Users } from 'lucide-react';
import { Placeholder } from '@/app/pages/Placeholder';

/**
 * PLACEHOLDER — owned by the `features/family` feature agent.
 * Replace the body; keep the file path and the default export.
 */
export default function FamilyPage() {
  return (
    <Placeholder
      title="Семья"
      description="Участники, роли и нагрузка на этой неделе."
      owner="features/family"
      icon={Users}
    />
  );
}
