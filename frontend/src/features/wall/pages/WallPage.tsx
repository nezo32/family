import { PageHeader } from '@/shared/components';
import { SideColumn } from '@/app/layout/SideColumn';
import { SectionStack } from '@/shared/ui/section';
import { BoardComposeButton, BoardComposeProvider } from '../components/BoardCompose';
import { ClearWallMenu } from '../components/ClearWallMenu';
import { DecidedPanel } from '../components/DecidedPanel';
import { KudosPanel } from '../components/KudosPanel';
import { WallStream } from '../components/WallStream';
import { WALL_RU } from '../locale';

/**
 * Стена — one continuous stream of cards (§D7, D13).
 *
 * **What the user came for:** "what did the family say, and does anything need
 * me."
 *
 * ## This screen used to be a board, and the reversal was deliberate
 *
 * Until §D7 it was twelve notes on one surface, ordered by meaning — open
 * questions → pinned → what happened — with a «Что было раньше» tail and no
 * composer anywhere. The owner asked for the opposite shape («как у VK или
 * instagram, не делить явно на секции»), and D13 records the decision so a
 * future reader does not repair it back.
 *
 * What did **not** change is the three things the board's refusals were
 * protecting, because a feed makes each failure more available, not less:
 *
 * 1. **An unbounded feed creates obligation.** So the feed ends, visibly
 *    («Это всё, что было»), auto-load is bounded to four pages before it asks,
 *    and there is no unread badge on the «Стена» tab, ever.
 * 2. **Recency buries the thing that needs answering.** So an unanswered poll
 *    and a live pin never enter the chronological body at all — they float in
 *    a head that does not move as the feed grows — and consecutive activity
 *    lines coalesce into one digest card.
 * 3. **A composer on screen invites chat.** So the compose affordance is a
 *    `<button>` at the top of a newest-first stream, not a field at the
 *    bottom. It cannot receive text and never raises the keyboard.
 *
 * ## One tree at every width
 *
 * Every composer is mounted once by `BoardComposeProvider`, so the panels are
 * pure functions of server state and `useTwoColumn` is not used here. The
 * `SideColumn` children are wrapped `hidden lg:block` rather than collapsing
 * to the foot of the page: content at the bottom of an unbounded stream is
 * dead weight that still costs two requests, and everything in those panels is
 * redundant with a card the reader scrolls past anyway (§D7.3a).
 */
export default function WallPage() {
  return (
    <BoardComposeProvider>
      <Wall />
    </BoardComposeProvider>
  );
}

function Wall() {
  return (
    <>
      {/*
        Band 1 is the app bar (§C2). «Написать» is the screen's one primary
        action from `md` up, where there is no tab bar and therefore no
        tap-the-active-tab-to-scroll-to-top gesture; below `md` the compose row
        *is* the door and a second copy of it in the bar would be the one
        deliberate duplication this screen refuses (§D7.5). The `⋯` beside it
        holds exactly one item, and only for `settings:manage`.
      */}
      <PageHeader
        title={WALL_RU.title}
        actions={
          <>
            <span className="hidden md:contents">
              <BoardComposeButton />
            </span>
            <ClearWallMenu />
          </>
        }
      />

      <WallStream />

      {/*
        §C4 / §D7.3a: **≥ lg only**, and both panels are indexes into the
        stream rather than routes to anything. Everything either one offers
        also exists as a card in the feed.
      */}
      <SideColumn>
        {/*
          `min-[1088px]`, not `lg:` — measured, not assumed. §D7.3a says the
          side column must not render at all below `lg`, where `lg` means "wide
          enough for the shell to give it a column of its own". `AppShell`'s
          grid turns two-column at **1088px**, not at Tailwind's 1024, so
          `hidden lg:block` left a 64px-wide band (1024–1087) in which both
          panels rendered *at the foot of an unbounded stream* — the one place
          §D7.3a says they must never be. Measured at 1024: 4616px of panel
          below 1454px of feed.
        */}
        <div className="hidden min-[1088px]:block">
          <SectionStack>
            <DecidedPanel />
            <KudosPanel />
          </SectionStack>
        </div>
      </SideColumn>
    </>
  );
}
