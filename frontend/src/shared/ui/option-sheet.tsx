import type { ReactNode } from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/shared/lib/utils';
import { COMMON } from '@/shared/lib/i18n';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Textarea } from '@/shared/ui/textarea';
import {
  ResponsiveDialogBody,
  ResponsiveDialogDescription,
  ResponsiveDialogFrame,
  ResponsiveDialogTitle,
  type ResponsiveDialogSize,
} from '@/shared/ui/responsive-dialog';

/**
 * The sheet a `ValueRow` opens, and the radio rows inside it (design §F4, §F5).
 *
 * ## Why a sheet and not more of the form
 *
 * Every option set bigger than a `SegmentedControl` used to be a `grid-cols-2`
 * of chips sitting in the middle of the create form. Five of those grids is how
 * «Новое событие» became 1640px tall on an 844px phone, and it is why «Создать»
 * was below the fold at *every* viewport tested, 1440x900 included.
 *
 * Moving them behind a row costs one tap for the family member who wants to
 * change «Повторение» — a minority of creations — and gives the common case a
 * form that fits on the screen with its submit button visible. The row still
 * *states the current value*, so nothing is hidden: «Повторение · не
 * повторяется ›» answers the question without opening anything.
 *
 * ## The rows
 *
 * Single column, 56px, hairline-separated, with the consequence of the choice
 * on a second line where a choice has one. An option that needs parameters
 * («раз в N недель») reveals them **inline under its own row**, never on a
 * second screen: a picker that opens another picker is where a user loses track
 * of what they were answering.
 */

export function PickerSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Screen-reader context. Never rendered — a phone sheet has no room. */
  description?: string;
  /** Defaults to «Готово»: the sheet commits as you tap, this only closes it. */
  doneLabel?: string;
  size?: ResponsiveDialogSize;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <ResponsiveDialogFrame
      open={props.open}
      onOpenChange={props.onOpenChange}
      size={props.size ?? 'auto'}
    >
      <header className="grid shrink-0 grid-cols-[1fr_auto] items-center gap-2 px-4 pt-2 pb-1">
        <ResponsiveDialogTitle className="min-w-0 truncate">{props.title}</ResponsiveDialogTitle>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            props.onOpenChange(false);
          }}
          className="h-11 px-3 text-[17px] font-semibold text-primary hover:text-primary"
        >
          {props.doneLabel ?? COMMON.done}
        </Button>
      </header>
      {props.description ? (
        <ResponsiveDialogDescription className="sr-only">
          {props.description}
        </ResponsiveDialogDescription>
      ) : null}
      <ResponsiveDialogBody className={cn('px-4 pb-4', props.bodyClassName)}>
        {props.children}
      </ResponsiveDialogBody>
    </ResponsiveDialogFrame>
  );
}

/**
 * `[&>*+*]` — every direct child after the first gets a 1px `--hairline` inset
 * by the row's own left padding, the same rule `Section` uses. Repeated here
 * rather than imported so a sheet does not have to pull in a page primitive.
 */
const INSET_HAIRLINE =
  "[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-0 [&>*+*]:before:top-0 [&>*+*]:before:ms-4 [&>*+*]:before:h-px [&>*+*]:before:bg-hairline [&>*+*]:before:content-['']";

/** A hairline-separated list of `OptionRow`s on one L1 surface. */
export function OptionList(props: {
  label?: string;
  /** `radiogroup` for a single choice, `group` when the rows are toggles. */
  role?: 'radiogroup' | 'group';
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col', props.className)}>
      {props.label ? (
        <span className="px-1 pb-2 text-[12px] leading-4 font-semibold tracking-[0.06em] text-muted-foreground uppercase">
          {props.label}
        </span>
      ) : null}
      <div
        role={props.role ?? 'radiogroup'}
        aria-label={props.label}
        className={cn('overflow-hidden rounded-xl border border-border bg-card', INSET_HAIRLINE)}
      >
        {props.children}
      </div>
    </div>
  );
}

export function OptionRow(props: {
  label: string;
  /** The consequence of this choice, in plain Russian. One line, two at most. */
  hint?: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  /** Leading glyph — a member disc, an emoji, a colour swatch. */
  leading?: ReactNode;
  /** Parameters revealed under this row while it is the selected one. */
  children?: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        role="radio"
        aria-checked={props.selected}
        disabled={props.disabled}
        onClick={props.onSelect}
        className={cn(
          'flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors',
          'touch-manipulation no-callout',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          'disabled:pointer-events-none disabled:opacity-50',
          'hover:bg-muted/40 active:bg-muted/60',
        )}
      >
        {props.leading ? <span className="shrink-0">{props.leading}</span> : null}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn('text-[17px] leading-6', props.selected && 'font-medium text-foreground')}
          >
            {props.label}
          </span>
          {props.hint ? (
            <span className="text-[13px] leading-[18px] text-pretty text-muted-foreground">
              {props.hint}
            </span>
          ) : null}
        </span>
        {/* A tick, not a filled pill: colour is never the only signal (§B4). */}
        <Check
          aria-hidden
          className={cn(
            'size-5 shrink-0 text-primary transition-opacity',
            props.selected ? 'opacity-100' : 'opacity-0',
          )}
        />
      </button>
      {props.selected && props.children ? (
        <div className="border-t border-hairline bg-muted/30 px-4 py-3">{props.children}</div>
      ) : null}
    </div>
  );
}

/**
 * A ValueRow's sheet when the value is free text — «Место», «Описание»,
 * «Категория», «Заметка».
 *
 * The field binds live rather than through a draft: «Готово» closes the sheet,
 * it does not commit, so there is exactly one copy of the value and no way for
 * a dismissal route (overlay tap, Escape, drag) to silently drop what was
 * typed. 17px on every surface — below 16 iOS zooms the viewport on focus and
 * never zooms back (§F2).
 */
export function TextSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Demonstrates, never instructs: «Например, ужин у бабушки» (§F7). */
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  maxLength?: number;
}) {
  return (
    <PickerSheet open={props.open} onOpenChange={props.onOpenChange} title={props.title}>
      {props.multiline ? (
        <Textarea
          autoFocus
          aria-label={props.title}
          rows={4}
          maxLength={props.maxLength}
          placeholder={props.placeholder}
          value={props.value}
          className="max-w-row-measure text-[17px] md:text-[17px]"
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        />
      ) : (
        <Input
          autoFocus
          aria-label={props.title}
          maxLength={props.maxLength}
          placeholder={props.placeholder}
          value={props.value}
          className="h-12 max-w-row-measure text-[17px] md:text-[17px]"
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            props.onOpenChange(false);
          }}
        />
      )}
    </PickerSheet>
  );
}

/**
 * A multi-select row. Same geometry as `OptionRow` with `role="checkbox"`,
 * because «которых пригласить» is a different question from «который выбрать»
 * and a screen reader must not hear them as the same control.
 */
export function ToggleRow(props: {
  label: string;
  hint?: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  leading?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={props.onToggle}
      className={cn(
        'flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors',
        'touch-manipulation no-callout',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-50',
        'hover:bg-muted/40 active:bg-muted/60',
      )}
    >
      {props.leading ? <span className="shrink-0">{props.leading}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[17px] leading-6">{props.label}</span>
        {props.hint ? (
          <span className="truncate text-[13px] leading-[18px] text-muted-foreground">
            {props.hint}
          </span>
        ) : null}
      </span>
      <Check
        aria-hidden
        className={cn(
          'size-5 shrink-0 text-primary transition-opacity',
          props.checked ? 'opacity-100' : 'opacity-0',
        )}
      />
    </button>
  );
}
