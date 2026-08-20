import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { cn } from '../lib/utils';
import { initials } from '../lib/format';
import { useAvatarSource } from '../api/authed-image';
import { memberSlot } from '../ui/member-disc';

export interface AvatarUser {
  id?: string;
  displayName: string;
  avatarUrl?: string | null;
}

const SIZES = {
  xs: 'size-6 text-[10px]',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-14 text-base',
  xl: 'size-20 text-xl',
} as const;

export type AvatarSize = keyof typeof SIZES;

/**
 * Family member avatar with an initials fallback.
 *
 * The fallback tint is derived from the user id so each member keeps the same
 * colour everywhere in the app — a family recognises each other by colour long
 * before they read the name.
 *
 * ## Two kinds of avatar, one of which is not ours
 *
 * An **uploaded** avatar is `/api/users/:id/avatar?v=…`, served out of a private
 * bucket behind the session, so the bytes have to be fetched with the bearer
 * token and handed over as an object URL. A **linked** one is an absolute
 * `https://lh3.googleusercontent.com/…` that Google wrote when the account was
 * linked; it is somebody else's host and gets a plain `<img src>` with no
 * credentials of any kind. `useAvatarSource` decides which, by origin.
 *
 * In production today *every* avatar is the second kind — the bucket is empty
 * and all three accounts were created through Google — so the provider path is
 * the one that is actually load-bearing, not the exotic case.
 *
 * The cost of that path is a privacy leak we have chosen to accept for now:
 * loading an image from `lh3.googleusercontent.com` tells Google that this
 * family member opened the app. `referrerPolicy="no-referrer"` withholds
 * *which screen* they opened, which is the part we can fix without changing how
 * linking works. Copying provider avatars into our own bucket at link time
 * would close it properly.
 *
 * ## Every failure lands on the initials
 *
 * The authenticated path adds two more ways for an image not to appear — the
 * fetch is still in flight, or it failed — on top of the two Radix already
 * handles (no URL at all, `<img>` load error).
 *
 * All four collapse to the same thing here: `src` is `undefined`, no
 * `AvatarImage` is rendered, and the fallback shows. There is deliberately no
 * spinner and no broken-image icon. At 24–80px a spinner is noise, and a broken
 * image is the single most conspicuous way for a small feature to make the
 * whole app look unfinished — initials are a *correct* answer, not a
 * placeholder.
 */
export function UserAvatar(props: {
  user: AvatarUser;
  size?: AvatarSize;
  /** Ring highlight, e.g. for "это вы". */
  highlighted?: boolean;
  className?: string;
}) {
  const size = props.size ?? 'md';
  const tint = tintFor(props.user.id ?? props.user.displayName);
  const { src, external } = useAvatarSource(props.user.avatarUrl);

  return (
    <Avatar
      className={cn(
        SIZES[size],
        props.highlighted && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
        props.className,
      )}
    >
      {src ? (
        <AvatarImage
          src={src}
          alt={props.user.displayName}
          // Provider CDNs only. Never `crossOrigin`, which would turn a plain
          // image load into a CORS preflight Google has no reason to satisfy.
          {...(external ? { referrerPolicy: 'no-referrer' as const } : {})}
          // Belt and braces over Radix's own error handling: an object URL that
          // was revoked under us (cache eviction mid-render) must still fall
          // through to the initials rather than render a broken image.
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : null}
      <AvatarFallback
        className="font-medium"
        style={{ backgroundColor: tint.background, color: tint.foreground }}
      >
        {initials(props.user.displayName)}
      </AvatarFallback>
    </Avatar>
  );
}

/** Overlapping avatar row, e.g. "кто участвует в задаче". */
export function AvatarGroup(props: { users: AvatarUser[]; max?: number; size?: AvatarSize }) {
  const max = props.max ?? 4;
  const shown = props.users.slice(0, max);
  const rest = props.users.length - shown.length;

  return (
    <div className="flex items-center -space-x-2">
      {shown.map((user, index) => (
        <UserAvatar
          key={user.id ?? `${user.displayName}-${String(index)}`}
          user={user}
          size={props.size ?? 'sm'}
          className="ring-2 ring-background"
        />
      ))}
      {rest > 0 ? (
        <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-2 ring-background">
          +{rest}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The initials tint, from the theme's five-colour member ramp (§B4).
 *
 * It used to be `oklch(0.88 0.06 <hash mod 360>)` — a deterministic pastel from
 * **any** of 360 hues, which is how a pink «БН» disc ended up sitting on a sand
 * card in `today-desktop-light`, and why an avatar looked identical in light
 * and dark mode while everything around it moved. §B1 keeps the palette whole:
 * five perceptually-spaced colours picked against this warm ground, and the
 * same person is the same colour on their disc, their day-rail tick, their
 * event bar and their load bar.
 *
 * `color-mix` rather than a second token: the ramp colour is the foreground at
 * full strength and the ground at 18 %, which is exactly what `MemberDisc`
 * does with `bg-member-N/15` — one relationship, expressed twice because one
 * of these two has to set the colour from JavaScript.
 */
function tintFor(seed: string): { background: string; foreground: string } {
  const colour = `var(--chart-${String(memberSlot(seed))})`;
  return {
    background: `color-mix(in oklab, ${colour} 18%, transparent)`,
    foreground: colour,
  };
}
