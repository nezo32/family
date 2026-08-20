import { useState } from 'react';
import { MoreHorizontal, Pin, PinOff, Sparkles, Trash2 } from 'lucide-react';
import type { PostResponse } from '@family/shared';
import { useCan } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { ConfirmDialog } from '@/shared/components';
import { ActionSheet, type ActionSheetItem } from '@/shared/ui/action-sheet';
import { useCoarsePointer } from '@/shared/ui/use-coarse-pointer';
import { useLongPress } from '@/shared/ui/use-long-press';
import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { formatDayMonth } from '@/shared/lib/format';
import { isoInDays } from '../api';
import { useDeletePost, useSetPin, type Roster } from '../hooks';
import { WALL_RU } from '../locale';
import { AuthorLine } from './AuthorLine';
import { ReactionBar } from './ReactionBar';
import { CommentThread } from './CommentThread';

/**
 * One announcement, as a card in the stream (§D7.6).
 *
 * ## No card draws its own border, radius, shadow or ground
 *
 * With two exceptions, both of them named here: the `--surface-calm` ground a
 * system post carries, and the `--surface-attention` wash the **one** head
 * card in band 2 may take (§C2, §D7.4). Everything else is separated by a 1px
 * `--hairline` inset by the card's 16px left padding, exactly as `Section`
 * renders it. Twelve bordered boxes with gaps between them is a grid of tiles
 * (§A2); one surface carrying differently-sized cards is a stream.
 *
 * The rules that survive from the board, because they were right:
 *
 * - **A system post is visibly not a person talking.** No author disc at all,
 *   and the sage ground on the card itself. «Семейный бот» with a face beside
 *   it is an uncanny sixth family member.
 * - **The body clamps at four lines** with «ещё». A single 2000-character post
 *   otherwise owns the viewport, and the reader never learns there was
 *   anything below it.
 * - **Pinned states its own expiry** — 📌 «Закреплено до 25 августа» in `meta`,
 *   which is also this card's eyebrow line when it floats in the head. Colour
 *   is never the only signal (§B4), so the head is legible in greyscale and to
 *   a screen reader taking the cards in order.
 *
 * **Media has no contract today** (§D7.6). `createPostSchema` is `title` /
 * `body` / `pinnedUntil` and nothing else. When an image is added, its slot is
 * between the body and the foot line: full card width, edge-to-edge below
 * `sm`, `aspect-ratio` boxed from server-supplied dimensions so nothing
 * reflows on load, `max-height: 60dvh`. Do not add it by hanging a URL off
 * `body`.
 *
 * ## Gestures (§C-gestures)
 *
 * **No swipe, deliberately.** §G4 puts a swipe on rows with one *reversible*
 * action — куплено, сделано, прочитано. A note's row-level actions are pin and
 * delete: one is not reversible, and the other is a toggle *with an expiry
 * date*, which is not a thing a thumb should be able to set by accident.
 *
 * **Long-press** opens the same menu the visible `⋯` opens — a bottom sheet on
 * a coarse pointer (§G7), the dropdown on a mouse. One list of actions, built
 * once, so the two doors cannot drift apart, and «Снять с доски» goes through
 * `ConfirmDialog` from both.
 */
