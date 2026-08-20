import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Heart, Megaphone, PenLine, Vote } from 'lucide-react';
import type { Permission } from '@family/shared';
import { useCan } from '@/shared/auth';
import { Button } from '@/shared/ui/button';
import { ActionSheet, type ActionSheetItem } from '@/shared/ui/action-sheet';
import { useCoarsePointer } from '@/shared/ui/use-coarse-pointer';
import { usePrefersReducedMotion } from '@/shared/ui/use-reduced-motion';
import { WALL_RU } from '../locale';
import { AnnouncementComposer } from './AnnouncementComposer';
import { KudosComposer } from './KudosComposer';
import { PollComposer } from './PollComposer';

/**
 * The board's one door — and the reason Стена no longer needs a different
 * component tree per width.
 *
 * ## The problem this solves
 *
 * Стена used to mount `useTwoColumn()` and render two different trees: a
 * tabbed phone layout and a feed-plus-side-column desktop one. The reason was
 * never the layout. It was that «Спасибо» and «Опросы» each owned a *composer*
 * with typed state, so rendering both copies — the cheap, declarative thing
 * every other screen does — would have given one half-written poll question two
 * places to live.
 *
 * Hoisting all three composers here fixes the cause rather than the symptom.
 * The panels below are now pure functions of server state: they can be rendered
 * anywhere, twice, or not at all, and nothing can desynchronise because none of
 * them owns anything. `useTwoColumn` is gone from this screen.
 *
 * ## Why one button and not three
 *
 * A board holds three kinds of note — an announcement, a question, a thank-you
 * — and they are pinned up by the same hand. One primary action keeps §B4's
 * "one filled primary per view" and, decisively, keeps all three flows exactly
 * two taps from the app bar *at every width*. That matters because the panels
 * these actions belong to no longer sit in the same place at every width: on a
 * phone «Спасибо» is below the board, and a «Сказать спасибо» button that lives
 * only in that panel's header would be a screen-and-a-half away.
 *
 * It also removes the defect the previous pass flagged and could not fix: two
 * panels whose empty states had no sensible action, because each panel's own
 * invitation already sat 60px above it in its own header. Every empty state on
 * this screen now points at the same door, and there is exactly one instance of
 * each composer behind it.
 *
 * When the reader holds exactly one of the three permissions the menu is
 * skipped entirely and the button opens that composer — a menu with one item
 * is a tap tax, and a child (who may write and may thank, but may not create a
 * poll) should not pay it twice.
 */

export type ComposeKind = 'post' | 'poll' | 'kudos';

interface BoardCompose {
  /** Opens one composer. Safe to call for a kind the reader may not use — it no-ops. */
  open: (kind: ComposeKind) => void;
  /** Opens the menu, or the single composer when only one kind is available. */
  start: () => void;
  /** What this reader may actually put on the board, in menu order. */
  available: readonly ComposeKind[];
}

const BoardComposeContext = createContext<BoardCompose | null>(null);

/**
 * `null` outside the provider rather than a throw: a component test that
 * renders one panel on its own should show the panel, not an error boundary.
 */
export function useBoardCompose(): BoardCompose {
  return (
    useContext(BoardComposeContext) ?? {
      open: () => undefined,
      start: () => undefined,
      available: [],
    }
  );
}

const PERMISSION_OF: Record<ComposeKind, Permission> = {
  post: 'post:create',
  poll: 'poll:create',
  kudos: 'kudos:give',
};

const ORDER: readonly ComposeKind[] = ['post', 'poll', 'kudos'];

const MENU: Record<ComposeKind, { label: string; hint: string; icon: typeof Megaphone }> = {
  post: { label: WALL_RU.compose.post, hint: WALL_RU.compose.postHint, icon: Megaphone },
  poll: { label: WALL_RU.compose.poll, hint: WALL_RU.compose.pollHint, icon: Vote },
  kudos: { label: WALL_RU.compose.kudos, hint: WALL_RU.compose.kudosHint, icon: Heart },
};

/**
 * How long the menu takes to leave, so the composer can arrive after it.
 *
 * The two surfaces **must not overlap**, and not merely because two sheets
 * cross-fading on a phone looks wrong. Both are Radix dismissable layers, and
 * only the highest layer answers Escape or a drag-to-dismiss. While the
 * outgoing menu is still animating out it is still *on* that stack, so a
 * dismissal aimed at the composer lands on a sheet that is already leaving and
 * nothing happens. Measured against the built app on WebKit: with both layers
 * present the dismissal is a coin toss, and the e2e caught it as a flake before
 * a user would have caught it as "the back gesture did nothing".
 *
 * The numbers are the surfaces' own exit durations: vaul's bottom drawer
 * transitions for 500 ms, the fine-pointer dialog for 200 ms
 * (`responsive-dialog.tsx`). This also gives the native sequence — the sheet
 * you answered leaves, then the one you asked for arrives — instead of a
 * cross-fade of two different modals.
 *
 * `prefers-reduced-motion` is reset globally in `index.css`, so there is no
 * exit animation to wait for and the handoff is immediate (§F11).
 */
