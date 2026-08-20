import { PageHeader } from '@/shared/components';
import { SideColumn } from '@/app/layout/SideColumn';
import { SectionStack } from '@/shared/ui/section';
import { isAnsweredByMe, pinnedFrom, usePolls, useWallFeed } from '../hooks';
import { BoardComposeButton, BoardComposeProvider } from '../components/BoardCompose';
import { DecidedPanel } from '../components/DecidedPanel';
import { KudosPanel } from '../components/KudosPanel';
import { PollBoard } from '../components/PollBoard';
import { WallStream } from '../components/WallStream';
import { WALL_RU } from '../locale';

/**
 * Стена — «кухонная доска»: the note surface by the front door.
 *
 * **What the user came for:** "what did the family say, and does anything need
 * me."
 *
 * ## It is a board, and it is deliberately not a chat
 *
 * The README's line is the spine of this screen: *announcements, comments on
 * anything, kudos and polls — deliberately not a chat, Telegram already
 * exists.* Three structural decisions follow from that, and each of them is a
 * thing this screen refuses to do:
 *
 * 1. **No composer on screen.** There is no text field anywhere on the board.
 *    Writing starts from the app bar's one door (`BoardCompose`), and the only
 *    field that ever appears in the page is inside a discussion somebody
 *    deliberately opened. A message box pinned to the bottom of the screen is
 *    the single feature that would make this Telegram with fewer people in it.
 * 2. **The board is finite.** Twelve notes and a quiet «Что было раньше», never
 *    an auto-loading stream. A board holds what is currently up.
 * 3. **Order is meaning, not recency.** Open questions first, then what is
 *    pinned, then what has happened. A chat has exactly one ordering and it is
 *    the clock.
 *
 * ## One tree at every width (this used to be the exception)
 *
 * Стена was the only screen in the app that mounted a *different component
 * tree* per width — `useTwoColumn()`, tabs on a phone, feed-plus-side-column on
 * a desktop. The reason was never the layout. It was that «Спасибо» and
 * «Опросы» each owned a composer with typed state, so the cheap declarative fix
 * (render both, hide one with a class) would have given one half-written poll
 * question two places to live; and the other cheap fix (let the side column
 * collapse under the main one, as it does everywhere else) put «Опросы» behind
 * an infinite scroll.
 *
 * Both causes are gone rather than worked around. Every composer is hoisted
 * here, mounted exactly once (`BoardComposeProvider`), so the panels below are
 * pure functions of server state; and the board no longer auto-loads, so the
 * side column that collapses beneath it is one flick away rather than
 * unreachable. What is left is the same tree the rest of the app renders, and
 * `useTwoColumn` is not imported by this feature any more.
 *
 * ## Band 2 (§C2) — one loud thing, chosen by precedence
 *
 * **An open poll nobody has answered → a pinned announcement → nothing.**
 * Whichever wins gets the clay `--surface-attention` wash; the loser renders as
 * an ordinary section and keeps saying what it is in words (📌 «закреплено до
 * 25 августа»), because colour is never the only signal (§B4). Two tinted
 * blocks stacked would be two loud things, which is the failure band 2 exists
 * to prevent.
 */
export default function WallPage() {
  return (
    <BoardComposeProvider>
      <Board />
    </BoardComposeProvider>
  );
}

function Board() {
  /*
    Both queries are read here as well as inside the sections that render them.
    TanStack dedupes on the key, so this costs nothing — and band 2's precedence
    is a decision about the *screen*, which means it cannot be made by either of
    the two sections competing for it.
  */
  const feed = useWallFeed();
  const polls = usePolls('open');

  const pinned = pinnedFrom(feed.data);
  const openPolls = polls.data?.pages.flatMap((page) => page.items) ?? [];
  const someoneIsWaiting = openPolls.some((poll) => !isAnsweredByMe(poll));

  return (
    <>
      <PageHeader title={WALL_RU.title} actions={<BoardComposeButton />} />

      <SectionStack>
        <PollBoard surface={someoneIsWaiting ? 'attention' : 'card'} />
        <WallStream pinnedSurface={!someoneIsWaiting && pinned.length > 0 ? 'attention' : 'card'} />
      </SectionStack>

      {/*
        §C4. Both panels are read-only summaries of server state, which is what
        lets them live in the shell's `<aside>` — beside the board from 1088px
        up, and at the foot of it below that — as **one** instance, portalled
        rather than duplicated (`SideColumn`).
      */}
      <SideColumn>
        <SectionStack>
          <KudosPanel />
          <DecidedPanel />
        </SectionStack>
      </SideColumn>
    </>
  );
}
