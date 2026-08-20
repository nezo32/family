import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Drawer as DrawerPrimitive } from 'vaul';

import { cn } from '@/shared/lib/utils';
import { useCoarsePointer } from '@/shared/ui/use-coarse-pointer';

/**
 * One modal, two surfaces: a centred `Dialog` under a mouse, a bottom `Drawer`
 * under a thumb.
 *
 * ## Why this exists at all
 *
 * A dialog is a box the pointer is already inside. A sheet is a surface that
 * arrives from the edge the thumb is nearest. They are not two skins of one
 * thing — the dismiss gesture, the safe areas, the height model and where the
 * primary action sits are all different — so the choice cannot be a media query
 * in a class list. It has to be a choice of *component*, which means it has to
 * be a hook, which means it has to be this file. (Design §C-gestures/G7, §E.)
 *
 * It gates on `(pointer: coarse)`, not `display-mode: standalone`; see
 * `use-coarse-pointer.ts` for why that distinction matters to this family.
 *
 * ## Contract
 *
 * Like Radix's own `Dialog.Content`, the surface does **not** render its own
 * title. Every consumer must render exactly one `<ResponsiveDialogTitle>`
 * inside it (add `className="sr-only"` if it should not be seen) or the modal
 * has no accessible name. `ResponsiveDialog` — the composed variant at the
 * bottom of this file — does it for you; `FormSheet` renders its own because
 * the title lives *between* Отмена and Создать in its header row.
 *
 * ## Sizes
 *
 * | size   | coarse                                  | fine                       |
 * |--------|-----------------------------------------|----------------------------|
 * | `full` | full screen less the top inset (§F3)     | 520 × min(80dvh, 720px)    |
 * | `tall` | 85dvh — detail sheets                    | 560 × min(80dvh, 720px)    |
 * | `auto` | content height, capped at 60dvh          | 440, content height        |
 *
 * The surface is always `flex flex-col overflow-hidden`. That is deliberate and
 * load-bearing: it makes "fixed header, scrolling body" the *default* way to
 * build content in here, which is the thing that stops a 1640px form from
 * pushing its «Создать» off the bottom of the screen.
 */
export type ResponsiveDialogSize = 'full' | 'tall' | 'auto';

const SurfaceContext = createContext<{ coarse: boolean } | null>(null);

function useSurface(): { coarse: boolean } {
  const ctx = useContext(SurfaceContext);
  if (!ctx) {
    throw new Error('ResponsiveDialog parts must be rendered inside <ResponsiveDialogFrame>');
  }
  return ctx;
}

const drawerSize: Record<ResponsiveDialogSize, string> = {
  // `dvh`, never `vh` (§F5): `vh` on iOS is the *large* viewport, so a sheet
  // sized in `vh` is taller than the screen it is on whenever the URL bar shows.
  //
  // Top inset (§F3): never flush with the physical edge, and never under the
  // status-bar clock in standalone — `max(safe-area-inset-top, 12px) + 12px`.
  //
  // **Written out as one literal string on purpose.** This was
  // `` `h-[calc(100dvh_-_(${SHEET_TOP_INSET}))]` `` — a template literal — and
  // Tailwind v4 finds classes by *scanning the source text*, so a class that is
  // only assembled at runtime is never generated. Verified against the built
  // CSS: `dist/assets/*.css` contained no rule for it at all, the sheet fell
  // back to content height, and a form long enough to exceed the screen would
  // have pushed its own header — and «Создать» with it — back off the top. That
  // is precisely the defect §F3 exists to make impossible, reintroduced by a
  // string interpolation. Never build a Tailwind class from a variable.
  //
  // The `- var(--viewport-keyboard,0px)` term in each is the keyboard
  // avoidance, and it is inside the *size* rather than a separate `max-h`
  // utility on purpose. As its own class it sorted **after** `max-h-[60dvh]`
  // in the built stylesheet and silently won, which let an `auto` sheet grow to
  // nearly the whole screen — verified in `dist/assets/*.css`, which is where
  // this file's other cautionary tale was verified too. One height declaration
  // per size, no ordering to reason about.
  //
  // With the sheet's bottom on `--viewport-keyboard` (see the surface below),
  // subtracting the same term here is what makes the keyboard *shorten* the
  // sheet instead of sliding its header off the top of the screen. On any
  // browser without a keyboard overlaying the page the property is absent, the
  // term is `- 0px`, and all three are exactly the sizes they were.
  full: 'h-[calc(100dvh_-_max(env(safe-area-inset-top,0px),0.75rem)_-_0.75rem_-_var(--viewport-keyboard,0px))]',
  tall: 'h-[min(85dvh,calc(100dvh_-_max(env(safe-area-inset-top,0px),0.75rem)_-_0.75rem_-_var(--viewport-keyboard,0px)))]',
  auto: 'max-h-[min(60dvh,calc(100dvh_-_max(env(safe-area-inset-top,0px),0.75rem)_-_0.75rem_-_var(--viewport-keyboard,0px)))]',
};

