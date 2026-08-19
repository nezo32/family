import { useState } from 'react';
import { Smartphone, TriangleAlert } from 'lucide-react';
import type { PushSubscriptionSummary } from '@family/shared';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { notify } from '@/shared/lib/toast';
import { formatDateTime } from '@/shared/lib/format';
import { SETTINGS_RU } from '../locale';
import { useRemoveSubscription } from '../hooks';

const T = SETTINGS_RU.notifications;

/**
 * «Устройства» — one row per push subscription.
 *
 * The endpoint is never shown or returned: it is a capability URL, and anyone
 * holding it can push to the device (research doc §14). Rows carry only the
 * label, the platform, and the D11 health signals.
 *
 * `isHealthy === false` is the state that matters: the push service kept
 * answering `201` while nothing arrived, and no ack has come back for
 * `maxSendsWithoutAck` sends. Without this line a family member has no way to
 * discover that their phone stopped receiving anything.
 */
export function DeviceList(props: {
  devices: readonly PushSubscriptionSummary[];
  currentEndpoint: string | null;
}) {
  const remove = useRemoveSubscription(props.currentEndpoint);
  const [confirming, setConfirming] = useState<PushSubscriptionSummary | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{T.devicesTitle}</CardTitle>
        <CardDescription>{T.devicesDescription}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {props.devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{T.devicesEmpty}</p>
        ) : (
          props.devices.map((device) => (
            <div
              key={device.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
            >
              <Smartphone className="size-5 shrink-0 text-muted-foreground" aria-hidden />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">
                    {device.deviceLabel ?? platformFromUserAgent(device.userAgent)}
                  </span>
                  {device.isCurrent ? <Badge variant="secondary">{T.deviceCurrent}</Badge> : null}
                  {device.isStandalone ? (
                    <Badge variant="outline">{T.deviceStandalone}</Badge>
                  ) : null}
                  {!device.isHealthy ? (
                    <Badge variant="destructive" className="gap-1">
                      <TriangleAlert className="size-3" aria-hidden />
                      {T.deviceUnhealthy}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {device.lastDeliveredAt
                    ? T.deviceLastSeen(formatDateTime(device.lastDeliveredAt))
                    : T.deviceNeverDelivered}
                </p>
              </div>

              <Button
                variant="outline"
                size="sm"
                disabled={remove.isPending}
                onClick={() => {
                  setConfirming(device);
                }}
              >
                {T.deviceRemove}
              </Button>
            </div>
          ))
        )}
      </CardContent>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={T.deviceRemoveConfirmTitle}
        description={T.deviceRemoveConfirmText}
        confirmLabel={T.deviceRemove}
        onConfirm={() => {
          const device = confirming;
          if (!device) return;
          return remove
            .mutateAsync(device)
            .then(() => {
              notify.success(T.deviceRemoved);
            })
            .catch((error: unknown) => {
              notify.error(error);
            });
        }}
      />
    </Card>
  );
}

/** Fallback label when the device never sent one. Cosmetic only. */
function platformFromUserAgent(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Macintosh/.test(userAgent)) return 'Mac';
  if (/Windows/.test(userAgent)) return 'Windows';
  return 'Устройство';
}