export function AnnouncementNote(props: {
  post: PostResponse;
  roster: Roster;
  /**
   * Band 2 (§C2): at most one card on the screen wears the wash, and which one
   * is decided by the head's precedence — never here.
   */
  tone?: 'attention' | 'plain';
}) {
  const { post } = props;
  const setPin = useSetPin();
  const remove = useDeletePost();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isSystem = post.type === 'system';
  const coarse = useCoarsePointer();

  const actions = usePostActions(post, {
    onPin: (pinnedUntil) => {
      setPin.mutate({ id: post.id, pinnedUntil });
    },
    onDelete: () => {
      setConfirmingDelete(true);
    },
  });

  const menu =
    actions.length === 0 ? null : (
      <PostMenu
        actions={actions}
        onOpenSheet={() => {
          setMenuOpen(true);
        }}
      />
    );

  // Long-press is only offered when there is something behind it. A gesture
  // that opens an empty sheet teaches that the gesture does nothing.
  const longPress = useLongPress({
    onLongPress: () => {
      setMenuOpen(true);
    },
    enabled: actions.length > 0,
  });

  return (
    <>
      <article
        // Coarse only (§G2): the touch handlers cannot fire for a mouse, but
        // `onContextMenu` would, and swallowing right-click on a desktop is a
        // gesture nobody asked for.
        {...(coarse ? longPress.handlers : {})}
        className={cn(
          'no-callout',
          isSystem && 'bg-surface-calm text-surface-calm-foreground',
          props.tone === 'attention' && 'bg-surface-attention text-surface-attention-foreground',
        )}
      >
        <div className="flex w-full max-w-row-measure flex-col gap-1.5 px-4 py-3">
          {isSystem ? (
            // No author disc: the app wrote this, and a face beside «Семейный
            // бот» claims a person did.
            <div className="flex min-w-0 items-center gap-2">
              <Sparkles className="size-4 shrink-0 opacity-70" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[15px] leading-[22px] font-medium opacity-80">
                {WALL_RU.feed.systemAuthor}
              </span>
              {menu ? <div className="shrink-0">{menu}</div> : null}
            </div>
          ) : (
            // 32px disc, up from the board's 24: in a feed the author has more
            // presence, and the photo on the disc is real now (§D7.6).
            <AuthorLine
              roster={props.roster}
              authorId={post.authorId}
              createdAt={post.createdAt}
              size="md"
              trailing={menu}
            />
          )}

          {post.isPinned ? (
            <p className="flex items-center gap-1.5 text-[13px] leading-[18px] font-medium opacity-80">
              <Pin className="size-3.5 shrink-0" aria-hidden />
              {post.pinnedUntil
                ? WALL_RU.post.pinnedUntil(formatDayMonth(post.pinnedUntil))
                : WALL_RU.post.pinned}
            </p>
          ) : null}

          {post.title ? (
            <h3 className="wrap-break-word font-display text-[17px] leading-6 font-semibold">
              {post.title}
            </h3>
          ) : null}

          <p
            className={cn(
              'wrap-break-word text-[15px] leading-[22px] whitespace-pre-wrap',
              /*
               * The note is `.no-callout` so a long press opens the sheet
               * instead of iOS's selection bubble — but the *body* is the one
               * thing on a board note somebody genuinely wants to copy
               * («адрес», «во сколько выезжаем»), so selection is handed back
               * here, and only here.
               */
              'select-text [-webkit-touch-callout:default]',
              !expanded && 'line-clamp-4',
            )}
          >
            {post.body}
          </p>

          {mightBeClamped(post.body) ? (
            <button
              type="button"
              // 44px of target, not 25×18 of text: §F1 applies to a text link on a
              // coarse pointer exactly as it applies to an icon button. The negative
              // inline margin keeps the word optically aligned with the body above it.
              className="-mx-2 -mt-2 flex min-h-11 min-w-11 items-center justify-start self-start rounded-sm px-2 text-[13px] leading-[18px] font-medium underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              aria-expanded={expanded}
              onClick={() => {
                setExpanded((value) => !value);
              }}
            >
              {expanded ? WALL_RU.post.less : WALL_RU.post.more}
            </button>
          ) : null}

          {/* One 44px line of chrome per note, not two (§A3). */}
          <CommentThread
            target={{ entityType: 'post', entityId: post.id }}
            commentCount={post.commentCount}
            actions={
              <ReactionBar
                target={{ entityType: 'post', entityId: post.id }}
                reactions={post.reactions}
                roster={props.roster}
              />
            }
          />
        </div>
      </article>

      {/*
        Both live outside the `<article>`, not inside it. A React portal bubbles
        its events through the React *tree*, so a sheet rendered under the note
        would send every tap in it back through the note's own long-press
        click-suppression — and the tap it swallowed would be the user's answer.
      */}
      <ActionSheet
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={post.title ?? WALL_RU.post.menuTitle}
        description={WALL_RU.post.menuTitle}
        items={actions}
      />
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={WALL_RU.post.deleteConfirmTitle}
        description={WALL_RU.post.deleteConfirmDescription}
        onConfirm={() => {
          remove.mutate(post.id);
        }}
      />
    </>
  );
}

