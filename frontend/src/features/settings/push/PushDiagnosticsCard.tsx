import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, RefreshCw, Stethoscope } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/shared/ui/alert';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { Skeleton } from '@/shared/ui/skeleton';
import { cn } from '@/shared/lib/utils';
import { notify } from '@/shared/lib/toast';
import { SETTINGS_RU } from '../locale';
import {
  collectPushDiagnostics,
  formatPushDiagnostics,
  pushVerdict,
  type PushDiagnostics,
  type PushVerdict,
} from './diagnostics';
import { onPushReadinessChange, pushReadiness, registrationSnapshot } from './push';

const T = SETTINGS_RU.diagnostics;

/**
 * What the card considers "the worker moved".
 *
 * `readyResolved` is in the key as well as the readiness word because
 * `serviceWorker.ready` can settle a microtask *after* the registration
 * arrives from `onRegisteredSW` — same readiness, different row — and that row
 * reading «нет» next to «готова» is exactly the kind of self-contradiction that
 * makes a reader distrust the whole screen.
 */
function readinessKey(): string {
  return `${pushReadiness()}:${String(registrationSnapshot().readyResolved)}`;
}

/**
 * «Диагностика уведомлений» — the instrument, on the device.
 *
 * ## Why this is a screen and not a log line
 *
 * Web Push on iOS fails on exactly one person's phone at a time, and none of
 * the preconditions are observable from anywhere else: not from a desktop
 * browser, not from CI, not from the server. The only way to find out which
 * gate is shut is to render the answer where the person holding the broken
 * phone can read it out.
 *
 * So every row is one precondition, in the order the platform enforces them,
 * phrased as something a non-technical reader can check off. The verdict at the
 * top names the *first* one that failed, because fourteen ticks and one cross
 * is still a wall of text.
 *
 * ## Three rules this component keeps
 *
 * 1. **The last error is shown verbatim.** `name` and `message`, untranslated,
 *    in a monospace block. A friendly paraphrase is what got us here: a
 *    `NotAllowedError` (lost user gesture), an `AbortError` (push service
 *    refused the key) and a `403` from our own API all reached the user as
 *    «Не удалось включить уведомления».
 * 2. **It degrades instead of breaking.** In a plain browser tab, in headless
 *    Playwright, in jsdom, none of `Notification` / `PushManager` /
 *    `serviceWorker` exist. That is a *finding*, and the card says so; it must
 *    never be an exception.
 * 3. **The endpoint never appears.** It is a capability URL (research doc §14)
 *    and this output is designed to be pasted into a chat. Only the push
 *    service origin and a short digest are shown.
 */
