import { notify } from '@/shared/lib/toast';
import { SETTINGS_RU } from '../locale';
import type { EnableOutcome, EnableResult } from './push';

const T = SETTINGS_RU.push;

/**
 * Turning an `EnableResult` into something the user can act on.
 *
 * Its own module rather than a helper inside `PushPrompt.tsx` for two reasons:
 * a file that exports both components and functions loses React Fast Refresh,
 * and three different screens need this without pulling in the dialog.
 *
 * The rule it encodes: **every outcome except a deliberate dismissal produces a
 * message that names the cause and the remedy.** The bug that made this
 * necessary was a handler that toasted only on success — so an already-`denied`
 * permission, which iOS resolves instantly without ever showing its prompt,
 * produced nothing at all on screen. «Я нажимаю, и ничего не происходит» was a
 * completely accurate description of the code.
 */

/** Outcomes that are neither success nor a no-consequence dismissal. */
export type FailureOutcome = Exclude<EnableOutcome, 'enabled' | 'dismissed'>;

export function isEnableFailure(outcome: EnableOutcome): outcome is FailureOutcome {
  return outcome !== 'enabled' && outcome !== 'dismissed';
}

/**
 * One transient message per outcome.
 *
 * For the surfaces that cannot hold a persistent card — the home-screen offer
 * and the settings hub row. `/settings/notifications` renders `PushFailureCard`
 * instead, which stays on screen next to «Диагностика уведомлений».
 *
 * `notify.raw` rather than `notify.error`: the description is our own authored
 * Russian remedy, not an `ErrorCode` run through `errorMessageRu`.
 *
 * `dismissed` stays silent on purpose. The user swiped the OS prompt away
 * without answering; nothing was spent, nothing broke, and a toast there only
 * teaches them that the app nags.
 */
export function reportEnableOutcome(result: EnableResult): void {
  if (result.outcome === 'enabled') {
    notify.success(T.enabled);
    return;
  }
  if (!isEnableFailure(result.outcome)) return;

  notify.raw.error(T.failureTitle[result.outcome], {
    // Long enough to read four steps on a phone; these are not glanceable.
    duration: 8000,
    description: T.failureHint[result.outcome],
  });
}
