import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePageSlots, type TitlePlacement } from '@/app/layout/page-slots';
import { cn } from '../lib/utils';

/**
 * Standard heading block for a feature page — band 1 of §C2.
 *
 * Every screen under `AppShell` should start with one of these so the vertical
 * rhythm and the `<h1>` per page are consistent.
 *
 * ## Band 1 lives in the app bar, at every width (§C2, §D2)
 *
 * The title and the screen's one primary action are portalled into
 * `TopAppBar`; this component then renders only the eyebrow and the
 * description — or nothing at all, if it has neither.
 *
 * The hoist used to start at `md`, which left a phone showing the section name
 * in the bar and the page's own `<h1>` 8px underneath it: «Задачи», «Семья» and
 * «Копилки» each rendered twice on the screen where the duplication is least
 * affordable. §D2's phone sketch (`‹ Задачи   ⊕   🔔`) is the target at every
 * width, so the gate is gone.
 *
 * The move is a portal, not a copy: `props.actions` is mounted exactly once, so
 * a create dialog behind an action button keeps one instance and one piece of
 * state whatever the viewport does. Outside `AppShell` (component tests, the
 * auth shell) nothing is hoisted and everything renders in place.
 *
 * ## The one exception: `displayTitle`
 *
 * Сегодня's greeting is the page's *display* line below `md` (§B2 `display`,
 * 28/34 — §D1: "the display line stays in the main column only below md") and
 * the same node is the bar title from `md` up. `displayTitle` keeps it in the
 * page on a phone; the bar then names the section instead, as a plain heading
 * rather than a second `<h1>`.
 */
export function PageHeader(props: {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons, filters — hoisted into the app bar. */
  actions?: ReactNode;
  /** Breadcrumb or back link, rendered above the title. Never hoisted. */
  eyebrow?: ReactNode;
  /**
   * This title is the screen's one display line below `md` and belongs in the
   * page there, not in a 56px bar. Сегодня only.
   */
  displayTitle?: boolean;
  className?: string;
  /** Sticky under the app bar. Useful for list screens with a filter row. */
  sticky?: boolean;
}) {
  const slots = usePageSlots();

  // Outside the shell there is no bar to hoist into, and a display title stays
  // in the page until the viewport is wide enough for the bar to hold it.
  const titleInBar = slots.inShell && !(props.displayTitle === true && !slots.desktop);
  // Actions have nowhere else to be once the title is gone from the page, so
  // they follow the shell rather than the title.
  const actionsInBar = slots.inShell;

  const { registerPageTitle } = slots;
  const placement: TitlePlacement = titleInBar ? 'bar' : 'page';
  useEffect(() => {
    if (!slots.inShell) return;
    // Tells `TopAppBar` whether its nav-derived fallback is the page title
    // (`<h1>`), merely the section name (`<h2>`, the page owns the `<h1>`), or
    // not needed at all. Released on unmount, so a lazy route in flight gets
    // the section name back rather than an empty bar.
    return registerPageTitle(placement);
  }, [slots.inShell, placement, registerPageTitle]);

  /*
    With band 1 in the app bar, a header that carried nothing but a title would
    render as 40px of empty box above the content. Drop it entirely instead.
  */
  const hasInlineContent =
    !titleInBar || props.eyebrow !== undefined || props.description !== undefined;

  return (
    <>
      {titleInBar && slots.appBarTitle !== null
        ? createPortal(
            <h1 className="min-w-0 flex-1 truncate font-display text-[17px] leading-6 font-semibold tracking-tight text-foreground">
              {props.title}
            </h1>,
            slots.appBarTitle,
          )
        : null}

      {actionsInBar && slots.appBarActions !== null && props.actions !== undefined
        ? createPortal(
            <div
              className={cn(
                'flex shrink-0 items-center gap-2',
                /*
                  §E: "actions collapse to a single icon button below `sm`".
                  A 393px bar cannot hold «+ Новое дело» *and* a readable title
                  next to a bell and an avatar, so below `sm` any action button
                  that carries an icon becomes a 44px icon-only target: the
                  label collapses to zero width but stays in the DOM, so the
                  accessible name — the thing every e2e query and every screen
                  reader uses — is unchanged. Buttons without an icon (the
                  «я в магазине» switch) have nothing to fall back to and are
                  left alone.
                */
                'max-sm:[&_button:has(svg)]:size-11 max-sm:[&_button:has(svg)]:justify-center',
                'max-sm:[&_button:has(svg)]:gap-0 max-sm:[&_button:has(svg)]:p-0',
                'max-sm:[&_button:has(svg)]:text-[0px]',
              )}
            >
              {props.actions}
            </div>,
            slots.appBarActions,
          )
        : null}

      {hasInlineContent ? (
        <header
          className={cn(
            'flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4',
            props.sticky && 'bg-background/85 sticky top-0 z-20 pt-1 backdrop-blur-sm',
            props.className,
          )}
        >
          <div className="min-w-0 space-y-1">
            {props.eyebrow ? (
              <div className="text-xs font-medium text-muted-foreground">{props.eyebrow}</div>
            ) : null}
            {!titleInBar ? (
              <h1 className="truncate font-display text-[22px] leading-7 font-bold tracking-tight text-foreground">
                {props.title}
              </h1>
            ) : null}
            {props.description ? (
              <p className="text-sm text-pretty text-muted-foreground">{props.description}</p>
            ) : null}
          </div>
          {!actionsInBar && props.actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{props.actions}</div>
          ) : null}
        </header>
      ) : null}
    </>
  );
}
