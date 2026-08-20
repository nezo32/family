import type { ComponentType, ReactNode } from 'react';

import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import {
  ResponsiveDialogBody,
  ResponsiveDialogDescription,
  ResponsiveDialogFrame,
  ResponsiveDialogTitle,
} from '@/shared/ui/responsive-dialog';

/**
 * The sheet a row's `⋯` opens — and the sheet a long-press opens (§G5).
 *
 * ## One surface, two doors
 *
 * §G1 is the rule this component is built around: *no capability is reachable
 * only by gesture*. So the sheet is never created by the long-press; it is
 * created by the row, and the long-press is a second way in. Every caller must
 * also give it a visible door — a `⋯` button, or the detail screen the row
 * already opens with a tap.
 *
 * ## Why not `DropdownMenu`
 *
 * A dropdown anchors itself to a 44px trigger and then renders 14px rows near
 * the top of the screen, which on a phone means reaching past your own hand to
 * hit a target the size of a word. §G7 says every modal is a bottom sheet on
 * `(pointer: coarse)`; `ResponsiveDialogFrame` already makes that decision, so
 * this is a thin composition over it rather than a fourth modal surface.
 *
 * Rows are 44px minimum, full width, left-aligned, icon first (§E `button.tsx`
 * `size="row"`, expressed here directly so this does not have to wait on a
 * change to a vendored file). The destructive row is last, separated, and
 * `tone="destructive"` — it never *performs* the deletion, it opens the
 * confirmation, because delete confirms whenever it removes more than one thing
 * and a sheet is not a confirmation.
 */
export interface ActionSheetItem {
  /** Stable across renders; used as the React key. */
  id: string;
  label: string;
  /** Second line: the consequence, in plain Russian. */
  hint?: string;
  icon?: ComponentType<{ className?: string }>;
  tone?: 'default' | 'destructive';
  disabled?: boolean;
  onSelect: () => void;
}

export function ActionSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row this sheet belongs to — «Вынести мусор», not «Действия». */
  title: string;
  /** Screen-reader context. Never rendered: a phone sheet has no room. */
  description?: string;
  items: readonly ActionSheetItem[];
  /** Rendered above the items — a status line, a member disc. */
  children?: ReactNode;
}) {
  // Nothing is filtered here: a permission-gated action is *absent* from the
  // array the caller builds, never present-but-hidden. A sheet that decides for
  // itself what to drop is a sheet whose contents no caller can predict.
  const items = props.items;

  return (
    <ResponsiveDialogFrame open={props.open} onOpenChange={props.onOpenChange} size="auto">
      <header className="shrink-0 px-4 pt-2 pb-1">
        <ResponsiveDialogTitle className="truncate">{props.title}</ResponsiveDialogTitle>
      </header>
      <ResponsiveDialogDescription className="sr-only">
        {props.description ?? COMMON.more}
      </ResponsiveDialogDescription>
      <ResponsiveDialogBody className="px-4 pb-4">
        {props.children ? <div className="pb-3">{props.children}</div> : null}
        <div className="flex flex-col">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                disabled={item.disabled ?? false}
                onClick={() => {
                  // Close first: every one of these opens something else (a
                  // confirm, an editor, a route), and two stacked sheets on a
                  // phone is one sheet nobody can dismiss.
                  props.onOpenChange(false);
                  item.onSelect();
                }}
                className={cn(
                  'flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2 text-left',
                  'text-[17px] leading-6 no-callout',
                  'touch-manipulation transition-colors',
                  'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                  'disabled:pointer-events-none disabled:opacity-50',
                  item.tone === 'destructive'
                    ? 'text-destructive hover:bg-destructive/10 active:bg-destructive/15'
                    : 'hover:bg-muted/50 active:bg-muted/70',
                )}
              >
                {Icon ? <Icon className="size-5 shrink-0" aria-hidden /> : null}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{item.label}</span>
                  {item.hint ? (
                    <span className="truncate text-[13px] leading-[18px] text-muted-foreground">
                      {item.hint}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </ResponsiveDialogBody>
    </ResponsiveDialogFrame>
  );
}
