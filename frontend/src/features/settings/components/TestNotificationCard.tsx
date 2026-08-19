import { Send } from 'lucide-react';
import type { NotificationTestResponse } from '@family/shared';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { notify } from '@/shared/lib/toast';
import { SETTINGS_RU } from '../locale';
import { useSendTestNotification } from '../hooks';

const T = SETTINGS_RU.notifications;

/**
 * «Отправить тестовое уведомление».
 *
 * Research doc §15: on iOS this is the **only** way a family member can find out
 * whether the whole chain — permission, subscription, VAPID, the push service,
 * the service worker — actually works, and it is the single biggest
 * support-ticket deflector in the app.
 *
 * The response is rendered per target rather than as a toast, because "отправили"
 * is exactly the useless answer this button exists to replace: a `201` from
 * Apple means "accepted", not "delivered" (D11).
 */
export function TestNotificationCard() {
  const test = useSendTestNotification();

  const send = () => {
    test.mutate(
      { channel: 'push' },
      {
        onSuccess: (response) => {
          if (response.results.length === 0) notify.warning(T.testNoTargets);
          else if (response.results.some((result) => !result.ok)) notify.warning(T.testFailedSome);
          else notify.success(T.testQueued);
        },
        onError: (error) => {
          notify.error(error);
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{T.testTitle}</CardTitle>
        <CardDescription>{T.testDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button className="h-11" onClick={send} disabled={test.isPending}>
          <Send aria-hidden />
          {test.isPending ? T.testSending : T.testSend}
        </Button>

        {test.data ? <TestResults data={test.data} /> : null}

        <p className="text-xs text-muted-foreground">{T.testHint}</p>
      </CardContent>
    </Card>
  );
}

function TestResults(props: { data: NotificationTestResponse }) {
  if (props.data.results.length === 0) {
    return <p className="text-sm text-muted-foreground">{T.testNoTargets}</p>;
  }
  return (
    <ul className="space-y-1.5">
      {props.data.results.map((result, index) => (
        <li
          key={result.subscriptionId ?? `${result.channel}-${String(index)}`}
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span className="text-muted-foreground">{result.deviceLabel ?? result.channel}</span>
          <Badge variant={result.ok ? 'secondary' : 'destructive'}>
            {result.ok ? T.testResultOk : T.testResultFailed}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
