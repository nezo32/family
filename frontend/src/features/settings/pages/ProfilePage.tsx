import { useMemo, useState } from 'react';
import { ROLE_LABELS_RU, type UpdateProfileRequest } from '@family/shared';
import { PageHeader } from '@/shared/components/PageHeader';
import { ErrorState } from '@/shared/components/ErrorState';
import { LoadingScreen } from '@/shared/components/LoadingScreen';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Badge } from '@/shared/ui/badge';
import { useMe } from '@/shared/auth/use-me';
import { notify } from '@/shared/lib/toast';
import { getDeviceTimeZone } from '@/shared/lib/format';
import { SETTINGS_RU } from '../locale';
import { useUpdateProfile } from '../hooks';

const T = SETTINGS_RU.profile;

/**
 * Профиль — the fields a member may change about themselves.
 *
 * `PATCH /api/me` is `.strict()`: `role`, `status` and the permission overrides
 * are admin-only and live on a different screen entirely (D4). Only the changed
 * fields are sent, because the contract rejects an empty body.
 *
 * The timezone field carries more weight than it looks: quiet hours and every
 * reminder are evaluated in the *recipient's* wall clock (D2), so a member who
 * travels and never updates this gets their notifications at the wrong hour.
 */
export default function ProfilePage() {
  const { data: me, isPending, error, refetch } = useMe();
  const update = useUpdateProfile();

  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [birthDate, setBirthDate] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string | null>(null);

  const zone = useMemo(() => getDeviceTimeZone(), []);

  if (isPending) return <LoadingScreen />;
  if (error || !me) {
    return (
      <ErrorState
        error={error}
        title={T.loadFailed}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  // `null` in local state means "untouched"; that is what keeps the PATCH body
  // to the fields the user actually edited.
  //
  // Everything here reads from `me.user` — the `selfUserSchema` projection of
  // `GET /api/me` — so `birthDate` and `color` are pre-filled from the server
  // rather than starting empty.
  const self = me.user;
  const currentName = displayName ?? self.displayName;
  const currentAvatar = avatarUrl ?? self.avatarUrl ?? '';
  const currentBirthDate = birthDate ?? self.birthDate ?? '';
  const currentColor = color ?? self.color ?? '#8b7bd8';
  // `user.timezone` is nullable and means "inherit the family's" (D2).
  const currentTimezone = timezone ?? self.timezone ?? me.family.timezone;

  const patch: UpdateProfileRequest = {
    ...(displayName !== null && displayName.trim() !== self.displayName
      ? { displayName: displayName.trim() }
      : {}),
    ...(avatarUrl !== null ? { avatarUrl: avatarUrl.trim() === '' ? null : avatarUrl.trim() } : {}),
    ...(birthDate !== null ? { birthDate: birthDate === '' ? null : birthDate } : {}),
    ...(color !== null ? { color } : {}),
    ...(timezone !== null ? { timezone } : {}),
  };
  const dirty = Object.keys(patch).length > 0;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    update.mutate(patch, {
      onSuccess: () => {
        notify.success(T.saved);
        setDisplayName(null);
        setAvatarUrl(null);
        setBirthDate(null);
        setColor(null);
        setTimezone(null);
      },
      onError: (mutationError) => {
        notify.error(mutationError);
      },
    });
  };

  return (
    <>
      <PageHeader title={T.title} description={T.description} />

      {/* A 1000px-wide «Имя» field is not a form. Same measure as /settings. */}
      <form onSubmit={submit} className="max-w-2xl space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3">
              <UserAvatar
                user={{
                  id: self.id,
                  displayName: currentName,
                  avatarUrl: currentAvatar || null,
                }}
              />
              <span className="min-w-0 truncate">{currentName}</span>
            </CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                {T.roleLabel}: {ROLE_LABELS_RU[self.role]}
              </Badge>
              <span className="text-xs">
                {T.emailLabel}: {self.email ?? T.emailEmpty}
              </span>
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="displayName">{T.displayNameLabel}</Label>
              <Input
                id="displayName"
                value={currentName}
                maxLength={80}
                placeholder={T.displayNamePlaceholder}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">{T.displayNameHint}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="avatarUrl">{T.avatarLabel}</Label>
              <div className="flex gap-2">
                <Input
                  id="avatarUrl"
                  type="url"
                  inputMode="url"
                  value={currentAvatar}
                  placeholder={T.avatarPlaceholder}
                  onChange={(event) => {
                    setAvatarUrl(event.target.value);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setAvatarUrl('');
                  }}
                >
                  {T.avatarClear}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{T.avatarHint}</p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="birthDate">{T.birthDateLabel}</Label>
                <Input
                  id="birthDate"
                  type="date"
                  value={currentBirthDate}
                  onChange={(event) => {
                    setBirthDate(event.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">{T.birthDateHint}</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="color">{T.colorLabel}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="color"
                    type="color"
                    className="h-10 w-16 p-1"
                    value={currentColor}
                    onChange={(event) => {
                      setColor(event.target.value);
                    }}
                  />
                  <span className="font-mono text-xs text-muted-foreground">{currentColor}</span>
                </div>
                <p className="text-xs text-muted-foreground">{T.colorHint}</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="timezone">{T.timezoneLabel}</Label>
              <div className="flex gap-2">
                <Input
                  id="timezone"
                  value={currentTimezone}
                  placeholder="Europe/Moscow"
                  onChange={(event) => {
                    setTimezone(event.target.value);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={currentTimezone === zone}
                  onClick={() => {
                    setTimezone(zone);
                  }}
                >
                  {T.timezoneUseDetected}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{T.timezoneHint}</p>
              <p className="text-xs text-muted-foreground">{T.timezoneDetected(zone)}</p>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" className="h-11" disabled={!dirty || update.isPending}>
            {update.isPending ? T.saving : T.save}
          </Button>
          {!dirty ? <span className="text-xs text-muted-foreground">{T.nothingToSave}</span> : null}
        </div>
      </form>
    </>
  );
}
