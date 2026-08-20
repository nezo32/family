import { useMemo, useState } from 'react';
import { ROLE_LABELS_RU, type UpdateProfileRequest } from '@family/shared';
import { PageHeader } from '@/shared/components/PageHeader';
import { ErrorState } from '@/shared/components/ErrorState';
import { LoadingScreen } from '@/shared/components/LoadingScreen';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { Button } from '@/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card';
import { ColorField, PALETTE_COLORS } from '@/shared/ui/color-field';
import { DateField } from '@/shared/ui/date-field';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Badge } from '@/shared/ui/badge';
import { useMe } from '@/shared/auth/use-me';
import { notify } from '@/shared/lib/toast';
import { getDeviceTimeZone } from '@/shared/lib/format';
import { todayDateKey } from '@/shared/lib/datetime';
import { SETTINGS_RU } from '../locale';
import { useUpdateProfile } from '../hooks';
import { AvatarField } from '../components/AvatarField';

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
  const currentBirthDate = birthDate ?? self.birthDate ?? '';
  // The fallback is the first palette colour, not a lone hex nothing else in
  // the app uses: a member who has never chosen sees the swatch they would get.
  const currentColor = color ?? self.color ?? PALETTE_COLORS[0];
  // `user.timezone` is nullable and means "inherit the family's" (D2).
  const currentTimezone = timezone ?? self.timezone ?? me.family.timezone;

  const patch: UpdateProfileRequest = {
    ...(displayName !== null && displayName.trim() !== self.displayName
      ? { displayName: displayName.trim() }
      : {}),
    // `avatarUrl` is deliberately absent: the photo is uploaded and removed by
    // its own endpoints, which commit immediately. Folding it into this patch
    // would mean the picture only appears after «Сохранить», which is not what
    // the cropper's own «Сохранить» just promised.
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
                  avatarUrl: self.avatarUrl,
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
                className="h-11"
                value={currentName}
                maxLength={80}
                placeholder={T.displayNamePlaceholder}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">{T.displayNameHint}</p>
            </div>

            {/*
              The photo saves itself, outside this form's dirty-patch flow —
              see the note on `patch` above. Everything it needs (upload,
              crop, remove, its own error and progress states) lives in
              `AvatarField`.
            */}
            <AvatarField
              userId={self.id}
              displayName={currentName}
              avatarUrl={self.avatarUrl}
            />

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="birthDate">{T.birthDateLabel}</Label>
                <DateField
                  id="birthDate"
                  label={T.birthDateLabel}
                  value={currentBirthDate}
                  clearable
                  // Nobody scrolls month-by-month back to 1988.
                  captionLayout="dropdown"
                  min="1900-01-01"
                  max={todayDateKey()}
                  describedBy="birthDate-hint"
                  onChange={setBirthDate}
                />
                <p id="birthDate-hint" className="text-xs text-muted-foreground">
                  {T.birthDateHint}
                </p>
              </div>

              <div className="space-y-1.5">
                <span className="text-sm leading-none font-medium">{T.colorLabel}</span>
                <ColorField
                  label={T.colorLabel}
                  name="profile-color"
                  value={currentColor}
                  onChange={setColor}
                />
                <p className="text-xs text-muted-foreground">{T.colorHint}</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="timezone">{T.timezoneLabel}</Label>
              <div className="flex gap-2">
                <Input
                  id="timezone"
                  className="h-11"
                  value={currentTimezone}
                  placeholder="Europe/Moscow"
                  onChange={(event) => {
                    setTimezone(event.target.value);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
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
