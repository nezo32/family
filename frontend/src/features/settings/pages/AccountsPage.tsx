import { KeyRound } from 'lucide-react';
import { Placeholder } from '@/app/pages/Placeholder';

/**
 * PLACEHOLDER — owned by the `features/settings` feature agent.
 * Replace the body; keep the file path and the default export.
 */
export default function AccountsPage() {
  return <Placeholder title="Способы входа" description="Привязанные аккаунты Google, Apple и Telegram." owner="features/settings" icon={KeyRound} />;
}
