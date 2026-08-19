import { MessageSquareHeart } from 'lucide-react';
import { Placeholder } from '@/app/pages/Placeholder';

/**
 * PLACEHOLDER — owned by the `features/wall` feature agent.
 * Replace the body; keep the file path and the default export.
 */
export default function WallPage() {
  return (
    <Placeholder
      title="Стена"
      description="Объявления, благодарности и обсуждения."
      owner="features/wall"
      icon={MessageSquareHeart}
    />
  );
}
