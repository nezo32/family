import { useState, type ComponentType, type ReactNode } from 'react';
import {
  BellOff,
  BellRing,
  ChevronRight,
  LogOut,
  Moon,
  Rss,
  Smartphone,
  TriangleAlert,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { ROLE_LABELS_RU } from '@family/shared';
import { PageHeader } from '@/shared/components/PageHeader';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { Button } from '@/shared/ui/button';
import { Card } from '@/shared/ui/card';
import { useCan } from '@/shared/auth/use-can';
import { useMe } from '@/shared/auth/use-me';
import { SETTINGS_NAV } from '@/app/layout/nav-items';
import { useTheme, type ThemeMode } from '@/app/theme-provider';
import { SubscribeDialog } from '@/features/calendar/components/SubscribePanel';
import { signOut } from '@/shared/api/refresh';
import { ROUTES } from '@/shared/lib/routes';
import { COMMON } from '@/shared/lib/i18n';
import { cn } from '@/shared/lib/utils';
import { SETTINGS_RU } from '../locale';
import { PushPrompt } from '../push/PushPrompt';
import { reportEnableOutcome } from '../push/enable-report';
import { usePush, type UsePushResult } from '../push/use-push';

const T = SETTINGS_RU.hub;

/**
 * The `/settings` index.
 *
 * Sub-pages are separate top-level route entries rather than nested `<Outlet>`
 * children, so each one is a full screen on a phone with its own back
 * behaviour. The list is filtered through `useCan()` — never `role ===` (D4).
 *
 * ## Why this is not just a list of three links
 *
 * It used to be exactly that, and on a real iPhone it read as an unfinished
 * placeholder: three words floating in tall empty bands, a full-width «Выйти из
 * аккаунта» as the loudest object on the screen, and the one genuinely useful
 * fact — whether notifications actually work on this device — set as grey text
 * under the card, where it looked like a footnote rather than something you can
 * act on.
 *
 * So: an identity block saying who you are signed in as and into which family,
 * rows at a normal list height each carrying a one-line subtitle, destinations
 * grouped by what they are *for*, and the push state promoted to a row whose
 * every state leads to the thing that fixes it. Signing out is a quiet,
 * auto-width control at the bottom — the one action here nobody comes looking
 * for.
 */
export default function SettingsPage() {
  const { can } = useCan();
  const { data: me } = useMe();
  const push = usePush();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);

  const items = SETTINGS_NAV.filter((item) => !item.perm || can(item.perm));
  const notificationItems = items.filter((item) => item.to === ROUTES.settingsNotifications);
  const accountItems = items.filter((item) => item.to !== ROUTES.settingsNotifications);

  return (
    <>
      <PageHeader title={T.title} description={T.description} />

      {/*
        `max-w-2xl`, left-aligned. The shell is 1024px wide on a desktop and a
        row of «Профиль …………………… ›» stretched across all of it put a word and its
        affordance 950px apart. A single column of rows has a readable measure
        whatever the window does; `mx-auto` is deliberately absent so this page
        keeps the same left edge as every other section.
      */}
      <div className="max-w-2xl space-y-6">
        {/*
          Who you are signed in as. Deliberately not a link: «Профиль» is a row
          below, and two routes to one screen is how a settings list starts
          feeling arbitrary.
        */}
        {me ? (
          <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
            <UserAvatar
              user={{
                id: me.user.id,
                displayName: me.user.displayName,
                avatarUrl: me.user.avatarUrl,
              }}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-foreground">
                {me.user.displayName}
              </p>
              <p className="truncate text-sm text-muted-foreground">
                {T.roleInFamily(ROLE_LABELS_RU[me.user.role], me.family.name)}
              </p>
            </div>
          </div>
        ) : null}

        <Section label={T.groupNotifications}>
          <PushStatusRow
            push={push}
            onEnable={() => {
              setPromptOpen(true);
            }}
          />
          {notificationItems.map((item) => (
            <NavRow key={item.to} to={item.to} icon={item.icon} label={item.label} />
          ))}
        </Section>

        {accountItems.length > 0 ? (
          <Section label={T.groupAccount}>
            {accountItems.map((item) => (
              <NavRow key={item.to} to={item.to} icon={item.icon} label={item.label} />
            ))}
          </Section>
        ) : null}

        <Section label={T.groupApp}>
          <ThemeRow />
          {/*
            The ICS feed is how most of this family actually reads the calendar —
            in the iPhone Calendar app, without opening the PWA. It lives on the
            calendar screen too; here is where somebody setting up a new phone
            goes looking for it. Gated by `useCan()`, never by `role ===`.
          */}
          {can('event:read') ? <CalendarFeedRow /> : null}
        </Section>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <Button
            variant="ghost"
            className="h-11 text-muted-foreground hover:text-destructive"
            onClick={() => {
              setConfirmSignOut(true);
            }}
          >
            <LogOut aria-hidden />
            {T.signOut}
          </Button>
          <p className="px-1 text-xs text-muted-foreground">{T.version(__APP_VERSION__)}</p>
        </div>
      </div>

      {/*
        The soft pre-prompt, reached from the push row above. Its «Разрешить» is
        the tap that reaches `pushManager.subscribe()`; see `PushPrompt` for why
        nothing may await in between.
      */}
      <PushPrompt
        open={promptOpen}
        onOpenChange={setPromptOpen}
        onAccept={() => {
          // Every outcome says something. This handler used to toast only on
          // success, so an already-`denied` permission — which resolves
          // instantly on iOS without ever showing the OS prompt — produced
          // literally nothing on screen. "Я нажимаю, и ничего не происходит"
          // was an accurate bug report.
          void push.enable().then(reportEnableOutcome);
        }}
      />

      <ConfirmDialog
        open={confirmSignOut}
        onOpenChange={setConfirmSignOut}
        title={T.signOutConfirmTitle}
        description={T.signOutConfirmText}
        confirmLabel={COMMON.signOut}
        onConfirm={() => signOut()}
      />
    </>
  );
}

