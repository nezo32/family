import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/utils';
import { useIsCompact } from '@/shared/hooks/use-compact-viewport';
import { useCoarsePointer } from '@/shared/ui/use-coarse-pointer';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/ui/sheet';

/**
 * The chrome the picker fields share with `Input`, and the surface their
 * pickers open on.
 *
 * ## Why the trigger is not an `<input>`
 *
 * `<input type="date">` and `<input type="time">` cannot be styled: iOS draws
 * its own value text, its own spinner and its own inline scroll region inside
 * the border box, all of them immune to the border, height and font the rest of
 * the form uses. Two of them side by side in a 2-column grid is where that goes
 * from ugly to broken — the native value box does not shrink below its content,
 * so it overflows its column, paints its scroll indicator over the neighbour's
 * left border, and the seam looks like a stray scrollbar between the fields.
 *
 * So the trigger here is a plain `<button>`: the app owns every pixel of it,
 * `min-w-0` actually applies, and the value inside is rendered by
 * `shared/lib/format.ts` like every other date in the app rather than by the
 * OS in whatever shape its locale settings happen to be in.
 *
 * ## Sizing
 *
 * `h-11` is 44px — the tap target minimum — and `text-base` is 16px, below
 * which iOS Safari zooms the viewport on focus and never zooms back out.
 * Deliberately no `md:text-sm`: a form field is not the place to save 2px.
 */
export const fieldShellClass = cn(
  'flex h-11 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-3 py-2',
  'text-left text-base shadow-xs transition-[color,box-shadow] outline-none dark:bg-input/30',
  'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
  'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
  'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
);

/**
 * A popover on a desktop, a bottom sheet on a phone — one API for both.
 *
 * This is a component choice rather than a CSS one, so it cannot be a media
 * query in a class list. It opens a sheet when **either** the pointer is coarse
 * or the viewport is compact, because those are two independent reasons a
 * popover is wrong:
 *
 * - a thumb needs a sheet at any size — gating on width alone handed a 1024px
 *   tablet a month grid in a popover, to be operated with a finger;
 * - a narrow window cannot fit a popover regardless of what is pointing at it.
 *
 * The width half breaks on Tailwind's `sm` (640px), the same line the date/time
 * pair stacks on, so a field and its picker never disagree about which device
 * they are on.
 */
export function PickerSurface(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The `<button>` that opens it. Must accept a ref and DOM props. */
  trigger: ReactNode;
  /** Sheet heading — also the picker's accessible name on a phone. */
  title: string;
  description: string;
  children: ReactNode;
  /** Extra classes for the popover surface only. */
  contentClassName?: string;
}) {
  // Both hooks run unconditionally: `||` short-circuits, so folding them into
  // one expression skips the second whenever the first is true and changes hook
  // order between renders.
  const coarsePointer = useCoarsePointer();
  const compactViewport = useIsCompact();
  const preferSheet = coarsePointer || compactViewport;

  if (preferSheet) {
    return (
      <Sheet open={props.open} onOpenChange={props.onOpenChange}>
        <SheetTrigger asChild>{props.trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          className={cn(
            'max-h-[85dvh] gap-0 rounded-t-2xl',
            // The home indicator sits over the last ~20px of the screen.
            'pb-[max(1rem,env(safe-area-inset-bottom))]',
          )}
        >
          <SheetHeader className="pb-2">
            <SheetTitle className="text-base">{props.title}</SheetTitle>
            <SheetDescription className="sr-only">{props.description}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
            {props.children}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger asChild>{props.trigger}</PopoverTrigger>
      <PopoverContent align="start" className={cn('w-auto p-0', props.contentClassName)}>
        {props.children}
      </PopoverContent>
    </Popover>
  );
}
