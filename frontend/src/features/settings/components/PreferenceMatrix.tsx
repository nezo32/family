import { useMemo, useState } from 'react';
import {
  NOTIFICATION_GROUPS,
  NOTIFICATION_GROUP_LABELS_RU,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LABELS_RU,
  defaultNotificationPreference,
  type NotificationPreference,
  type NotificationType,
  type PreferencesResponse,
  type Role,
} from '@family/shared';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { Switch } from '@/shared/ui/switch';
import { notify } from '@/shared/lib/toast';
import { SETTINGS_RU } from '../locale';
import { useSavePreferences } from '../hooks';

const T = SETTINGS_RU.notifications;

/**
 * The per-type × per-channel preference matrix.
 *
 * Driven **entirely** by `NOTIFICATION_TYPE_LABELS_RU` and
 * `DEFAULT_NOTIFICATION_PREFERENCES` from `@family/shared`. That catalog is the
 * same object the backend fans out on, so a new notification type appears here
 * with the right label, group and defaults the moment it is added upstream —
 * and a type without copy is a compile error there rather than a blank row here.
 *
 * Storage is sparse server-side: a user with no row for a type falls back to
 * `defaultNotificationPreference(type, role)`. We reproduce that fallback so an
 * untouched account still renders the switches in the position the dispatcher
 * will actually honour, instead of a screen full of "off".
 */
