import type { ReactNode } from 'react';
import type { OAuthProvider } from '@family/shared';
import { Button } from '@/shared/ui/button';
import { AUTH_RU } from '../locale';
import { enabledOAuthProviders, startOAuth } from '../api';
import { AppleMark, GoogleMark, TelegramMark } from './BrandMarks';

/**
 * The provider sign-in buttons, shared by the login and registration screens —
 * signing up through a provider is the same round trip as signing in, and the
 * admin-approval gate happens afterwards either way.
 *
 * Each button is a **top-level navigation** (`api.ts :: startOAuth`). Never a
 * popup: `window.open` is blocked or opens Safari in a separate storage
 * partition inside an installed iOS PWA, so the session cookie the callback sets
 * would never come back to the app.
 */

const PROVIDER_UI: Record<OAuthProvider, { label: string; mark: ReactNode }> = {
  google: { label: AUTH_RU.login.providerGoogle, mark: <GoogleMark /> },
  apple: { label: AUTH_RU.login.providerApple, mark: <AppleMark /> },
  telegram: { label: AUTH_RU.login.providerTelegram, mark: <TelegramMark /> },
};

export function ProviderButton({
  provider,
  next,
}: {
  provider: OAuthProvider;
  next?: string | null;
}) {
  const ui = PROVIDER_UI[provider];
  return (
    <Button
      type="button"
      variant="outline"
      className="h-11 w-full justify-start gap-3 px-4 text-base font-medium"
      onClick={() => {
        startOAuth(provider, { redirect: next ?? null });
      }}
    >
      {ui.mark}
      <span className="flex-1 text-center">{ui.label}</span>
      {/* Balances the mark so the label stays optically centred. */}
      <span className="size-5" aria-hidden />
    </Button>
  );
}

/** Every provider this deployment is configured for, in display order. */
export function ProviderButtons({ next }: { next?: string | null }) {
  return (
    <div className="space-y-2">
      {enabledOAuthProviders().map((provider) => (
        <ProviderButton key={provider} provider={provider} next={next} />
      ))}
    </div>
  );
}