/**
 * The note's actions, built once and rendered by two surfaces.
 *
 * Both entries are permission-gated, and the list comes back empty when neither
 * is available — the caller then renders no trigger and no long-press, because
 * an overflow button that opens an empty menu is worse than no button.
 * Gating goes through `useCan()`; nothing here looks at a role.
 */
function usePostActions(
  post: PostResponse,
  handlers: { onPin: (pinnedUntil: string | null) => void; onDelete: () => void },
): ActionSheetItem[] {
  const { can } = useCan();
  const mayPin = can('post:pin');
  const mayDelete = can('post:delete', post);

  const items: ActionSheetItem[] = [];
  if (mayPin) {
    if (post.isPinned) {
      items.push({
        id: 'unpin',
        label: WALL_RU.post.unpin,
        icon: PinOff,
        onSelect: () => {
          handlers.onPin(null);
        },
      });
    } else {
      for (const duration of PIN_DURATIONS) {
        items.push({
          id: `pin-${String(duration.days)}`,
          // The dropdown used to carry «Закрепить на» as a section label above
          // three bare durations. A flat sheet has no section labels, so each
          // row states the whole action.
          label: `${WALL_RU.post.pin} · ${duration.label}`,
          icon: Pin,
          onSelect: () => {
            handlers.onPin(isoInDays(duration.days));
          },
        });
      }
    }
  }
  if (mayDelete) {
    items.push({
      id: 'delete',
      label: WALL_RU.post.delete,
      icon: Trash2,
      tone: 'destructive',
      onSelect: () => {
        // Opens the confirmation; never deletes. §G4: destructive actions
        // confirm, and a menu is not a confirmation.
        handlers.onDelete();
      },
    });
  }
  return items;
}

/**
 * The visible `⋯`.
 *
 * On a coarse pointer it is a plain button that raises the note's action sheet
 * (§G7 — every modal is a bottom sheet under a thumb); on a fine pointer it
 * stays the anchored dropdown, which is the right shape for a mouse.
 */
function PostMenu(props: { actions: readonly ActionSheetItem[]; onOpenSheet: () => void }) {
  const coarse = useCoarsePointer();

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-11 text-muted-foreground"
      aria-label={COMMON.more}
      {...(coarse ? { onClick: props.onOpenSheet } : {})}
    >
      <MoreHorizontal className="size-4" aria-hidden />
    </Button>
  );

  if (coarse) return trigger;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {props.actions.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem
              key={item.id}
              {...(item.tone === 'destructive' ? { variant: 'destructive' as const } : {})}
              onSelect={() => {
                item.onSelect();
              }}
            >
              {Icon ? <Icon className="size-4" aria-hidden /> : null}
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Would `line-clamp-4` plausibly be hiding something?
 *
 * Deliberately an estimate over the *content* rather than a `scrollHeight`
 * measurement. A probe has to run after paint, which means the «ещё» link
 * appears one frame late on every note — and on a cold PWA start that reads as
 * the page still loading. ~60 characters per line at this measure × 4 lines is
 * 240; four hard line breaks fill the clamp regardless of length. Showing the
 * link once too often costs one word; hiding it once too often hides a note.
 */
function mightBeClamped(body: string): boolean {
  return body.length > 240 || body.split('\n').length > 4;
}

/** Pinning expires by design: «закреплено до» self-clears; a flag would not. */
const PIN_DURATIONS = [
  { days: 1, label: WALL_RU.post.pinDay },
  { days: 3, label: WALL_RU.post.pinThreeDays },
  { days: 7, label: WALL_RU.post.pinWeek },
] as const;
