import { useCallback, useEffect, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { cn } from '@/shared/lib/utils';
import { notify } from '@/shared/lib/toast';
import { engagementCount, shouldOfferInstall } from '@/features/auth/components/install';
import { SETTINGS_RU } from '../locale';
import { PushPrompt } from './PushPrompt';
import { usePush } from './use-push';
import {
  PUSH_PROMPT_ENGAGEMENT_THRESHOLD,
  dismissPushPrompt,
  recordPushPromptOffered,
  shouldOfferPushPrompt,
} from './onboarding';

const T = SETTINGS_RU.push;

/**
 * Delay before the card may appear, measured from the shell mounting.
 *
 * Not decoration. The funnel's first rule is "never on first paint" — a
 * suggestion that arrives in the same frame as the home screen reads as a
 * cookie banner and gets dismissed reflexively, and a dismissal here is
 * expensive. Long enough that the user has seen their own data first.
 */
const SETTLE_MS = 2500;

/**
 * The one place in the app that raises notifications on its own initiative.
 *
 * Mount it in the authenticated shell. It decides for itself whether to render
 * anything (see `onboarding.ts`): nothing to a signed-out visitor, nothing on
 * first paint, nothing where push cannot work, nothing once the OS prompt has
 * been answered either way, nothing for two weeks after a «Не сейчас», and
 * never more than three times in the life of the install.
 *
 * ## Why a card and not the dialog directly
 *
 * The card spends nothing. It is a nudge that can be scrolled past or dismissed
 * with no consequence. Only its button opens `PushPrompt`, and only
 * `PushPrompt`'s «Разрешить» reaches `Notification.requestPermission()` — the
 * tap that can be taken once, ever (`docs/research/ios-pwa-push.md` §13).
 *
 * ## Why it stands down for the install card
 *
 * On iOS outside the installed app `window.Notification` does not exist, so
 * `pushAvailability()` reports `needs-install` and the gate already refuses.
 * The extra `shouldOfferInstall()` check covers the platforms where both could
 * legitimately show at once (Chromium): two stacked cards asking for two
 * different things is how a user learns to dismiss cards without reading them.
 */
export function PushOnboarding({ className }: { className?: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // `engaged` is "signed in **and** done something real": signing in records
    // the first engagement (`features/auth/hooks.ts`) and every successful
    // write records another (`app/providers.tsx`), so the threshold of two is
    // exactly §13's "after the user signs in and does one real action".
    const timer = window.setTimeout(() => {
      if (shouldOfferInstall()) return;
      const engaged = engagementCount() >= PUSH_PROMPT_ENGAGEMENT_THRESHOLD;
      if (!shouldOfferPushPrompt({ engaged })) return;
      recordPushPromptOffered();
      setVisible(true);
    }, SETTLE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;
  return (
    <PushOfferCard
      className={className}
      onDone={() => {
        setVisible(false);
      }}
    />
  );
}

/**
 * The card itself, split out so `usePush()` — which primes the service-worker
 * registration and installs the foreground reconcile loop — is only mounted
 * once we have actually decided to ask.
 */
function PushOfferCard({ className, onDone }: { className?: string; onDone: () => void }) {
  const push = usePush();
  const [promptOpen, setPromptOpen] = useState(false);

  const later = useCallback(() => {
    dismissPushPrompt();
    onDone();
  }, [onDone]);

  const accept = useCallback(() => {
    // Straight from the click handler: `enable()` is not `async` and fires
    // `Notification.requestPermission()` before it returns its promise. The
    // VAPID key is primed at boot by `primeVapidKey()` in `main.tsx` precisely
    // so nothing has to be fetched here — a round trip would spend the
    // user-activation token and Safari would then refuse to subscribe.
    void push.enable().then((result) => {
      switch (result.outcome) {
        case 'enabled':
          notify.success(T.enabled);
          onDone();
          break;
        case 'denied':
          // The one-shot prompt is spent. `/settings/notifications` holds the
          // recovery steps; there is nothing useful left for this card to say.
          onDone();
          break;
        case 'dismissed':
          break;
        case 'needs-install':
        case 'unsupported':
        case 'misconfigured':
        case 'failed':
          notify.error(new Error('push'), T.enableFailed);
          onDone();
          break;
      }
    });
  }, [push, onDone]);

  return (
    <>
      <div
        className={cn(
          'relative rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm',
          className,
        )}
        data-testid="push-offer-card"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-1 right-1 size-11 text-muted-foreground"
          onClick={later}
          aria-label={T.offerDismissLabel}
        >
          <X aria-hidden />
        </Button>

        <div className="flex items-start gap-3 pr-10">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <BellRing aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <p className="font-medium text-balance">{T.offerTitle}</p>
            <p className="text-sm text-pretty text-muted-foreground">{T.offerText}</p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            // Full width on a phone, where it is the only thing to tap; its own
            // width from `sm` up, so it does not become an 880px slab and the
            // loudest object on a desktop home screen.
            className="h-11 flex-1 sm:flex-none sm:px-8"
            disabled={push.busy}
            onClick={() => {
              // The soft pre-prompt first — always. The OS prompt is one-shot
              // and must never be the user's first surprise.
              setPromptOpen(true);
            }}
          >
            {T.offerAccept}
          </Button>
          <Button type="button" variant="ghost" className="h-11" onClick={later}>
            {T.offerLater}
          </Button>
        </div>
      </div>

      <PushPrompt open={promptOpen} onOpenChange={setPromptOpen} onAccept={accept} />
    </>
  );
}
