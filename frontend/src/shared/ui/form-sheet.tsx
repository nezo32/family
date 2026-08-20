import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { Button } from '@/shared/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog';
import {
  ResponsiveDialogBody,
  ResponsiveDialogDescription,
  ResponsiveDialogFrame,
  ResponsiveDialogTitle,
} from '@/shared/ui/responsive-dialog';
import { useCoarsePointer } from '@/shared/ui/use-coarse-pointer';

/**
 * The create/edit container (design §F3).
 *
 * ## The bug this component exists to make impossible
 *
 * Measured on the shipped build: «Новое событие» renders a 358 × **1640** px
 * dialog inside an 844 px phone, and 672 × **1198** inside a 900 px desktop
 * window. In both cases «Создать» — the one control the user opened the screen
 * to press — is **below the fold**. Every family member, roughly once a day,
 * fills in a form and then has to go looking for the button that submits it.
 *
 * The cause is structural, not cosmetic: the dialog is one scrolling box, so
 * the actions scroll with the fields, so any form long enough to scroll loses
 * its actions. No amount of shortening the form fixes that class of defect —
 * the next field someone adds brings it straight back.
 *
 * So the fix is structural too. The surface is a flex column of exactly three
 * parts:
 *
 * ```
 *   header   shrink-0     ← never scrolls
 *   body     min-h-0 flex-1 overflow-y-auto   ← the only scroller
 *   footer   shrink-0     ← never scrolls (fine pointers only)
 * ```
 *
 * The submit control is a **sibling** of the scroll container, never a
 * descendant of it. That is a property of the tree, not of a `sticky` rule that
 * some ancestor's `overflow` can quietly defeat, and it is what
 * `form-sheet.test.tsx` asserts.
 *
 * ## Where the primary action sits
 *
 * - **Coarse pointer** — a full-screen sheet with a fixed 56px header carrying
 *   `Отмена · title · Создать`. The sheet's own top offset already clears the
 *   status bar and `pb-safe` clears the home indicator. The thumb reaches the
 *   *top* of a phone sheet as readily as the bottom, iOS convention puts the
 *   commit there, and — decisively — a bottom action bar is exactly what the
 *   software keyboard covers.
 * - **Fine pointer** — a 520px dialog with the actions in a fixed footer,
 *   because that is where a desktop user looks for them. The header does not
 *   duplicate them.
 *
 * ## Draft survival
 *
 * iOS terminates backgrounded PWAs and returns a cold start at `start_url`
 * (research §8), and a half-filled create sheet is the most expensive thing in
 * this app to lose. Pass `draft` and the values are written to `sessionStorage`
 * on `visibilitychange → hidden` **and** `pagehide` (`beforeunload` is
 * unreliable on iOS), and restored the next time the sheet opens. Closing the
 * sheet — saved or cancelled — clears it; only backgrounding preserves it.
 */

const TEXT = {
  discardTitle: 'Не сохранять?',
  discardDescription: 'Введённое не сохранится.',
  discardConfirm: 'Не сохранять',
  discardCancel: 'Продолжить',
} as const;

export interface FormSheetDraft<T> {
  /** `sessionStorage` key. Make it stable per form *and* per edited entity. */
  key: string;
  /** Current values. Called at most once per backgrounding. */
  read: () => T;
  /** Called with a parsed draft when the sheet opens. */
  restore: (value: T) => void;
  /** Default `true`. Set `false` to suspend persistence (e.g. while saving). */
  enabled?: boolean;
}

export interface FormSheetProps<TDraft = unknown> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** «Новое событие» / «Изменить». Also the modal's accessible name. */
  title: string;
  /** Optional one line under the title. Fine pointers only — a phone sheet has no room. */
  description?: string;
  /** «Создать» / «Сохранить». Never changes while disabled (§F3). */
  submitLabel?: string;
  cancelLabel?: string;
  /**
   * `id` of the `<form>` this sheet's submit button belongs to. The button
   * lives *outside* the scroll container, so it cannot be a descendant of the
   * form — `form="…"` is how it stays a real submit button anyway, which keeps
   * Enter-to-submit and native validation working.
   */
  formId?: string;
  /** Used instead of `formId` when there is no `<form>` element. */
  onSubmit?: () => void;
  /** Disabled until the title is non-empty (§F3). The button keeps its place and its label. */
  submitDisabled?: boolean;
  /** In flight: the button is disabled but still says «Создать». */
  submitting?: boolean;
  /**
   * There is unsaved input. Drives the «Не сохранять?» guard on every dismissal
   * route — Отмена, overlay tap, Escape, drag-to-dismiss — and gates the draft
   * write.
   */
  dirty?: boolean;
  /** Persisted across an iOS background kill. See the note above. */
  draft?: FormSheetDraft<TDraft>;
  /**
   * Fixed under the header, above the scroll region: the recurrence-scope chip
   * (§F6), an offline banner. Not a place for fields.
   */
  banner?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}

