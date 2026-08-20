import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePageSlots } from '@/app/layout/page-slots';
import { cn } from '../lib/utils';

/**
 * Standard heading block for a feature page — band 1 of §C2.
 *
 * Every screen under `AppShell` should start with one of these so the vertical
 * rhythm and the `<h1>` per page are consistent.
 *
 * ## Where it renders depends on the viewport (§C4)
 *
 * Below `md` it is what it has always been: a title, an optional description
 * and the actions, at the top of the page.
 *
 * From `md` up the **title and the actions move into `TopAppBar`** and this
 * component renders only the eyebrow and the description — or nothing at all,
 * if it has neither. The bar is 1200px of otherwise empty chrome on a desktop
 * and the page below was repeating the section name a second time; hoisting
 * band 1 into it removes both problems at once and buys back ~80px of vertical
 * space on every screen.
 *
 * The move is a portal, not a copy: `props.actions` is mounted exactly once, so
 * a create dialog behind an action button keeps one instance and one piece of
 * state whatever the viewport does. Outside `AppShell` (component tests, the
 * auth shell) nothing is hoisted and everything renders in place.
 */
export function PageHeader(props: {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons, filters — hoisted into the app bar on `≥ md`, in place below it. */
  actions?: ReactNode;
  /** Breadcrumb or back link, rendered above the title. Never hoisted. */
  eyebrow?: ReactNode;
  className?: string;
  /** Sticky under the app bar. Useful for list screens with a filter row. */
  sticky?: boolean;
}) {
  const slots = usePageSlots();
  const hoisted = slots.inShell && slots.hoist;

  const { registerPageTitle } = slots;
  useEffect(() => {
    if (!hoisted) return;
    // Tells `TopAppBar` to stand its nav-derived fallback title down. Released
    // on unmount, so a lazy route in flight gets the section name back rather
    // than an empty bar.
    return registerPageTitle();
  }, [hoisted, registerPageTitle]);

  /*
    With band 1 in the app bar, a header that carried nothing but a title would
    render as 40px of empty box above the content. Drop it entirely instead.
  */
  const hasInlineContent = hoisted
    ? props.eyebrow !== undefined || props.description !== undefined
    : true;

  return (
    <>
      {hoisted && slots.appBarTitle !== null
        ? createPortal(
            <h1 className="min-w-0 flex-1 truncate text-[17px] leading-6 font-semibold tracking-tight text-foreground">
              {props.title}
            </h1>,
            slots.appBarTitle,
          )
        : null}

      {hoisted && slots.appBarActions !== null && props.actions !== undefined
        ? createPortal(
            <div className="flex shrink-0 items-center gap-2">{props.actions}</div>,
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
            {!hoisted ? (
              <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
                {props.title}
              </h1>
            ) : null}
            {props.description ? (
              <p className="text-sm text-pretty text-muted-foreground">{props.description}</p>
            ) : null}
          </div>
          {!hoisted && props.actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{props.actions}</div>
          ) : null}
        </header>
      ) : null}
    </>
  );
}
