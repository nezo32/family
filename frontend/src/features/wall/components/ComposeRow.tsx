import { Plus } from 'lucide-react';
import { useMe } from '@/shared/auth/use-me';
import { MemberDisc } from '@/shared/ui/member-disc';
import { WALL_RU } from '../locale';
import { useBoardCompose } from './BoardCompose';

/**
 * The first thing in the feed surface, above the head, at every width — and a
 * `<button>`, never a field (§D7.5).
 *
 * ```
 * ┌────────────────────────────────────────┐
 * │ (П)  Что повесить на доску?         ⊕ │  56px, one row, card ground
 * ```
 *
 * It is shaped exactly like VK's composer. There is no `<input>`, no
 * `contenteditable`, no autofocus, and nothing on this screen ever raises the
 * software keyboard. Tapping it opens the same one door — «Что повесим на
 * доску?»: Объявление · Опрос · Спасибо — each gated by `useCan()`, skipping
 * the menu when the reader holds exactly one, rendering **nothing at all**
 * when they hold none.
 *
 * > The extra tap before any character can be typed is not friction to be
 * > optimised away — it is the whole mechanism that keeps «ок», «ага» and
 * > «в 10» out of the feed.
 *
 * Why this is not the thing the board refused: the refusal was a field pinned
 * to the **bottom** of the page, which is the messenger gesture — type, send,
 * repeat, with the newest thing at your thumb. A button at the top of a
 * newest-first stream inverts every part of that, and the sheet it opens has a
 * title, a body field and the verb «Повесить», not «Отправить».
 */
export function ComposeRow() {
  const compose = useBoardCompose();
  const me = useMe();

  // A guest gets a wall they can read, not a button that would 403.
  if (compose.available.length === 0) return null;

  const user = me.data?.user;
  const name = user?.displayName ?? WALL_RU.feed.unknownAuthor;

  return (
    <button
      type="button"
      onClick={compose.start}
      className="flex min-h-14 w-full max-w-row-measure touch-manipulation items-center gap-3 px-4 py-2 text-start transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <MemberDisc
        id={user?.id ?? null}
        displayName={name}
        avatarUrl={user?.avatarUrl ?? null}
        size="md"
      />
      <span className="min-w-0 flex-1 truncate text-[15px] leading-[22px] text-muted-foreground">
        {WALL_RU.feed.composePlaceholder}
      </span>
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
      >
        <Plus className="size-4" />
      </span>
      {/* The visible text is a placeholder-ish prompt; the button's own name is
          the verb, so a screen reader hears an action rather than a question. */}
      <span className="sr-only">{WALL_RU.compose.open}</span>
    </button>
  );
}