const SHEET_HANDOFF_MS = { coarse: 520, fine: 220 } as const;

export function BoardComposeProvider(props: { children: ReactNode }) {
  const { can } = useCan();
  const coarse = useCoarsePointer();
  const reducedMotion = usePrefersReducedMotion();
  const [composing, setComposing] = useState<ComposeKind | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const handoff = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (handoff.current !== null) clearTimeout(handoff.current);
    },
    [],
  );

  // Gating goes through `useCan()`; nothing here looks at a role (D4). A child
  // holds `post:create` and `kudos:give` but not `poll:create`, so the menu
  // they see has two rows and never mentions the third.
  const available = useMemo(
    () => ORDER.filter((kind) => can(PERMISSION_OF[kind])),
    // `can` is rebuilt whenever the permission set changes, which is exactly
    // when this list may change.
    [can],
  );

  const open = useCallback(
    (kind: ComposeKind) => {
      if (!can(PERMISSION_OF[kind])) return;
      setComposing(kind);
    },
    [can],
  );

  const start = useCallback(() => {
    const only = available.length === 1 ? available[0] : undefined;
    if (only) {
      setComposing(only);
      return;
    }
    if (available.length === 0) return;
    setMenuOpen(true);
  }, [available]);

  const value = useMemo<BoardCompose>(() => ({ open, start, available }), [open, start, available]);

  const items: ActionSheetItem[] = available.map((kind) => ({
    id: kind,
    label: MENU[kind].label,
    hint: MENU[kind].hint,
    icon: MENU[kind].icon,
    onSelect: () => {
      // `ActionSheet` has already asked the menu to close; let it finish.
      if (handoff.current !== null) clearTimeout(handoff.current);
      handoff.current = setTimeout(
        () => {
          setComposing(kind);
        },
        reducedMotion ? 0 : SHEET_HANDOFF_MS[coarse ? 'coarse' : 'fine'],
      );
    },
  }));

  const close = useCallback((next: boolean) => {
    if (!next) setComposing(null);
  }, []);

  return (
    <BoardComposeContext.Provider value={value}>
      {props.children}

      {/*
        One instance of each, mounted by the page rather than by a panel. This
        is the whole point of the file: a composer that belongs to the screen
        cannot be duplicated by the layout, and a draft cannot end up in the
        copy that is currently hidden.
      */}
      <ActionSheet
        open={menuOpen}
        onOpenChange={setMenuOpen}
        title={WALL_RU.compose.menuTitle}
        description={WALL_RU.compose.menuDescription}
        items={items}
      />
      <AnnouncementComposer open={composing === 'post'} onOpenChange={close} />
      <PollComposer open={composing === 'poll'} onOpenChange={close} />
      <KudosComposer open={composing === 'kudos'} onOpenChange={close} />
    </BoardComposeContext.Provider>
  );
}

/**
 * The board's primary action, hoisted into the app bar by `PageHeader` (§C2).
 *
 * Renders nothing for a reader who may not put anything on the board — a guest
 * gets a board they can read, not a button that 403s.
 */
export function BoardComposeButton() {
  const compose = useBoardCompose();
  if (compose.available.length === 0) return null;

  return (
    <Button type="button" className="h-11" onClick={compose.start}>
      <PenLine className="size-4" aria-hidden />
      {WALL_RU.compose.open}
    </Button>
  );
}

/**
 * The same door, as a secondary control — an empty state's way out, a panel
 * header's invitation. Never a second filled primary (§B4).
 */
export function BoardComposeInvite(props: {
  kind: ComposeKind;
  label?: string;
  variant?: 'secondary' | 'ghost' | 'outline';
  className?: string;
}) {
  const compose = useBoardCompose();
  if (!compose.available.includes(props.kind)) return null;

  return (
    <Button
      type="button"
      variant={props.variant ?? 'secondary'}
      className={props.className ?? 'h-11'}
      onClick={() => {
        compose.open(props.kind);
      }}
    >
      {props.label ?? MENU[props.kind].label}
    </Button>
  );
}