export function FormSheet<TDraft = unknown>({
  open,
  onOpenChange,
  title,
  description,
  submitLabel = COMMON.create,
  cancelLabel = COMMON.cancel,
  formId,
  onSubmit,
  submitDisabled = false,
  submitting = false,
  dirty = false,
  draft,
  banner,
  children,
  bodyClassName,
}: FormSheetProps<TDraft>) {
  const coarse = useCoarsePointer();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // Read through refs inside the visibility listener so the listener does not
  // have to be re-bound on every keystroke of a form it is watching.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  /* ---------------------------------------------------------------- drafts */

  // Restore once per opening, before the user has typed anything.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    const current = draftRef.current;
    if (!open || !current || current.enabled === false) {
      if (!open) restoredFor.current = null;
      return;
    }
    if (restoredFor.current === current.key) return;
    restoredFor.current = current.key;
    try {
      const raw = window.sessionStorage.getItem(current.key);
      if (raw === null) return;
      current.restore(JSON.parse(raw) as TDraft);
    } catch {
      // A corrupt or unparseable draft is not worth an error path: the user
      // gets an empty form, which is exactly what they had before drafts.
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const persist = (): void => {
      const current = draftRef.current;
      if (!current || current.enabled === false || !dirtyRef.current) return;
      try {
        window.sessionStorage.setItem(current.key, JSON.stringify(current.read()));
      } catch {
        // Private mode / quota. Losing a draft is bad; crashing the sheet on
        // the way to the background is worse.
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') persist();
    };

    // Both, deliberately: `pagehide` fires on an iOS app switch that
    // `visibilitychange` sometimes misses, and `beforeunload`/`unload` are
    // unreliable in a standalone web app (research §8).
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', persist);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', persist);
    };
  }, [open]);

  // Closing is always deliberate — saved, or discarded past the guard — so the
  // draft goes. Only backgrounding (which never changes `open`) keeps it.
  useEffect(() => {
    if (open) return;
    const current = draftRef.current;
    if (!current) return;
    try {
      window.sessionStorage.removeItem(current.key);
    } catch {
      /* nothing to do */
    }
  }, [open]);

  /* --------------------------------------------------------- dismiss guard */

  const requestClose = useCallback(() => {
    if (dirtyRef.current) {
      setConfirmingDiscard(true);
      return;
    }
    onOpenChange(false);
  }, [onOpenChange]);

  const handleFrameOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChange(true);
        return;
      }
      requestClose();
    },
    [onOpenChange, requestClose],
  );

  const discard = useCallback(() => {
    setConfirmingDiscard(false);
    onOpenChange(false);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) {
      setConfirmingDiscard(false);
      setScrolled(false);
    }
  }, [open]);

  /* ---------------------------------------------------------------- render */

  const submitProps = formId
    ? ({ type: 'submit', form: formId } as const)
    : ({ type: 'button', onClick: onSubmit } as const);

  const body = (
    <ResponsiveDialogBody
      className={cn('px-4 pb-4', bodyClassName)}
      onScroll={(event) => {
        setScrolled(event.currentTarget.scrollTop > 0);
      }}
    >
      {children}
    </ResponsiveDialogBody>
  );

  return (
    <>
      <ResponsiveDialogFrame
        open={open}
        onOpenChange={handleFrameOpenChange}
        size="full"
      >
        {coarse ? (
          <header
            data-slot="form-sheet-header"
            className={cn(
              // shrink-0: the header is not allowed to be squeezed by a long
              // body, and it is not inside the scroller, so it cannot leave.
              //
              // Deliberately **no** `pt-safe` here, though §F3 asks for both it
              // and the sheet's top inset. A `size="full"` sheet already starts
              // at `max(env(safe-area-inset-top),12px) + 12px` from the top of
              // the viewport, i.e. below the status bar; adding the inset again
              // on the header would spend another 59px of an iPhone's screen
              // padding past a bar that has already been cleared. The two rules
              // in the spec are alternatives, not a pair.
              'shrink-0',
              // "border only when scrolled" (§F3): a hairline that appears when
              // there is content above it, so a short form has no seam.
              'border-b transition-colors',
              scrolled ? 'border-hairline' : 'border-transparent',
            )}
          >
            <div className="grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-2 px-1">
              <Button
                type="button"
                variant="ghost"
                onClick={requestClose}
                className="h-11 justify-self-start px-3 text-[17px] font-normal"
              >
                {cancelLabel}
              </Button>
              <ResponsiveDialogTitle className="min-w-0 truncate text-center text-[17px]">
                {title}
              </ResponsiveDialogTitle>
              <Button
                {...submitProps}
                variant="ghost"
                disabled={submitDisabled || submitting}
                className="h-11 justify-self-end px-3 text-[17px] font-semibold text-primary hover:text-primary"
              >
                {submitLabel}
              </Button>
            </div>
            {description ? (
              <ResponsiveDialogDescription className="sr-only">
                {description}
              </ResponsiveDialogDescription>
            ) : null}
          </header>
        ) : (
          <header data-slot="form-sheet-header" className="shrink-0 px-5 pt-5 pb-3">
            <ResponsiveDialogTitle className="text-[22px] leading-7">{title}</ResponsiveDialogTitle>
            {description ? (
              <ResponsiveDialogDescription className="mt-1">
                {description}
              </ResponsiveDialogDescription>
            ) : null}
          </header>
        )}

        {banner ? (
          <div data-slot="form-sheet-banner" className="shrink-0 px-4 pb-2">
            {banner}
          </div>
        ) : null}

        {body}

        {coarse ? null : (
          <footer
            data-slot="form-sheet-footer"
            className="flex shrink-0 justify-end gap-2 border-t border-hairline px-5 py-3"
          >
            <Button type="button" variant="ghost" onClick={requestClose}>
              {cancelLabel}
            </Button>
            <Button {...submitProps} disabled={submitDisabled || submitting}>
              {submitLabel}
            </Button>
          </footer>
        )}
      </ResponsiveDialogFrame>

      {/* Asked once, and only when there is something to lose (§F3). */}
      <AlertDialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{TEXT.discardTitle}</AlertDialogTitle>
            <AlertDialogDescription>{TEXT.discardDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{TEXT.discardCancel}</AlertDialogCancel>
            <AlertDialogAction onClick={discard}>{TEXT.discardConfirm}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
