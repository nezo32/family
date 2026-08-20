import { useCallback, useState } from 'react';
import { BellOff, BellRing, Smartphone, TriangleAlert } from 'lucide-react';
import type { EnableResult } from './push';
import { isEnableFailure } from './enable-report';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { notify } from '@/shared/lib/toast';
import { SETTINGS_RU } from '../locale';
import { usePush } from './use-push';

const T = SETTINGS_RU.push;

/**
 * The same explanation, as something that stays on screen.
 *
 * A toast is the wrong container for «откройте Настройки → Уведомления →
 * Семья»: it is four steps long and it disappears while the user is still
 * reading it. The verbatim error rides along underneath in small type — it is
 * meaningless to the reader and decisive for whoever they forward it to.
 */
export function PushFailureCard(props: { result: EnableResult }) {
  const { outcome, error } = props.result;
  if (!isEnableFailure(outcome)) return null;

  return (
    <Alert variant="destructive" data-testid="push-failure" data-outcome={outcome}>
      <TriangleAlert aria-hidden />
      <AlertTitle>{T.failureTitle[outcome]}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{T.failureHint[outcome]}</p>
        {error ? (
          <p className="font-mono text-xs break-all opacity-80">
            {error.name}: {error.message}
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The permission funnel.
 *
 * `docs/research/ios-pwa-push.md` §13 is the specification, and the single rule
 * everything follows from is: **the OS prompt can be shown once, ever.** If the
 * user taps «Не разрешать» there, `Notification.permission` is permanently
 * `denied` and the only way back is Настройки → Уведомления → Семья, which no
 * family member will ever find on their own.
 *
 * So the OS prompt is never the first thing the user sees. This dialog is —
 * it explains what the notifications are for, it warns that the *next* tap is
 * the irreversible one, and «Не сейчас» leaves the OS prompt unspent so we can
 * ask again next week.
 */
export function PushPrompt(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called from the click handler; must reach `subscribe()` with no await. */
  onAccept: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{T.promptTitle}</AlertDialogTitle>
          <AlertDialogDescription>{T.promptText}</AlertDialogDescription>
        </AlertDialogHeader>

        <Alert>
          <TriangleAlert aria-hidden />
          <AlertDescription>{T.promptWarning}</AlertDescription>
        </Alert>

        <AlertDialogFooter>
          <AlertDialogCancel>{T.promptDecline}</AlertDialogCancel>
          {/*
            This tap is the one that carries the transient activation into
            `pushManager.subscribe()`, so nothing may await in between and
            nothing else may consume it. `onAccept` calls `enable()`
            synchronously; the dialog closes itself through Radix afterwards.
          */}
          <AlertDialogAction
            onClick={() => {
              props.onAccept();
            }}
          >
            {T.promptAccept}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * What we show once the OS prompt has already been spent on "нет".
 *
 * There is no API that can re-ask. The only honest thing to do is name the exact
 * taps that fix it, and offer a re-check button for when the user comes back.
 */
export function PushDeniedCard(props: { onRecheck: () => void }) {
  return (
    <Alert variant="destructive">
      <BellOff aria-hidden />
      <AlertTitle>{T.deniedTitle}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{T.deniedText}</p>
        <div className="space-y-1">
          <p className="font-medium">{T.deniedStepsTitle}</p>
          <ol className="list-decimal space-y-0.5 pl-5">
            {T.deniedSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
        <p className="text-muted-foreground">{T.deniedStepsAndroid}</p>
        <Button variant="outline" className="h-11" onClick={props.onRecheck}>
          {T.deniedRetry}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Push is unavailable because the app is not installed.
 *
 * «Уведомления не работают» with no stated reason is what makes people give up,
 * so this says *why* — in a Safari tab `window.Notification` does not exist at
 * all, and no button we could render would change that.
 */
export function PushInstallCard(props: { iosNonSafari: boolean }) {
  return (
    <Alert>
      <Smartphone aria-hidden />
      <AlertTitle>{T.installTitle}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{T.installText}</p>
        {props.iosNonSafari ? (
          <p className="font-medium">{T.installSafariOnly}</p>
        ) : (
          <ol className="list-decimal space-y-0.5 pl-5">
            {T.installSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * «Уведомления отключились — включить снова?»
 *
 * Raised by the foreground reconcile loop when `getSubscription()` returns
 * `null` while permission is still `granted`. On iOS there is no
 * `pushsubscriptionchange` to repair this silently — a fresh user gesture is the
 * only way back, which is exactly what this button is.
 */
export function PushReEnableCard(props: { onEnable: () => void; busy: boolean }) {
  return (
    <Alert>
      <BellRing aria-hidden />
      <AlertTitle>{T.reEnableTitle}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{T.reEnableText}</p>
        <Button className="h-11" onClick={props.onEnable} disabled={props.busy}>
          {props.busy ? T.enabling : T.reEnableAction}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The whole «Уведомления на этом устройстве» block, state machine included.
 *
 * Order of the branches matters — it is the funnel from the research doc, and
 * each rung explains itself rather than showing a dead button:
 *
 *   unsupported → install hint → denied recovery → re-enable → on/off toggle
 */
export function PushSection() {
  const push = usePush();
  const [promptOpen, setPromptOpen] = useState(false);
  const [failure, setFailure] = useState<EnableResult | null>(null);

  const runEnable = useCallback(() => {
    // Called straight from a click handler. `enable()` is not `async`: it
    // reaches `pushManager.subscribe()` — the one call permitted to consume
    // the tap's transient activation — before it returns its promise.
    void push.enable().then((result) => {
      if (result.outcome === 'enabled') {
        setFailure(null);
        notify.success(T.enabled);
        return;
      }
      if (result.outcome === 'dismissed') {
        // Prompt swiped away without an answer. Nothing spent, nothing to say.
        setFailure(null);
        return;
      }
      // `denied` already has a card of its own below, with the reset steps.
      setFailure(result.outcome === 'denied' ? null : result);
    });
  }, [push]);

  const status = (): string => {
    if (push.availability === 'unsupported') return T.statusUnsupported;
    if (push.availability === 'needs-install') return T.statusNotInstalled;
    if (push.permission === 'denied') return T.statusDenied;
    return push.isEnabled ? T.statusOn : T.statusOff;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{T.sectionTitle}</CardTitle>
        <CardDescription>{status()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {push.availability === 'needs-install' ? (
          <PushInstallCard iosNonSafari={push.iosNonSafari} />
        ) : null}

        {push.availability === 'unsupported' ? (
          <p className="text-sm text-muted-foreground">{T.unsupportedText}</p>
        ) : null}

        {push.availability === 'available' && push.permission === 'denied' ? (
          <PushDeniedCard onRecheck={push.refresh} />
        ) : null}

        {/* Whatever went wrong last, named — and still on screen while the
            user reads the steps it points at. `blocked-in-settings` in
            particular has nothing else to show for it: iOS reports the
            permission as «ещё не спрашивали» throughout. */}
        {failure ? <PushFailureCard result={failure} /> : null}

        {push.needsReEnable ? <PushReEnableCard onEnable={runEnable} busy={push.busy} /> : null}

        {push.availability === 'available' && push.permission !== 'denied' ? (
          <div className="flex flex-wrap items-center gap-2">
            {push.isEnabled ? (
              <Button
                variant="outline"
                className="h-11"
                disabled={push.busy}
                onClick={() => {
                  void push.disable().then((ok) => {
                    if (ok) notify.success(T.disabled);
                  });
                }}
              >
                {push.busy ? T.disabling : T.disable}
              </Button>
            ) : (
              <Button
                className="h-11"
                // `ready` gates on an **active** service worker: `subscribe()`
                // throws `InvalidStateError` against one that is still
                // installing, and awaiting readiness inside the tap can blow
                // the five-second activation window on a cold start.
                disabled={push.busy || !push.ready}
                onClick={() => {
                  // Straight to `subscribe()` once permission is granted, or
                  // once we already know iOS is refusing to prompt — the soft
                  // dialog would be a dead end there (research doc §17).
                  // Otherwise the soft pre-prompt first, always: the OS prompt
                  // is one-shot and must never be the user's first surprise.
                  if (push.permission === 'granted' || push.blockedInSettings) runEnable();
                  else setPromptOpen(true);
                }}
              >
                {push.busy ? T.enabling : T.enable}
              </Button>
            )}
            <span className="text-xs text-muted-foreground">{T.deviceLabelHint}</span>
          </div>
        ) : null}
      </CardContent>

      <PushPrompt open={promptOpen} onOpenChange={setPromptOpen} onAccept={runEnable} />
    </Card>
  );
}