export function PushDiagnosticsCard({ className, id }: { className?: string; id?: string }) {
  const [data, setData] = useState<PushDiagnostics | null>(null);
  const [busy, setBusy] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const collect = useCallback(() => {
    setBusy(true);
    void collectPushDiagnostics().then((next) => {
      if (!mounted.current) return;
      setData(next);
      setBusy(false);
      // Nothing to hide when the news is bad: open the detail automatically so
      // the person who came here confused does not have to find one more tap.
      if (pushVerdict(next) !== 'ok') setExpanded(true);
    });
  }, []);

  useEffect(() => {
    collect();
  }, [collect]);

  // Re-read when the service worker moves.
  //
  // A snapshot taken on mount is taken during the very seconds the worker is
  // starting, so the card would sit there saying «ещё запускается» about a
  // worker that went active a moment later — and the owner, who was sent here
  // *because* something is wrong, would read a stale verdict as the diagnosis.
  // Only an actual change of readiness triggers a re-collect, so this cannot
  // become a polling loop over the network.
  const lastReadiness = useRef<string>(readinessKey());
  useEffect(() => {
    return onPushReadinessChange(() => {
      const next = readinessKey();
      if (next === lastReadiness.current) return;
      lastReadiness.current = next;
      collect();
    });
  }, [collect]);

  const copy = useCallback(() => {
    if (!data) return;
    const text = formatPushDiagnostics(data);
    const done = () => {
      if (!mounted.current) return;
      setCopied(true);
      notify.success(T.copied);
      copyTimer.current = window.setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, 2500);
    };

    // `navigator.clipboard` is absent over plain HTTP and in some headless
    // runs; failing loudly here would be absurd on a screen whose job is to be
    // readable when everything else is broken. The report stays selectable
    // below either way.
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      notify.warning(T.copyFailed);
      return;
    }
    void navigator.clipboard.writeText(text).then(done, () => {
      if (mounted.current) notify.warning(T.copyFailed);
    });
  }, [data]);

  const verdict: PushVerdict | null = data ? pushVerdict(data) : null;

  return (
    <Card id={id} className={className} data-testid="push-diagnostics">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Stethoscope className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          {T.title}
        </CardTitle>
        <CardDescription>{T.description}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {!data ? (
          <div className="space-y-2" aria-busy="true" aria-label={T.checking}>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : (
          <>
            {verdict ? <Verdict verdict={verdict} /> : null}

            {/*
              Three verdicts land on the same remedy, and it is the one remedy
              no code change can ever replace. `blocked-in-settings` is the
              WebKit-320551 state — iOS says «ещё не спрашивали» and refuses to
              ask — and `not-asked` shows the steps too, because from inside the
              app those two are literally the same reading.
            */}
            {verdict === 'denied' ||
            verdict === 'blocked-in-settings' ||
            verdict === 'not-asked' ? (
              <ResetSteps />
            ) : null}

            {/*
              Keyed on the verdict rather than on the individual APIs: a
              headless run and a desktop browser still have `serviceWorker`
              even where `Notification` is missing, so an "all three absent"
              test never fired. `unsupported` is exactly "this environment has
              no push", as opposed to the iOS verdicts, which have their own
              and more specific explanations.
            */}
            {verdict === 'unsupported' ? (
              <p className="text-sm text-pretty text-muted-foreground">{T.degradedNote}</p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {/* One tap to a pasteable report — the whole point of the screen. */}
              <Button className="h-11" onClick={copy} data-testid="push-diagnostics-copy">
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {T.copy}
              </Button>
              <Button variant="outline" className="h-11" onClick={collect} disabled={busy}>
                <RefreshCw aria-hidden />
                {busy ? T.checking : T.refresh}
              </Button>
              <Button
                variant="ghost"
                className="h-11"
                aria-expanded={expanded}
                aria-controls="push-diagnostics-detail"
                onClick={() => {
                  setExpanded((open) => !open);
                }}
              >
                {expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
                {expanded ? T.hide : T.show}
              </Button>
            </div>

            {expanded ? <Detail data={data} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* the one-line answer                                                         */
/* -------------------------------------------------------------------------- */

function Verdict({ verdict }: { verdict: PushVerdict }) {
  return (
    <Alert
      variant={verdict === 'ok' ? 'default' : 'destructive'}
      data-testid="push-diagnostics-verdict"
      data-verdict={verdict}
    >
      <AlertTitle>{T.verdictTitle[verdict]}</AlertTitle>
      <AlertDescription>{T.verdictHint[verdict]}</AlertDescription>
    </Alert>
  );
}

/**
 * The exact taps that clear a `denied` permission on iOS.
 *
 * Shown only for that verdict, and shown *without* being folded away, because
 * it is the single state no code change can ever repair — the OS asks once,
 * and after «Не разрешать» the app has no API left to ask again with.
 */
function ResetSteps() {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <p className="font-medium">{T.resetTitle}</p>
      <ol className="mt-1 list-decimal space-y-0.5 pl-5">
        {T.resetSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {/* The one check the user can make with their eyes that we cannot make
          in code: iOS lists a web app under Уведомления only once the prompt
          has been answered, so its absence separates «ещё не спрашивали» from
          «спросили и выключили». */}
      <p className="mt-2 text-xs text-pretty text-muted-foreground">{T.resetAbsentNote}</p>
      <p className="mt-1 text-xs text-pretty text-muted-foreground">{T.resetAndroid}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* the rows                                                                    */
/* -------------------------------------------------------------------------- */

type Tone = 'ok' | 'bad' | 'neutral';

function yesNo(value: boolean): string {
  return value ? T.yes : T.no;
}

function tri(value: 'yes' | 'no' | 'unknown'): string {
  return value === 'yes' ? T.yes : value === 'no' ? T.no : T.unknown;
}

function Detail({ data }: { data: PushDiagnostics }) {
  const rows: Array<{ label: string; value: string; tone: Tone; wrap?: boolean }> = [
    {
      label: T.rows.standalone,
      value: yesNo(data.standalone),
      // Only iOS *requires* installation; on Chromium a browser tab is fine.
      tone: data.standalone ? 'ok' : data.ios ? 'bad' : 'neutral',
    },
    { label: T.rows.displayMode, value: data.displayMode, tone: 'neutral' },
    {
      label: T.rows.notificationApi,
      value: yesNo(data.notificationApi),
      tone: data.notificationApi ? 'ok' : 'bad',
    },
    {
      label: T.rows.pushManagerApi,
      value: yesNo(data.pushManagerApi),
      tone: data.pushManagerApi ? 'ok' : 'bad',
    },
    {
      label: T.rows.serviceWorkerApi,
      value: yesNo(data.serviceWorkerApi),
      tone: data.serviceWorkerApi ? 'ok' : 'bad',
    },
    {
      label: T.rows.permission,
      value: T.permissionValue[data.permission],
      // `default` is not neutral news on iOS — see `permissionDefaultCaveat`.
      tone: data.permission === 'granted' ? 'ok' : data.permission === 'denied' ? 'bad' : 'neutral',
    },
    {
      label: T.rows.lastAttempt,
      value: data.lastAttempt ? T.lastAttemptValue[data.lastAttempt] : T.lastAttemptNone,
      tone: data.lastAttempt === 'enabled' ? 'ok' : data.lastAttempt ? 'bad' : 'neutral',
    },
    {
      label: T.rows.serviceWorker,
      value: T.swValue[data.serviceWorker],
      tone:
        data.serviceWorker === 'active' ? 'ok' : data.serviceWorker === 'none' ? 'bad' : 'neutral',
    },
    {
      // The row that actually explains a dead enable button. `installing` that
      // never becomes `active`, or `waiting` parked behind an update prompt,
      // are two different faults that the collapsed reading above renders
      // identically.
      label: T.rows.serviceWorkerSlots,
      value: `${yesNo(data.serviceWorkerInstalling)} / ${yesNo(data.serviceWorkerWaiting)} / ${yesNo(data.serviceWorkerActive)}`,
      tone: data.serviceWorkerActive ? 'ok' : 'bad',
    },
    {
      label: T.rows.serviceWorkerActiveState,
      value: data.serviceWorkerActiveState ?? T.none,
      tone: data.serviceWorkerActiveState === 'activated' ? 'ok' : 'neutral',
    },
    {
      // The single fact that separates "still starting" from "will never
      // start": `serviceWorker.ready` has no rejection path, so a worker that
      // cannot install leaves it pending for ever.
      label: T.rows.serviceWorkerReadyResolved,
      value: yesNo(data.serviceWorkerReadyResolved),
      tone: data.serviceWorkerReadyResolved ? 'ok' : 'bad',
    },
    {
      label: T.rows.serviceWorkerWaited,
      value:
        data.serviceWorkerWaitedMs === null
          ? T.none
          : `${T.waitedValue(data.serviceWorkerWaitedMs)} · ${T.readinessValue[data.serviceWorkerReadiness]}`,
      tone: data.serviceWorkerReadiness === 'ready' ? 'ok' : 'bad',
    },
    {
      label: T.rows.serviceWorkerRegistrationError,
      value: data.serviceWorkerRegistrationError ?? T.none,
      tone: data.serviceWorkerRegistrationError ? 'bad' : 'neutral',
      wrap: true,
    },
    {
      label: T.rows.serviceWorkerControlling,
      value: yesNo(data.serviceWorkerControlling),
      // Neutral either way, on purpose. `нет` here is the *normal* reading on
      // the first launch after an install, and colouring it red is how a
      // reader concludes that this is the fault when it never is.
      tone: 'neutral',
    },
    {
      label: T.rows.serviceWorkerScope,
      value: data.serviceWorkerScope ?? T.none,
      tone: 'neutral',
      wrap: true,
    },
    {
      label: T.rows.registrationPushManager,
      value: yesNo(data.registrationHasPushManager),
      tone: data.registrationHasPushManager ? 'ok' : 'bad',
    },
    {
      label: T.rows.subscription,
      value: tri(data.subscription),
      tone: data.subscription === 'yes' ? 'ok' : data.subscription === 'no' ? 'bad' : 'neutral',
    },
    {
      label: T.rows.subscriptionOrigin,
      value: data.subscriptionOrigin ?? T.none,
      tone: 'neutral',
      wrap: true,
    },
    {
      label: T.rows.subscriptionFingerprint,
      value: data.subscriptionFingerprint ?? T.none,
      tone: 'neutral',
    },
    {
      label: T.rows.serverKnows,
      value: tri(data.serverKnows),
      tone: data.serverKnows === 'yes' ? 'ok' : data.serverKnows === 'no' ? 'bad' : 'neutral',
    },
    {
      label: T.rows.serverDeviceCount,
      value: data.serverDeviceCount === null ? T.none : String(data.serverDeviceCount),
      tone: 'neutral',
    },
    {
      label: T.rows.vapidKey,
      value: data.vapidKey === 'present' ? T.keyPresent : T.keyMissing,
      tone: data.vapidKey === 'present' ? 'ok' : 'bad',
    },
    {
      label: T.rows.online,
      value: data.online ? T.online : T.offline,
      tone: data.online ? 'ok' : 'bad',
    },
    { label: T.rows.timezone, value: data.timezone, tone: 'neutral' },
    { label: T.rows.appVersion, value: data.appVersion, tone: 'neutral' },
    { label: T.rows.userAgent, value: data.userAgent, tone: 'neutral', wrap: true },
  ];

  return (
    <div id="push-diagnostics-detail" className="space-y-4">
      {/*
        Directly above the rows, because the permission row is the one a reader
        will otherwise take at face value. `default` means "never asked" *or*
        "switched off in Settings, and I will never ask again" — WebKit bug
        320551 — and no API on the device distinguishes them.
      */}
      {data.permission === 'default' ? (
        <p
          className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-pretty"
          data-testid="push-diagnostics-default-caveat"
        >
          {T.permissionDefaultCaveat}
        </p>
      ) : null}

      {/*
        The `controller` row is the one a reader will otherwise blame. It is
        `нет` on every healthy first launch after an install — and a readiness
        check built on it is exactly the bug that produced this screen's
        busiest week.
      */}
      {!data.serviceWorkerControlling ? (
        <p
          className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-pretty"
          data-testid="push-diagnostics-controller-caveat"
        >
          {T.controllingCaveat}
        </p>
      ) : null}

      <dl className="divide-y divide-border rounded-lg border border-border">
        {rows.map((row) => (
          <div
            key={row.label}
            /* Stacked on a phone: «Отпечаток подписки» plus its value does not
               fit on one 320px line, and a truncated diagnostic is not one. */
            className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
          >
            <dt className="text-xs text-pretty text-muted-foreground">{row.label}</dt>
            <dd
              className={cn(
                'font-mono text-xs',
                row.wrap ? 'break-all' : 'sm:text-right',
                row.tone === 'ok' && 'text-success',
                row.tone === 'bad' && 'text-destructive',
                row.tone === 'neutral' && 'text-foreground',
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      <LastError data={data} />
    </div>
  );
}

/**
 * The error, exactly as it was thrown.
 *
 * `name` and `message` are not translated and not shortened. Everything around
 * them is Russian so the reader knows what they are looking at; the value
 * itself is the payload, and rewriting it would destroy the only evidence we
 * get from a device we cannot touch.
 */
function LastError({ data }: { data: PushDiagnostics }) {
  const error = data.lastError;

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{T.lastErrorTitle}</p>
      {error ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-3"
          data-testid="push-diagnostics-error"
        >
          <p className="text-xs text-muted-foreground">{T.lastErrorStage[error.stage]}</p>
          <p className="mt-1 font-mono text-xs break-all text-destructive">
            {error.name}: {error.message}
          </p>
          {error.status !== undefined ? (
            <p className="mt-1 font-mono text-xs text-destructive">
              {T.lastErrorHttp(error.status, error.code)}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">{T.lastErrorAt(error.at)}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{T.lastErrorNone}</p>
      )}
    </div>
  );
}