const dialogSize: Record<ResponsiveDialogSize, string> = {
  full: 'sm:max-w-[520px] max-h-[min(80dvh,720px)]',
  tall: 'sm:max-w-[560px] max-h-[min(80dvh,720px)]',
  auto: 'sm:max-w-[440px] max-h-[min(80dvh,640px)]',
};

export interface ResponsiveDialogFrameProps {
  open: boolean;
  /**
   * Called for every dismissal route — overlay tap, Escape, the drag handle,
   * and any `ResponsiveDialogClose`. A consumer that wants to *refuse* a
   * dismissal (an unsaved-input guard) simply does not flip `open`.
   */
  onOpenChange: (open: boolean) => void;
  size?: ResponsiveDialogSize;
  /** Classes for the surface itself. */
  className?: string;
  /** Must contain exactly one `<ResponsiveDialogTitle>`. */
  children: ReactNode;
  /**
   * `false` removes overlay-tap / Escape / drag dismissal entirely. Use it for
   * a modal that must be answered, not for one that merely wants to confirm —
   * a confirm is `onOpenChange` refusing to close.
   */
  dismissible?: boolean;
}

export function ResponsiveDialogFrame({
  open,
  onOpenChange,
  size = 'auto',
  className,
  children,
  dismissible = true,
}: ResponsiveDialogFrameProps) {
  const coarse = useCoarsePointer();

  if (coarse) {
    return (
      <SurfaceContext.Provider value={{ coarse: true }}>
        {/*
          `repositionInputs={false}`: vaul's own keyboard avoidance writes an
          inline `bottom` computed as `innerHeight - visualViewport.height`,
          with no `visualViewport.offsetTop` term and no `scroll` listener. iOS
          scrolls the visual viewport to reveal a focused input, so that offset
          becomes tens of pixels and is never recomputed — and the sheet is
          lifted that much too far, leaving a band of background beneath it for
          as long as it is open. That band is the photograph that came with the
          «снизу появляется отступ» report. `--viewport-keyboard` in
          `viewport-insets.ts` is the same measurement with the missing term,
          updated on `scroll` as well, and it is applied in CSS below.
        */}
        <DrawerPrimitive.Root
          open={open}
          onOpenChange={onOpenChange}
          dismissible={dismissible}
          repositionInputs={false}
        >
          <DrawerPrimitive.Portal>
            <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
            <DrawerPrimitive.Content
              data-slot="responsive-dialog"
              data-surface="sheet"
              data-size={size}
              className={cn(
                // `bottom-above-keyboard`, not `bottom-0`: see `index.css`.
                // The sheet is the surface the reported gap was photographed
                // under, and it has to stay reachable while a keyboard is up.
                'fixed inset-x-0 bottom-above-keyboard z-50 flex flex-col overflow-hidden outline-none',
                // L2 (§B3): --popover, 1px border, radius 16. The shadow is the
                // only one in the system that is allowed to exist.
                'rounded-t-2xl border-t border-border bg-popover text-popover-foreground',
                'shadow-[0_12px_32px_-12px_rgb(0_0_0_/_0.28)]',
                // The surface reaches the physical edge; its *content* stops at
                // the inset. `pb-safe` is an `@utility`, so it survives under
                // variants — see the note in `index.css`.
                'px-safe pb-safe',
                drawerSize[size],
                className,
              )}
            >
              {dismissible ? (
                <DrawerPrimitive.Handle
                  data-slot="responsive-dialog-handle"
                  // 36 x 4 (§F3). Every utility here is `!`-important on
                  // purpose: vaul injects `[data-vaul-handle]{height:5px;
                  // width:32px;background:#e2e2e4}` as an *unlayered* <style>,
                  // and unlayered CSS beats anything in `@layer utilities`
                  // whatever its specificity. Without the important flag this
                  // handle silently stays vaul's grey 32x5.
                  className="mt-2! mb-1! h-1! w-9! shrink-0 rounded-full! bg-hairline! opacity-100!"
                />
              ) : null}
              {children}
            </DrawerPrimitive.Content>
          </DrawerPrimitive.Portal>
        </DrawerPrimitive.Root>
      </SurfaceContext.Provider>
    );
  }

  return (
    <SurfaceContext.Provider value={{ coarse: false }}>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content
            data-slot="responsive-dialog"
            data-surface="dialog"
            data-size={size}
            onEscapeKeyDown={dismissible ? undefined : (e) => e.preventDefault()}
            onInteractOutside={dismissible ? undefined : (e) => e.preventDefault()}
            className={cn(
              // Centred on the viewport, but the viewport in standalone runs
              // under the status bar and the home indicator: shift the centre by
              // half the difference so the leftover space is shared between them
              // instead of all landing at the bottom.
              'fixed top-[calc(50%_+_(env(safe-area-inset-top,0px)_-_env(safe-area-inset-bottom,0px))_/_2)] left-1/2 z-50',
              '-translate-x-1/2 -translate-y-1/2',
              'flex w-full max-w-[calc(100%-2rem)] flex-col overflow-hidden outline-none',
              'rounded-2xl border border-border bg-popover text-popover-foreground',
              'shadow-[0_12px_32px_-12px_rgb(0_0_0_/_0.28)]',
              'duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
              dialogSize[size],
              className,
            )}
          >
            {children}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </SurfaceContext.Provider>
  );
}

