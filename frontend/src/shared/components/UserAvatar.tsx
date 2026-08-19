import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { cn } from '../lib/utils';
import { initials } from '../lib/format';

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

  return (
    <Avatar
      className={cn(
        SIZES[size],
        props.highlighted && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
        props.className,
      )}
    >
      {props.user.avatarUrl ? (
        <AvatarImage src={props.user.avatarUrl} alt={props.user.displayName} />
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

/** Deterministic pastel from a string — same member, same colour, forever. */
function tintFor(seed: string): { background: string; foreground: string } {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  return {
    background: `oklch(0.88 0.06 ${String(hash)})`,
    foreground: `oklch(0.35 0.09 ${String(hash)})`,
  };
}
