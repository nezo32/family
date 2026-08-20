import { PageHeader } from '@/shared/components/PageHeader';
import { ErrorState } from '@/shared/components/ErrorState';
import { LoadingScreen } from '@/shared/components/LoadingScreen';
import { useMe } from '@/shared/auth/use-me';
import { SETTINGS_RU } from '../locale';
import { PUSH_DIAGNOSTICS_ANCHOR, PushSection } from '../push/PushPrompt';
import { PushDiagnosticsCard } from '../push/PushDiagnosticsCard';
import { PreferenceMatrix } from '../components/PreferenceMatrix';
import { QuietHoursEditor } from '../components/QuietHoursEditor';
import { DeviceList } from '../components/DeviceList';
import { TestNotificationCard } from '../components/TestNotificationCard';
import { useCurrentEndpoint, usePreferences, useSubscriptions } from '../hooks';

const T = SETTINGS_RU.notifications;

/**
 * Уведомления — the whole notification surface for one member.
 *
 * Section order is the order a confused person needs them in:
 *
 *  1. **Push on this device** — the permission funnel, the install hint and the
 *     «Уведомления отключились» repair card. Everything below is inert until
 *     this is sorted, so it goes first.
 *  2. **Test push** — the one control that answers "работает или нет" (research
 *     doc §15). Immediately after enabling, where it will actually be used.
 *  3. **The preference matrix** — what to send, per type and per channel.
 *  4. **Quiet hours** — when to stay silent (deferring, never dropping — D10).
 *  5. **Devices** — every subscription, with its D11 health.
 *  6. **Diagnostics** — which precondition is actually shut on *this* device,
 *     copyable in one tap. Last because it is the fallback, always present
 *     because iOS push fails on one phone at a time and nowhere we can look.
 */
export default function NotificationsPage() {
  const { data: me } = useMe();
  const preferences = usePreferences();
  const endpoint = useCurrentEndpoint();
  const subscriptions = useSubscriptions(endpoint);

  return (
    <>
      <PageHeader title={T.title} description={T.description} />

      {/* Sixty switches read down a 1024px column; the measure keeps each row
          short enough that a label and its toggle stay in the same glance. */}
      <div className="max-w-2xl space-y-4">
        <PushSection />
        <TestNotificationCard />

        {preferences.isPending ? (
          <LoadingScreen />
        ) : preferences.error || !preferences.data ? (
          <ErrorState
            error={preferences.error}
            title={T.loadFailed}
            onRetry={() => {
              void preferences.refetch();
            }}
          />
        ) : (
          <>
            <PreferenceMatrix data={preferences.data} role={me?.user.role} />
            <QuietHoursEditor windows={preferences.data.quietHours} />
          </>
        )}

        <DeviceList devices={subscriptions.data ?? []} currentEndpoint={endpoint} />

        {/*
          Last, and always present. It is the only instrument we have for a bug
          that reproduces on exactly one phone in the family and on no machine
          we own — so it does not hide behind an error state, and it opens
          itself when the verdict is anything other than «Всё в порядке».
        */}
        <PushDiagnosticsCard id={PUSH_DIAGNOSTICS_ANCHOR} />
      </div>
    </>
  );
}
