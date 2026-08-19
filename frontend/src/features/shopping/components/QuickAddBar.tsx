import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/textarea';
import { cn } from '@/shared/lib/utils';
import { SHOPPING_RU } from '../locale';
import { draftFromParsed, type ItemDraft } from '../grouping';
import { parseQuickAddLine, parseQuickAddText } from '@family/shared';
import { useProductSuggestions } from '../hooks';

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
      <label htmlFor={fieldId} className="sr-only">
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
          // 16px minimum, always: `md:text-sm` in the shadcn base would let iOS
          // zoom the viewport on focus.
          className="max-h-40 min-h-12 flex-1 text-base md:text-base"
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
