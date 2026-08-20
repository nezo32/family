import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/textarea';
import { cn } from '@/shared/lib/utils';
import { SHOPPING_RU } from '../locale';
import { draftFromParsed, type ItemDraft } from '../grouping';
import { parseQuickAddLine, parseQuickAddText } from '@family/shared';
import { useProductSuggestions } from '../hooks';

/**
 * Six lines of 16px text plus the field's padding and border. Past this the box
 * scrolls instead of growing: on a 390px phone a taller composer starts eating
 * the list it is meant to be adding to.
 */
const MAX_FIELD_HEIGHT = 160;

/**
 * Quick add — one field, one tap.
 *
 * «2 кг картошки», «молоко 3 шт», «хлеб», one item per line. The text is parsed
 * on the device (`parseQuickAddText` from `@family/shared` — the *same*
 * parser the server runs) so the rows appear instantly and identical
 * whether or not there is a connection; the parsed drafts, not the raw text,
 * are what the outbox carries.
 *
 * Interaction decisions, all of them mobile-first:
 *
 * - a `textarea`, not an `input`: pasting a list from a message is how half of
 *   these get entered, and Enter has to mean "next item", not "submit".
 * - it grows with what you type, from one line to six, **measured in JS**. The
 *   shadcn base sets `field-sizing: content`, which is the right idea and the
 *   wrong mechanism to bet a layout on: WebKit's implementation under-measures
 *   an empty field showing a multi-line placeholder (the box came out 72px for
 *   80px of text, slicing the last line in half), and any engine without the
 *   property at all falls back to `rows`, which here is 1. `field-sizing:fixed`
 *   plus an explicit height is the same behaviour everywhere.
 * - ⌘/Ctrl+Enter submits, for the desktop half of the family.
 * - `text-base` (16px): anything smaller and iOS zooms the viewport on focus
 *   and never zooms back out.
 * - autocomplete suggests against the **last line only**, and tapping one
 *   replaces just that line's name — the quantity the user already typed
 *   survives.
 * - `autoCapitalize="none"` / `autoCorrect="off"`: iOS autocorrect turns
 *   «гречка» into something else entirely often enough to matter.
 */
export function QuickAddBar(props: {
  catalogue: ReadonlyMap<string, { defaultUnit: string | null; defaultCategory: string | null }>;
  disabled?: boolean;
  onAdd: (drafts: ItemDraft[]) => void | Promise<void>;
  className?: string;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);

  /**
   * Size the box to its own content: one line when empty, up to
   * `MAX_FIELD_HEIGHT` (six lines) before it starts scrolling.
   *
   * `height: auto` first so `scrollHeight` reports the content rather than the
   * height we set last time, and the border is added back because `scrollHeight`
   * measures the padding box while `height` here is a border-box.
   */
  const autoSize = useCallback(() => {
    const field = ref.current;
    if (!field) return;
    field.style.height = 'auto';
    const border = field.offsetHeight - field.clientHeight;
    field.style.height = `${String(Math.min(field.scrollHeight + border, MAX_FIELD_HEIGHT))}px`;
  }, []);

  // Before paint, so the field never renders at the wrong height for a frame.
  useLayoutEffect(autoSize, [autoSize, text]);

  // A rotation or a split-screen resize re-wraps the lines, which changes how
  // many there are.
  useEffect(() => {
    window.addEventListener('resize', autoSize);
    return () => {
      window.removeEventListener('resize', autoSize);
    };
  }, [autoSize]);

  const lines = text.split('\n');
  const lastLine = lines.at(-1) ?? '';
  const parsedLastLine = parseQuickAddLine(lastLine);
  const drafts = useMemo(
    () => parseQuickAddText(text).map((parsed) => draftFromParsed(parsed, props.catalogue)),
    [text, props.catalogue],
  );

  const { data: suggestions } = useProductSuggestions(parsedLastLine?.name ?? '');

  const submit = useCallback(async () => {
    if (drafts.length === 0 || props.disabled) return;
    setBusy(true);
    try {
      await props.onAdd(drafts);
      setText('');
      ref.current?.focus();
    } finally {
      setBusy(false);
    }
  }, [drafts, props]);

  /** Swap the noun on the line being typed, keeping any quantity already there. */
  const applySuggestion = (name: string): void => {
    const head = lines.slice(0, -1);
    const parsed = parsedLastLine;
    const quantity =
      parsed && parsed.quantity !== null
        ? `${String(parsed.quantity).replace('.', ',')}${parsed.unit ? ` ${parsed.unit}` : ''} `
        : '';
    setText([...head, `${quantity}${name}`].join('\n'));
    ref.current?.focus();
  };

  const visibleSuggestions = (suggestions ?? []).slice(0, 6);

  return (
    <div className={cn('space-y-2', props.className)}>
      {/*
        A visible label, not `sr-only`. This is the primary action of the screen
        and it used to read as something left over under the list; naming it in
        the same small-caps as the aisle headings above says "this is a part of
        the screen", not "this is the end of the list".
      */}
      <label
        htmlFor={fieldId}
        className="block text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        {SHOPPING_RU.quickAddLabel}
      </label>
      <div className="flex items-end gap-2">
        <Textarea
          id={fieldId}
          ref={ref}
          value={text}
          rows={1}
          disabled={props.disabled}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={SHOPPING_RU.quickAddPlaceholder}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="enter"
          className={cn(
            // 16px minimum, always: `md:text-sm` in the shadcn base would let
            // iOS zoom the viewport on focus.
            'min-h-12 flex-1 bg-card text-base md:text-base',
            // `autoSize` owns the height; `field-sizing: content` from the base
            // would fight it, and it is the reason the placeholder used to be
            // clipped in the first place. `max-h` is the CSS backstop for the
            // same number `autoSize` clamps to.
            '[field-sizing:fixed] max-h-[10rem] overflow-y-auto',
            // The hint must not read as an entered item. Same field, but
            // lighter and italic — «бебра» in the list above is upright and
            // full-contrast, and at a glance that is now the only thing the two
            // could be confused over.
            'placeholder:text-muted-foreground/70 placeholder:italic',
          )}
        />
        <Button
          type="button"
          size="lg"
          className="size-12 shrink-0 p-0"
          aria-label={SHOPPING_RU.quickAddSubmit}
          disabled={props.disabled || busy || drafts.length === 0}
          onClick={() => {
            void submit();
          }}
        >
          <Plus className="size-6" aria-hidden />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {drafts.length > 0 ? SHOPPING_RU.quickAddCount(drafts.length) : SHOPPING_RU.quickAddHint}
      </p>

      {visibleSuggestions.length > 0 ? (
        <ul aria-label={SHOPPING_RU.suggestions} className="flex flex-wrap gap-1.5">
          {visibleSuggestions.map((product) => (
            <li key={product.id}>
              <button
                type="button"
                onClick={() => {
                  applySuggestion(product.name);
                }}
                className="min-h-11 rounded-full border border-input bg-card px-3 text-sm text-foreground"
              >
                {product.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
