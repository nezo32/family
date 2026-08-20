import { cn } from '@/shared/lib/utils';

/**
 * «Меняем: только 20 августа · сменить» — the persistent recurrence-scope chip
 * (design §F6).
 *
 * ## Why the answer stays on screen
 *
 * The old flow asked «Только это / Это и последующие / Все» **after** the form
 * was filled in: a decision the user cannot evaluate, on top of a form they
 * have just fought, at the exact moment they most want the dialog gone. Whatever
 * they tap there is a guess, and one of the guesses rewrites the family's
 * history.
 *
 * Inverting it — ask first, when it is cheap — is only half the fix. The other
 * half is that the answer must not then vanish: fifteen fields later, "am I
 * editing this Tuesday or every Tuesday?" is exactly as unanswerable as it was
 * before. So the choice is pinned under the sheet header for the whole session,
 * in words, and «сменить» re-opens the prompt in one tap.
 *
 * 32px, `--secondary` ground — a label, not a control with its own weight. The
 * only interactive part is «сменить».
 */
export function ScopeChip(props: {
  /** «Меняем» / «Удаляем». */
  prefix: string;
  /** The consequence in words: «только 20 августа». */
  value: string;
  changeLabel: string;
  onChange: () => void;
  className?: string;
}) {
  return (
    <div
      data-slot="scope-chip"
      className={cn(
        'flex min-h-8 w-full max-w-row-measure items-center gap-2 rounded-lg bg-secondary px-3 py-1',
        'text-[13px] leading-[18px] text-secondary-foreground',
        props.className,
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        {props.prefix}: {props.value}
      </span>
      <button
        type="button"
        onClick={props.onChange}
        className={cn(
          'shrink-0 rounded-md px-2 py-1 font-medium text-primary underline-offset-2',
          'touch-manipulation hover:underline',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        )}
      >
        {props.changeLabel}
      </button>
    </div>
  );
}
