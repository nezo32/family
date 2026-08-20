import type { KudosFeedItem } from '@family/shared';
import { MemberDisc } from '@/shared/ui/member-disc';
import type { Roster } from '../hooks';
import { WALL_RU } from '../locale';
import { AuthorLine } from './AuthorLine';
import { CommentThread } from './CommentThread';
import { ReactionBar } from './ReactionBar';

/**
 * «Спасибо» — new as a card, and the warmest thing this app renders (§D7.6).
 *
 * A kudos is a note addressed from one person to another, so the card draws
 * both: the author line at the top, the recipient on their own row, then the
 * chosen emoji and the message.
 *
 * ```
 * (П) Павел · 2 часа назад
 * Спасибо
 * Кому  (Л) Лиза
 * 🙏  спасибо, что полила цветы
 * ❤️ (М)                                    Обсудить
 * ```
 *
 * ## Why the eyebrow is a noun and the recipient row is labelled
 *
 * §D7.6 sketches the head line as «Павел сказал спасибо · (Л) Лизе». Both
 * halves of that need Russian morphology the client does not have: «сказал»
 * has to agree with the author's gender, and «Лизе» is a dative the roster
 * cannot decline. The backend already made exactly this call for the activity
 * log — `kudos.given` renders «Благодарность 🙏: Павел → Лиза» with the note
 * *"nominal on purpose: two names in one sentence would need a dative"* — so
 * this card follows the same rule rather than inventing a second one, and a
 * feminine author is never told she «сказал».
 *
 * The card is the whole record. **No total, no history, no «7 спасибо»** —
 * nowhere, including the accessible name (D5); the roster panel says only
 * *whether*.
 */
export function KudosCard(props: { kudos: KudosFeedItem; roster: Roster }) {
  const { kudos } = props;
  const target = { entityType: 'kudos' as const, entityId: kudos.id };

  return (
    <article className="flex w-full max-w-row-measure flex-col gap-1.5 px-4 py-3">
      <AuthorLine
        roster={props.roster}
        authorId={kudos.fromUserId}
        createdAt={kudos.createdAt}
        size="md"
      />

      <p className="text-[13px] leading-[18px] font-medium opacity-80">
        {WALL_RU.kudos.cardEyebrow}
      </p>

      <p className="flex min-w-0 items-center gap-2 text-[15px] leading-[22px]">
        <span className="shrink-0 text-[13px] leading-[18px] font-medium opacity-70">
          {WALL_RU.kudos.to}
        </span>
        <MemberDisc
          id={kudos.toUserId}
          displayName={kudos.toDisplayName}
          avatarUrl={props.roster.byId.get(kudos.toUserId)?.avatarUrl ?? null}
        />
        <span className="min-w-0 truncate font-medium">{kudos.toDisplayName}</span>
      </p>

      {kudos.message ? (
        <p className="flex min-w-0 items-start gap-2 text-[15px] leading-[22px] select-text [-webkit-touch-callout:default]">
          <span aria-hidden className="shrink-0 text-base leading-[22px]">
            {kudos.emoji}
          </span>
          <span className="min-w-0 flex-1 wrap-break-word whitespace-pre-wrap">
            {kudos.message}
          </span>
        </p>
      ) : (
        <p aria-hidden className="text-[22px] leading-7">
          {kudos.emoji}
        </p>
      )}

      <CommentThread
        target={target}
        commentCount={kudos.commentCount}
        actions={<ReactionBar target={target} reactions={kudos.reactions} roster={props.roster} />}
      />
    </article>
  );
}
