import { useSyncExternalStore } from 'react';

/**
 * "Is there any network at all?", for **copy only**.
 *
 * `navigator.onLine` tells the truth about `false`-to-`true` transitions and
 * lies cheerfully behind a captive portal, so it is never allowed to decide
 * whether a request is attempted — the request finds that out by being made.
 * What it is good for is the one thing §D7.14.7 asks for: greying the attach
 * control and saying «Фото можно добавить, когда появится интернет», rather
 * than letting a member pick four photos into a strip of four failures.
 *
 * Posting *without* media still works while this is `false`, optimistically
 * (§D7.12), because the note is the thing that matters and the photo is the
 * evidence for it.
 *
 * ## Why this is not imported from `features/shopping/hooks.ts`
 *
 * There is an identical `useOnline` there. Importing it would make Стена depend
 * on Покупки — a feature-to-feature edge that the feature-sliced layout exists
 * to forbid, and one that would put the wall's attach control at the mercy of
 * changes made for a shopping outbox. Twelve lines duplicated is the cheaper
 * side of that trade. If a third caller appears, this is the one that should
 * move to `shared/hooks/`, and the shopping copy should follow it.
 */
function subscribe(callback: () => void): () => void {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    // Server/`jsdom` snapshot: assume connected. "Offline" is a claim that
    // needs evidence; "online" is the state everything else already assumes.
    () => true,
  );
}
