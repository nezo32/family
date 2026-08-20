import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { MediaAttachment } from '@family/shared';

import { cn } from '@/shared/lib/utils';

import { WALL_RU } from '../locale';
import { useMediaSource } from '../media/source';

/**
 * The full-screen photo viewer (§D7.14.5).
 *
 * This is what makes the feed's 4:5 clamp acceptable: a 9:19.5 screenshot is
 * drawn cropped in the stream, and the **uncropped** original is one tap away.
 *
 * ## It is route-less, deliberately
 *
 * > The viewer is a route-less overlay: opening it must not push a history
 * > entry that the iOS back-swipe then eats (§G3).
 *
 * So there is no `navigate()`, no `?photo=` param and no `history.pushState`.
 * The cost is that the hardware/gesture back does not close it on Android,
 * which is why the ✕ is permanent, 44px, and in the corner every operating
 * system puts it — and why `Escape` closes it on a keyboard.
 *
 * ## Pinch-zoom is the browser's, not ours
 *
 * `touch-action: pinch-zoom` hands the gesture to the engine rather than
 * reimplementing it in JS. A hand-rolled pinch is the kind of thing that works
 * on the developer's phone and fights the OS on everybody else's, and the
 * native one already does momentum, bounds and double-tap-to-zoom — which is
 * also the reason §D7.7a refuses double-tap-to-like: on every OS in this
 * family, double-tapping a photo already means zoom.
 *
 * ## Scroll lock
 *
 * The feed underneath must not move while the viewer is open — coming back to a
 * different scroll position is the thing that makes an overlay feel like a
 * navigation. `overflow: hidden` on the document element, restored on close.
 */
export function MediaViewer(props: {
  attachments: readonly MediaAttachment[];
  index: number;
  authorName: string;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const { attachments, index } = props;
  const count = attachments.length;
  const current = attachments[index];
  const touchStartX = useRef<number | null>(null);

  const go = useCallback(
    (delta: number): void => {
      if (count < 2) return;
      props.onIndexChange((index + delta + count) % count);
    },
    [count, index, props],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
      if (event.key === 'ArrowLeft') go(-1);
      if (event.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [go, props]);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previous;
    };
  }, []);

  if (!current) return null;

  const label = WALL_RU.media.photoFromNumbered(props.authorName, index + 1, count);
  const body = (
    <div
      // `dialog` + `aria-modal` rather than a `Dialog` from `shared/ui`: this
      // surface is a black full-bleed frame with no header, no radius, no
      // padding and no scroll container, which is every part of what that
      // component is. Reusing it would mean overriding all of it.
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 flex flex-col bg-black"
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        const start = touchStartX.current;
        touchStartX.current = null;
        const end = event.changedTouches[0]?.clientX;
        if (start === null || end === undefined) return;
        const delta = end - start;
        // 48px, not 8: a lazy vertical scroll carries some horizontal drift,
        // and a viewer that changes photo when you meant to look at one is
        // worse than one that occasionally needs a second swipe.
        if (Math.abs(delta) > 48) go(delta > 0 ? -1 : 1);
      }}
    >
      {/* Safe areas on all four sides — this is the one surface in the app that
          genuinely reaches the notch and the home indicator. */}
      <div className="flex shrink-0 items-center justify-end pt-safe">
        <button
          type="button"
          onClick={props.onClose}
          aria-label={WALL_RU.media.close}
          className="m-2 flex size-11 items-center justify-center rounded-full bg-white/10 text-white focus-visible:ring-[3px] focus-visible:ring-white/60 focus-visible:outline-none"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <ViewerImage attachment={current} label={label} />

        {count > 1 ? (
          <>
            <ViewerArrow
              side="start"
              label={WALL_RU.media.previous}
              onClick={() => {
                go(-1);
              }}
            />
            <ViewerArrow
              side="end"
              label={WALL_RU.media.next}
              onClick={() => {
                go(1);
              }}
            />
          </>
        ) : null}
      </div>

      {count > 1 ? (
        /*
          Which photo of how many — dots, not «2 / 4».
          A digit here would be harmless under D7.2 (it describes the object,
          not a person) but the dots say it at a glance and cost less, and the
          position is already in the dialog's accessible name. `aria-hidden`
          keeps the screen reader from counting decorations.
        */
        <div aria-hidden className="flex shrink-0 items-center justify-center gap-1.5 pb-safe">
          {attachments.map((item, dot) => (
            <span
              key={item.id}
              className={cn(
                'my-3 size-1.5 rounded-full transition-colors',
                dot === index ? 'bg-white' : 'bg-white/35',
              )}
            />
          ))}
        </div>
      ) : (
        <div className="shrink-0 pb-safe" />
      )}
    </div>
  );

  // A portal on `document.body`, so the overlay is not trapped inside the
  // card's stacking context (the feed's sticky app bar would otherwise sit on
  // top of a "full-screen" viewer).
  return createPortal(body, document.body);
}

function ViewerImage(props: { attachment: MediaAttachment; label: string }) {
  const state = useMediaSource(props.attachment.url, true);

  if (state.status !== 'ready') {
    return (
      <span className="text-[15px] leading-[22px] text-white/70">
        {state.status === 'failed' ? WALL_RU.media.unavailable : ''}
      </span>
    );
  }

  return (
    <img
      src={state.src}
      alt={props.label}
      // The whole point of the viewer: `contain`, never `cover`. The 4:5 clamp
      // in the feed is only acceptable because this frame is uncropped.
      className="max-h-full max-w-full object-contain"
      style={{ touchAction: 'pinch-zoom' }}
      draggable={false}
    />
  );
}

/**
 * The arrows are for a mouse and a keyboard; the swipe is for a thumb. §G1
 * wants every gesture to have a visible twin, and this is it — which is also
 * why they are drawn at every width rather than hidden below `sm`.
 */
function ViewerArrow(props: { side: 'start' | 'end'; label: string; onClick: () => void }) {
  const Icon = props.side === 'start' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props.label}
      className={cn(
        'absolute top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white',
        'focus-visible:ring-[3px] focus-visible:ring-white/60 focus-visible:outline-none',
        props.side === 'start' ? 'start-2' : 'end-2',
      )}
    >
      <Icon className="size-6" aria-hidden />
    </button>
  );
}