/** A labelled group of rows. `gap-0`/`py-0` because `Card` ships 24px of both. */
function Section(props: { label: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.label}
      </h2>
      <Card className="gap-0 divide-y divide-border overflow-hidden p-0 py-0">
        {props.children}
      </Card>
    </section>
  );
}

/**
 * Subtitle for a settings destination.
 *
 * Keyed by route, not by index: `SETTINGS_NAV` is filtered through `useCan()`,
 * so positions shift and a parallel array would pair «Способы входа» with the
 * profile's subtitle for anyone missing a permission.
 */
function subtitleFor(to: string): string | null {
  if (to === ROUTES.settingsProfile) return T.subtitles.profile;
  if (to === ROUTES.settingsNotifications) return T.subtitles.notifications;
  if (to === ROUTES.settingsAccounts) return T.subtitles.accounts;
  return null;
}

function NavRow(props: { to: string; icon: ComponentType<{ className?: string }>; label: string }) {
  const Icon = props.icon;
  const subtitle = subtitleFor(props.to);

  return (
    <Link
      to={props.to}
      className="flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{props.label}</span>
        {subtitle ? (
          <span className="block text-xs text-pretty text-muted-foreground">{subtitle}</span>
        ) : null}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

/** Light / dark / system, inline. Three options do not deserve a sub-screen. */
function ThemeRow() {
  const { theme, setTheme } = useTheme();
  /*
   * Words only, no per-segment icons. A sun/moon/monitor glyph in each segment
   * costs 22px of a 103px column and truncated the third label at 390px; the
   * row already carries a glyph of its own, and «Светлая / Тёмная / Системная»
   * needs no picture to be understood.
   */
  const options: readonly ThemeMode[] = ['light', 'dark', 'system'];

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <Moon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{T.themeLabel}</p>
          <p className="text-xs text-pretty text-muted-foreground">{T.themeHint}</p>
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={T.themeLabel}
        /*
          One column below 380px, three above. `flex-1` alone does not survive
          320px: a flex item's `min-width` is `auto`, so «Как в системе» refuses
          to shrink and pushes the whole track out through the card's rounded
          edge. Three stacked 44px rows are perfectly legible on the narrowest
          phone; the segmented shape returns as soon as there is room for it.
        */
        className="mt-3 grid grid-cols-1 gap-1 rounded-lg bg-muted p-1 min-[380px]:grid-cols-3"
      >
        {options.map((option) => {
          const active = theme === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                setTheme(option);
              }}
              className={cn(
                'flex min-h-11 min-w-0 items-center justify-center rounded-md px-2 text-sm transition-colors',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                active
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="truncate">{T.themeOptions[option]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Entry point to the personal ICS feed, which otherwise only lives on /calendar. */
function CalendarFeedRow() {
  return (
    <SubscribeDialog
      trigger={
        <button
          type="button"
          className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
        >
          <Rss className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">{T.calendarFeedLabel}</span>
            <span className="block text-xs text-pretty text-muted-foreground">
              {T.calendarFeedSubtitle}
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      }
    />
  );
}

interface PushRowState {
  tone: 'ok' | 'warn' | 'idle';
  icon: ComponentType<{ className?: string }>;
  status: string;
  action: 'enable' | 'link' | 'none';
}

/** Which of the five push states this device is in, and what to offer for it. */
function pushRowState(push: UsePushResult): PushRowState {
  if (push.availability === 'unsupported') {
    return {
      tone: 'idle',
      icon: BellOff,
      status: SETTINGS_RU.push.statusUnsupported,
      action: 'none',
    };
  }
  if (push.availability === 'needs-install') {
    return {
      tone: 'warn',
      icon: Smartphone,
      status: SETTINGS_RU.push.statusNotInstalled,
      action: 'link',
    };
  }
  if (push.permission === 'denied') {
    return {
      tone: 'warn',
      icon: TriangleAlert,
      status: SETTINGS_RU.push.statusDenied,
      action: 'link',
    };
  }
  // iOS reports `permission: 'default'` here, so without this branch the row
  // would cheerfully offer «Включить» to somebody whose phone will never
  // prompt — the loop the research doc §17 warns about.
  if (push.blockedInSettings) {
    return {
      tone: 'warn',
      icon: TriangleAlert,
      status: SETTINGS_RU.push.failureTitle['blocked-in-settings'],
      action: 'link',
    };
  }
  if (push.needsReEnable) {
    return { tone: 'warn', icon: BellOff, status: SETTINGS_RU.push.reEnableTitle, action: 'link' };
  }
  if (push.isEnabled) {
    return { tone: 'ok', icon: BellRing, status: SETTINGS_RU.push.statusOn, action: 'link' };
  }
  return { tone: 'idle', icon: BellOff, status: SETTINGS_RU.push.statusOff, action: 'enable' };
}

/**
 * «На этом устройстве», as something you can act on.
 *
 * Every state ends somewhere useful. The one state that can be fixed from right
 * here — never asked — gets the soft pre-prompt inline; the rest link into
 * `/settings/notifications`, which holds the install steps, the denied-recovery
 * card and the re-enable button.
 */
function PushStatusRow(props: { push: UsePushResult; onEnable: () => void }) {
  const state = pushRowState(props.push);
  const Icon = state.icon;

  const body = (
    <>
      <Icon
        className={cn(
          'size-5 shrink-0',
          state.tone === 'ok' ? 'text-success' : 'text-muted-foreground',
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        {/* Not `truncate`: the status sentence is the point of this row, and
            «Нужно установить приложение» has to survive a 320px screen. */}
        <span className="block text-sm font-medium text-pretty text-foreground">
          {T.pushRowTitle}
        </span>
        <span className="block text-xs text-pretty text-muted-foreground">{state.status}</span>
      </span>
    </>
  );

  if (state.action === 'enable') {
    return (
      <div className="flex min-h-16 items-center gap-3 px-4 py-3">
        {body}
        <Button className="h-11 shrink-0" onClick={props.onEnable}>
          {T.pushEnableShort}
        </Button>
      </div>
    );
  }

  if (state.action === 'none') {
    return <div className="flex min-h-16 items-center gap-3 px-4 py-3">{body}</div>;
  }

  return (
    <Link
      to={ROUTES.settingsNotifications}
      className="flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
    >
      {body}
      <span className="shrink-0 text-sm font-medium text-primary">
        {state.tone === 'warn' ? T.pushFix : T.pushOpen}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}
