import { ShoppingCart } from 'lucide-react';
import { Placeholder } from '@/app/pages/Placeholder';

/**
 * PLACEHOLDER — owned by the `features/shopping` feature agent.
 * Replace the body; keep the file path and the default export.
 */
export default function ShoppingPage() {
  return (
    <Placeholder
      title="Покупки"
      description="Общие списки покупок."
      owner="features/shopping"
      icon={ShoppingCart}
    />
  );
}
