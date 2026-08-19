import { BellRing } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { ROUTES } from '@/shared/lib/routes';
import { usePushHealth } from '../hooks';
import { NOTIFICATIONS_RU } from '../locale';

/**
 * «Уведомления отключились — включить снова?», raised by the **server**.
 *
 * `channels.pushHealthy` from `GET /api/notifications/preferences` is the D11
 * health signal: `pushReady && !pushHealthy` means this user has a live push
 * subscription that has never acknowledged a delivery. The device stopped
 * receiving pushes and nothing about the app looks broken — which is exactly the
 * failure mode D11 exists to catch, and exactly why the flag was computed and
 * sent on every request while nothing in the frontend read it.
 *
 * It complements, rather than duplicates, `PushReEnableCard` in
 * `features/settings/push`: that one fires when *this browser* has lost its
 * subscription object (client-side, reconcile loop), this one fires when the
 * *server* can see that deliveries are going nowhere — including from a device
 * the user is not currently holding.
 *
 * The action is a link to Настройки → Уведомления rather than an inline
 * re-subscribe: the repair needs a fresh user gesture in the push funnel, and
 * that funnel, with its one-shot-permission warning, lives there.
 */
export function PushHealthBanner(props: { onNavigate?: () => void; className?: string }) {
  const health = usePushHealth();
  const navigate = useNavigate();

  if (!health.needsRepair) return null;

  return (
    <Alert className={props.className}>
      <BellRing aria-hidden />
      <AlertTitle>{NOTIFICATIONS_RU.pushUnhealthyTitle}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{NOTIFICATIONS_RU.pushUnhealthyText}</p>
        <Button
          size="sm"
          onClick={() => {
            props.onNavigate?.();
            void navigate(ROUTES.settingsNotifications);
          }}
        >
          {NOTIFICATIONS_RU.pushUnhealthyAction}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