export function PreferenceMatrix(props: { data: PreferencesResponse; role: Role | undefined }) {
  const save = useSavePreferences();

  const server = useMemo(() => {
    const map = new Map<NotificationType, NotificationPreference>();
    for (const preference of props.data.preferences) map.set(preference.type, preference);
    return map;
  }, [props.data.preferences]);

  const resolved = useMemo(() => {
    const out = new Map<NotificationType, NotificationPreference>();
    for (const type of NOTIFICATION_TYPES) {
      const stored = server.get(type);
      if (stored) {
        out.set(type, stored);
        continue;
      }
      const fallback = defaultNotificationPreference(type, props.role);
      out.set(type, {
        type,
        enabled: fallback.enabled,
        channelPush: fallback.push,
        channelTelegram: fallback.telegram,
        channelInApp: fallback.inApp,
      });
    }
    return out;
  }, [server, props.role]);

  /** Edits layered over `resolved`; empty means "nothing changed". */
  const [edits, setEdits] = useState<Map<NotificationType, NotificationPreference>>(new Map());

  const valueFor = (type: NotificationType): NotificationPreference => {
    const fallback: NotificationPreference = {
      type,
      enabled: false,
      channelPush: false,
      channelTelegram: false,
      channelInApp: true,
    };
    return edits.get(type) ?? resolved.get(type) ?? fallback;
  };

  const patch = (type: NotificationType, change: Partial<NotificationPreference>) => {
    setEdits((previous) => {
      const next = new Map(previous);
      next.set(type, { ...valueFor(type), ...change, type });
      return next;
    });
  };

  const resetToDefaults = () => {
    const next = new Map<NotificationType, NotificationPreference>();
    for (const type of NOTIFICATION_TYPES) {
      const fallback = defaultNotificationPreference(type, props.role);
      next.set(type, {
        type,
        enabled: fallback.enabled,
        channelPush: fallback.push,
        channelTelegram: fallback.telegram,
        channelInApp: fallback.inApp,
      });
    }
    setEdits(next);
  };

  const submit = () => {
    // Bulk on purpose: one transaction, and the server has the whole matrix.
    const payload = NOTIFICATION_TYPES.map((type) => valueFor(type));
    save.mutate(payload, {
      onSuccess: () => {
        setEdits(new Map());
        notify.success(T.saved);
      },
      onError: (error) => {
        notify.error(error);
      },
    });
  };

  const dirty = edits.size > 0;
  const { pushReady, telegramReady } = props.data.channels;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{T.matrixTitle}</CardTitle>
        <CardDescription>{T.matrixHint}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {NOTIFICATION_GROUPS.map((group) => {
          const types = NOTIFICATION_TYPES.filter(
            (type) => NOTIFICATION_TYPE_LABELS_RU[type].group === group,
          );
          if (types.length === 0) return null;

          return (
            <section key={group} className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">
                {NOTIFICATION_GROUP_LABELS_RU[group]}
              </h3>

              <div className="space-y-3">
                {types.map((type) => {
                  const copy = NOTIFICATION_TYPE_LABELS_RU[type];
                  const value = valueFor(type);

                  return (
                    <div key={type} className="min-w-0 rounded-lg border border-border p-3">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <label
                            htmlFor={`enabled-${type}`}
                            className="text-sm font-medium text-foreground"
                          >
                            {copy.label}
                          </label>
                          <p className="text-xs text-muted-foreground">{copy.description}</p>
                        </div>
                        <Switch
                          id={`enabled-${type}`}
                          aria-label={`${copy.label}: ${T.enabledLabel}`}
                          checked={value.enabled}
                          onCheckedChange={(checked) => {
                            patch(type, { enabled: checked });
                          }}
                        />
                      </div>

                      {value.enabled ? (
                        <div className="mt-3 flex min-w-0 flex-wrap gap-x-5 gap-y-3 border-t border-border pt-3">
                          <ChannelToggle
                            id={`push-${type}`}
                            typeLabel={copy.label}
                            label="Push"
                            checked={value.channelPush}
                            disabled={!pushReady}
                            reason={pushReady ? undefined : T.channelUnavailablePush}
                            onChange={(checked) => {
                              patch(type, { channelPush: checked });
                            }}
                          />
                          <ChannelToggle
                            id={`telegram-${type}`}
                            typeLabel={copy.label}
                            label="Telegram"
                            checked={value.channelTelegram}
                            disabled={!telegramReady}
                            reason={telegramReady ? undefined : T.channelUnavailableTelegram}
                            onChange={(checked) => {
                              patch(type, { channelTelegram: checked });
                            }}
                          />
                          <ChannelToggle
                            id={`inapp-${type}`}
                            typeLabel={copy.label}
                            label="В приложении"
                            checked={value.channelInApp}
                            onChange={(checked) => {
                              patch(type, { channelInApp: checked });
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}

        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!dirty || save.isPending} onClick={submit}>
            {save.isPending ? T.saving : T.save}
          </Button>
          <Button variant="ghost" onClick={resetToDefaults} disabled={save.isPending}>
            {T.resetDefaults}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One channel switch inside one notification row.
 *
 * Two things here are deliberate and were both wrong before:
 *
 * 1. **`aria-label`, not just `<label htmlFor>`.** There are sixty of these on
 *    the page and «Push» three rows apart means three different things, so the
 *    name has to carry the notification type: "Задача выполнена: Push". The
 *    visible «Push» stays as the visual label.
 * 2. **The unavailability reason is not a visible pill.** «Push выключен» and
 *    «Telegram не привязан» are global facts about the account, stated once in
 *    the banner at the top of the screen. Repeated per row they printed the same
 *    two sentences 38 times, made the page 5658px tall on a phone and — being
 *    `w-fit shrink-0` inside a flex row — pushed `scrollWidth` to 439px on a
 *    390px viewport. The reason now rides on the accessible name and the native
 *    tooltip, where it explains the disabled switch without being shouted.
 */
function ChannelToggle(props: {
  id: string;
  /** The notification type this switch belongs to, for the accessible name. */
  typeLabel: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  reason?: string;
  onChange: (checked: boolean) => void;
}) {
  const name = props.disabled && props.reason
    ? `${props.typeLabel}: ${props.label} — ${props.reason}`
    : `${props.typeLabel}: ${props.label}`;

  return (
    <div className="flex min-w-0 items-center gap-2" title={props.disabled ? props.reason : undefined}>
      <Switch
        id={props.id}
        aria-label={name}
        checked={props.checked && !props.disabled}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
      <label htmlFor={props.id} className="text-xs">
        {props.label}
      </label>
    </div>
  );
}