/** The modal's accessible name. Exactly one per surface. */
export function ResponsiveDialogTitle({ className, ...props }: ComponentProps<'h2'>) {
  const { coarse } = useSurface();
  const merged = cn('font-display text-[17px] leading-6 font-semibold', className);
  return coarse ? (
    <DrawerPrimitive.Title data-slot="responsive-dialog-title" className={merged} {...props} />
  ) : (
    <DialogPrimitive.Title data-slot="responsive-dialog-title" className={merged} {...props} />
  );
}

export function ResponsiveDialogDescription({ className, ...props }: ComponentProps<'p'>) {
  const { coarse } = useSurface();
  const merged = cn('text-[15px] leading-[22px] text-muted-foreground', className);
  return coarse ? (
    <DrawerPrimitive.Description
      data-slot="responsive-dialog-description"
      className={merged}
      {...props}
    />
  ) : (
    <DialogPrimitive.Description
      data-slot="responsive-dialog-description"
      className={merged}
      {...props}
    />
  );
}

/**
 * The scrolling region. **This is the component that keeps the primary action
 * on screen**: `min-h-0 flex-1` inside the surface's flex column means the body
 * — and only the body — absorbs content taller than the viewport. Anything
 * rendered as a *sibling* of this (a header, a footer) is fixed by
 * construction, not by a `sticky` that can be defeated by an ancestor's
 * `overflow`.
 */
export function ResponsiveDialogBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="responsive-dialog-body"
      data-scroll-pane=""
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
      {...props}
    />
  );
}

/** Close trigger wired to whichever primitive is on screen. */
export function ResponsiveDialogClose(props: ComponentProps<typeof DialogPrimitive.Close>) {
  const { coarse } = useSurface();
  return coarse ? (
    <DrawerPrimitive.Close data-slot="responsive-dialog-close" {...props} />
  ) : (
    <DialogPrimitive.Close data-slot="responsive-dialog-close" {...props} />
  );
}

/**
 * Read the surface from inside a modal — for the handful of children that must
 * genuinely differ (a picker that becomes a full-width list on a phone). Prefer
 * a CSS media query when the difference is only visual.
 */
export function useResponsiveSurface(): 'sheet' | 'dialog' {
  return useSurface().coarse ? 'sheet' : 'dialog';
}

export interface ResponsiveDialogProps extends Omit<ResponsiveDialogFrameProps, 'children'> {
  title: string;
  description?: string;
  /** Rendered under the header, inside the scrolling body. */
  children: ReactNode;
  /** Rendered fixed at the bottom on both surfaces. Buttons, usually. */
  footer?: ReactNode;
  bodyClassName?: string;
}

/**
 * The composed form: title, optional description, scrolling body, fixed footer.
 * Reach for `ResponsiveDialogFrame` directly only when the header has to be
 * something other than a title — which in this app is exactly one case,
 * `FormSheet`.
 */
export function ResponsiveDialog({
  title,
  description,
  children,
  footer,
  bodyClassName,
  ...frame
}: ResponsiveDialogProps) {
  return (
    <ResponsiveDialogFrame {...frame}>
      <div className="shrink-0 px-4 pt-4 pb-2">
        <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
        {description ? (
          <ResponsiveDialogDescription className="mt-1">{description}</ResponsiveDialogDescription>
        ) : null}
      </div>
      <ResponsiveDialogBody className={cn('px-4 pb-4', bodyClassName)}>
        {children}
      </ResponsiveDialogBody>
      {footer ? (
        <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-hairline px-4 py-3 sm:flex-row sm:justify-end">
          {footer}
        </div>
      ) : null}
    </ResponsiveDialogFrame>
  );
}
