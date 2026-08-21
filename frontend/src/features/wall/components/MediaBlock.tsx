import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Lock, Pause, Play } from 'lucide-react';
import type { MediaAttachment } from '@family/shared';

import { cn } from '@/shared/lib/utils';

import { WALL_RU } from '../locale';
import { formatClock, reservedRatio, spellDuration } from '../media/limits';
import { claimPlayback, useExclusivePlayback, usePauseOffscreen } from '../media/playback';
import { useMediaSource } from '../media/source';
import { usePlaybackTicket, type Playback } from '../media/ticket';
import { MediaViewer } from './MediaViewer';

/**
 * The media on a card (§D7.14.2, §D7.14.4, §D7.14.5).
 *
 * ## Media sits after the body, never before it
 *
 * Instagram puts the picture first because the picture *is* the post. Here the
 * sentence is the news — «В субботу едем к бабушке» — and the photo is the
 * evidence for it. A board reads top-down as words-then-proof.
 *
 * ## The box is reserved before the bytes arrive
 *
 * `aspect-ratio` comes from the server's `width`/`height` (rotation already
 * applied, so an iPhone portrait clip is landscape pixels plus a 90° matrix and
 * the server has resolved that). Nothing reflows on load, and a thumb halfway
 * down the feed is not thrown by an image finishing. **This is not optional** —
 * a feed that reflows while you read it is the single most annoying bug this
 * screen can have, and it is the one thing a `loading="lazy"` `<img>` with no
 * dimensions guarantees.
 *
 * The ratio is clamped at the **tall** end to 4:5 and the box at `60dvh`. A
 * 9:19.5 phone screenshot is drawn `object-fit: cover` in a 4:5 box and the
 * whole frame is one tap away in the viewer.
 *
 * ## Video and audio load through a **ticket**; photos do not
 *
 * A `<video src>` now points at `/api/media/<id>/stream?t=…`, minted on the tap
 * that starts it, so the browser's own media stack issues the range requests
 * and a seek costs the part you seeked to rather than the whole file. See
 * `media/ticket.ts` for the credential, for what a mid-playback 404 means and
 * for why one re-mint is the right number.
 *
 * **A photograph keeps the plain `/api/media/<id>` path** and `source.ts`. It
 * is not ranged, and its `private, max-age=31536000, immutable` response is
 * exactly what a fifteen-minute credential in the URL would spoil — every mint
 * would be a new cache key for bytes that never change.
 *
 * ## Two things the design asked for that the backend does not carry
 *
 * Stated here rather than worked around silently, because both change what this
 * component can draw:
 *
 * - **`dominantColor`.** §D7.14.2 wants the reserved box painted with the
 *   photo's own colour, so that it reads as *loading* rather than as *broken*.
 *   `mediaAttachmentSchema` has no such field and `POST /api/media` accepts no
 *   such form field, so the box is `--muted`. The grey block that results is
 *   exactly the failure that note warned about; it is a one-column, one-field
 *   change on the server and it is the cheapest visible improvement available.
 * - **A poster object for video.** §D7.14.4 wants a ~30 KB still so a card can
 *   show a frame without touching a 100 MB file. There is no `posterUrl` on the
 *   wire and no poster part on the upload route. So a video card draws its
 *   reserved box, a play button and the duration pill on `--muted`, and fetches
 *   nothing at all until it is tapped. That keeps the data promise — fifteen
 *   video cards still cost zero bytes — and loses the frame.
 *
 * ## Nothing autoplays, and exactly one element plays app-wide
 *
 * See `media/playback.ts` for the rule and the WebKit citations behind it.
 */

export type MediaTone = 'plain' | 'inset';

export function MediaBlock(props: {
  attachments: readonly MediaAttachment[];
  /** Whose note this is. Feeds the accessible names — there is no `alt` on the wire. */
  authorName: string;
  /**
   * `inset` on a card with a tinted ground (§D7.14.2): the attention wash and
   * the system post's calm ground draw on the `<article>` itself, and a
   * full-bleed photo on one of those runs to the screen edge and stops the wash
   * reading as a card at all. Also used inside a comment, where a full-bleed
   * photo would destroy the containment that says "you are in a discussion".
   */
  tone?: MediaTone;
  /** §D7.8b — a comment's box is capped shorter than a post's. */
  maxHeight?: 'card' | 'comment';
  /**
   * How many attachments this note carries that **this reader** may not open —
   * `hiddenAttachments` off the wire (D15 §4).
   *
   * For everybody from `child` up it is `0` and `attachments` is the real
   * array. For a `guest` it is the count and `attachments` is `[]`: no id, no
   * url, no content type, no dimensions — nothing that could be used to probe
   * the delivery route, which answers them 404 regardless.
   *
   * **Branch on this, never on `attachments.length === 0`** — a note with no
   * photographs at all looks exactly the same from here, and drawing «только
   * для семьи» on every text note would be the funniest possible bug.
   */
  hiddenCount?: number;
  className?: string;
}) {
  const { attachments, authorName } = props;
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const hiddenCount = props.hiddenCount ?? 0;
  if (attachments.length === 0 && hiddenCount === 0) return null;

  const tone = props.tone ?? 'plain';

  // The two cannot both be non-empty — the server either redacts the array or
  // it does not — but the check is on `hiddenCount` alone, deliberately, so
  // that a future partial redaction draws both halves rather than neither.
  if (hiddenCount > 0) {
    return (
      <div className={cn(tone === 'inset' ? 'px-4 pt-2' : '-mx-4 pt-2 sm:mx-0', props.className)}>
        <BlockedMedia count={hiddenCount} rounded={tone === 'inset'} />
      </div>
    );
  }

  if (attachments.length === 0) return null;
  const first = attachments[0];
  if (!first) return null;

  // Mixed kinds cannot arrive (§D7.14.2, enforced in the composer and by the
  // fact that one post is one member's one pick), so the first attachment
  // decides the shape of the whole block.
  if (first.kind === 'audio') {
    return (
      <div className={cn('px-4 pt-2', props.className)}>
        <AudioRow attachment={first} authorName={authorName} />
      </div>
    );
  }

  if (first.kind === 'video') {
    return (
      <div className={cn(tone === 'inset' ? 'px-4 pt-2' : '-mx-4 pt-2 sm:mx-0', props.className)}>
        <VideoBox
          attachment={first}
          authorName={authorName}
          rounded={tone === 'inset'}
          maxHeight={props.maxHeight ?? 'card'}
        />
      </div>
    );
  }

  const photos = attachments.filter((item) => item.kind === 'image');
  if (photos.length === 0) return null;

  return (
    <>
      <div className={cn(tone === 'inset' ? 'px-4 pt-2' : '-mx-4 pt-2 sm:mx-0', props.className)}>
        <PhotoGrid
          photos={photos}
          authorName={authorName}
          rounded={tone === 'inset'}
          maxHeight={props.maxHeight ?? 'card'}
          onOpen={setViewerIndex}
        />
      </div>
      {viewerIndex !== null ? (
        <MediaViewer
          attachments={photos}
          index={viewerIndex}
          authorName={authorName}
          onIndexChange={setViewerIndex}
          onClose={() => {
            setViewerIndex(null);
          }}
        />
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* what a reader without `media:read` gets instead                             */
/* -------------------------------------------------------------------------- */

/**
 * «Фото — только для семьи» (§D7.14.10, D15 §4).
 *
 * **Not a lock-shaped hole and not a blur.** A blur is a client-side effect
 * over bytes that were already sent, and the entire point of this path is that
 * they were not: for a reader without `media:read` the server sends `[]` and a
 * number, and `GET /api/media/:id` answers them 404. There is nothing here to
 * un-blur, which is exactly the property worth having.
 *
 * ## Why it is not a reserved box
 *
 * Every other shape in this file reserves its height from the server's
 * `width`/`height` so nothing reflows on load. Those numbers are part of what
 * is withheld, and guessing a box would be inventing the one fact this design
 * refuses to leak — a 4:5 block would tell a guest the note carries a portrait.
 * So it is one quiet line, which is also what §D7.14.10 asks for, and it never
 * reflows because nothing is ever going to arrive in it.
 *
 * ## The count is drawn, and that is why it is a count
 *
 * A line standing in for one photograph must not read the same as one standing
 * in for four: a reader who cannot see them is at least told how much of the
 * note they are missing. `locale.ts` carries the wording and the argument for
 * the digit.
 *
 * The icon is `aria-hidden` and the sentence is the accessible name, because
 * the sentence already says everything the padlock is gesturing at — and a
 * screen reader announcing "замок" before it is a description of a glyph.
 */
function BlockedMedia(props: { count: number; rounded: boolean }) {
  return (
    <p
      className={cn(
        'flex min-h-11 items-center gap-2 bg-muted px-3 py-2.5',
        'text-[13px] leading-[18px] font-medium text-muted-foreground',
        props.rounded ? 'rounded-lg' : 'rounded-none sm:rounded-lg',
      )}
    >
      <Lock className="size-4 shrink-0" aria-hidden />
      {WALL_RU.media.blocked(props.count)}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* photos                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 1 / 2 / 3 / 4, and never a fifth.
 *
 * ```
 * n=1  one cell, natural ratio clamped at 4:5
 * n=2  two squares, 2px gutter
 * n=3  two squares, then one full-width cell at 2:1
 * n=4  2 × 2 squares
 * ```
 *
 * The cap is four because that is what the grid holds **without a «+2» tile**,
 * and a «+2» tile is a digit on a card (§D7.7b). Same trick as
 * `MemberDiscGroup` capped at the family size: choose the bound that makes the
 * counter unnecessary. A fifth photo is refused at pick time, with a sentence.
 */
function PhotoGrid(props: {
  photos: readonly MediaAttachment[];
  authorName: string;
  rounded: boolean;
  maxHeight: 'card' | 'comment';
  onOpen: (index: number) => void;
}) {
  const photos = props.photos.slice(0, 4);
  const count = photos.length;
  const radius = props.rounded ? 'rounded-lg' : 'rounded-none sm:rounded-lg';

  if (count === 1) {
    const only = photos[0];
    if (!only) return null;
    return (
      <div
        // `w-full` is load-bearing, not tidiness. Without a **definite** width
        // the `max-height` below resolves against `aspect-ratio` by *narrowing*
        // the box: measured at 1024px, a 4:5 photo in a 606px column came out
        // 432×540 with 174px of empty card beside it. With the width pinned, the
        // 60dvh cap crops through `object-cover` instead, which is what §D7.14.2
        // means by "max-height".
        className={cn('w-full overflow-hidden bg-muted', radius)}
        style={{
          // Reserved from the server's dimensions. Nothing below this moves
          // when the bytes land.
          aspectRatio: reservedRatio(only) ?? 4 / 5,
          maxHeight: props.maxHeight === 'comment' ? '240px' : '60dvh',
        }}
      >
        <Photo
          attachment={only}
          label={WALL_RU.media.photoFrom(props.authorName)}
          onOpen={() => {
            props.onOpen(0);
          }}
        />
      </div>
    );
  }

  /*
    Two, three or four.

    The container carries the **whole arrangement's** aspect ratio and the cells
    are `1fr` rows inside it, rather than each cell carrying `aspect-square`.
    That is what makes the `60dvh` cap a *scale* instead of a *crop*: measured
    at 1024×900, a 2×2 grid wants 608px and the cap allows 540, and with fixed
    square cells the bottom row was simply cut in half — a grid that looks
    broken rather than one that looks smaller. With `1fr` rows the two rows
    share whatever height there is and each photo crops inside its own cell,
    which `object-cover` was already doing.

    The ratios fall out of the drawing in §D7.14.2 and are not free parameters:
    two squares side by side is 2:1; two squares plus a full-width 2:1 cell is
    1:1; and 2 × 2 squares is 1:1.
  */
  const ratio = count === 2 ? 2 : 1;

  return (
    <div
      className={cn(
        'grid w-full gap-0.5 overflow-hidden',
        count === 2 ? '' : 'grid-rows-2',
        radius,
      )}
      style={{
        aspectRatio: ratio,
        maxHeight: props.maxHeight === 'comment' ? '240px' : '60dvh',
      }}
    >
      <div className="grid min-h-0 grid-cols-2 gap-0.5">
        {photos.slice(0, count === 3 ? 2 : 2).map((photo, index) => (
          <div key={photo.id} className="min-h-0 min-w-0 bg-muted">
            <Photo
              attachment={photo}
              label={WALL_RU.media.photoFromNumbered(props.authorName, index + 1, count)}
              onOpen={() => {
                props.onOpen(index);
              }}
            />
          </div>
        ))}
      </div>

      {count === 3 && photos[2] ? (
        // The odd one out gets the full width — a third square beside two would
        // leave a hole, and a «+1» tile is a digit on a card (§D7.7b).
        <div className="min-h-0 bg-muted">
          <Photo
            attachment={photos[2]}
            label={WALL_RU.media.photoFromNumbered(props.authorName, 3, 3)}
            onOpen={() => {
              props.onOpen(2);
            }}
          />
        </div>
      ) : null}

      {count === 4 ? (
        <div className="grid min-h-0 grid-cols-2 gap-0.5">
          {photos.slice(2).map((photo, index) => (
            <div key={photo.id} className="min-h-0 min-w-0 bg-muted">
              <Photo
                attachment={photo}
                label={WALL_RU.media.photoFromNumbered(props.authorName, index + 3, count)}
                onOpen={() => {
                  props.onOpen(index + 2);
                }}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One photo, and the tap target that opens it.
 *
 * A `<button>` wrapping the image rather than an `onClick` on the `<img>`: a
 * photo is a control here (it opens the viewer), and a control has to be
 * reachable by keyboard and announce itself. The whole cell is the target, so
 * it is far larger than the 44px floor.
 *
 * **No double-tap-to-like.** §G1 requires every gesture to have a visible twin,
 * and the twin here — the always-drawn heart on the foot line — already exists,
 * so the gesture buys nothing. A double-tap on a photo already means "zoom" on
 * every operating system in this family.
 */
function Photo(props: { attachment: MediaAttachment; label: string; onOpen: () => void }) {
  const state = useMediaSource(props.attachment.url, true);

  return (
    <button
      type="button"
      onClick={props.onOpen}
      aria-label={`${props.label}. ${WALL_RU.media.open}`}
      className="size-full cursor-zoom-in focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {state.status === 'ready' ? (
        <img
          src={state.src}
          alt={props.label}
          // `object-cover` is what the 4:5 clamp buys: the reserved box is the
          // shape, the pixels fill it, and the uncropped frame is one tap away.
          className="size-full object-cover"
          draggable={false}
        />
      ) : state.status === 'failed' ? (
        <MediaFailure />
      ) : (
        // The reserved box, painted. `--muted` rather than the photo's own
        // colour, because `dominantColor` is not on the wire — see the header.
        <span className="block size-full" aria-hidden />
      )}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* video and audio share these two                                             */
/* -------------------------------------------------------------------------- */

/**
 * Where playback should pick up when a ticket is re-minted underneath it.
 *
 * Swapping `src` resets `currentTime` to zero, so the position is captured in
 * the element's `error` handler — the last moment it is still true — and
 * consumed by the seek below. It is cleared once it has been used, and whenever
 * the element goes back to idle, so a card scrolled away and re-opened starts
 * from the beginning rather than from somebody's abandoned position.
 */
function useResumePoint(playback: Playback): React.RefObject<number> {
  const resumeAt = useRef(0);
  const idle = playback.state.status === 'idle';
  useEffect(() => {
    if (idle) resumeAt.current = 0;
  }, [idle]);
  return resumeAt;
}

/**
 * Play the moment a URL is available — and **only** then, because the state
 * that produced it is only ever entered by a tap.
 *
 * The gesture that set `started` is the gesture iOS requires
 * (`RequiresUserGestureForAudioPlayback`, and video's Low Power Mode rule with
 * no muted exemption — see `media/playback.ts`). The `catch` covers a phone
 * deciding otherwise anyway, which leaves native controls and a paused first
 * frame rather than an error.
 *
 * **`generation`, not `status` alone, is the trigger.** A re-mint runs
 * `ready` -> `loading` -> `ready`, and the second `ready` carries a *different*
 * URL that has to be played from the position the first one stopped at.
 * Watching `status` would see it settle back on a value it already held and
 * never fire again.
 *
 * The seek waits for `loadedmetadata`, because `currentTime` on an element that
 * does not yet know its duration is silently dropped — the clip would restart
 * from zero, which is the one thing a re-mint must never do to somebody two
 * minutes into a school concert.
 */
function usePlayWhenReady(
  ref: React.RefObject<HTMLMediaElement | null>,
  playback: Playback,
  resumeAt: React.RefObject<number>,
): void {
  const { status } = playback.state;
  const { generation } = playback;

  useEffect(() => {
    if (status !== 'ready') return;
    const element = ref.current;
    if (!element) return;

    claimPlayback(element);
    const target = resumeAt.current;
    resumeAt.current = 0;

    const seek = (): void => {
      try {
        element.currentTime = target;
      } catch {
        // A source that will not take a seek starts from the beginning —
        // worse than resuming, and much better than throwing out of an event
        // handler.
      }
    };

    /*
      **`play()` is called unconditionally, and the seek is what waits.** The
      order matters and getting it wrong is silent: `preload="none"` means the
      element loads *nothing* until it is asked to play, so `readyState` is 0
      and `loadedmetadata` will never fire on its own. Arranging the seek first
      and the play inside its handler therefore deadlocks — measured, in
      Chromium at 1440: the ticket was minted, the URL reached `src`, and the
      element then sat at `readyState 0` having issued no request at all, for
      ever. WebKit happened to load metadata anyway and hid it.

      So: ask it to play, which starts the load; and hang the seek off the
      metadata that load produces, because `currentTime` on an element that
      does not yet know its duration is dropped on the floor.
    */
    // `HAVE_METADATA` is 1. Compared as a number rather than through the
    // constant, because jsdom defines it on neither `HTMLMediaElement` nor
    // `HTMLVideoElement` reliably and a unit test has to be able to render this.
    let cleanup: (() => void) | undefined;
    if (target > 0) {
      if (element.readyState >= 1) {
        seek();
      } else {
        element.addEventListener('loadedmetadata', seek, { once: true });
        cleanup = () => {
          element.removeEventListener('loadedmetadata', seek);
        };
      }
    }

    void element.play().catch(() => undefined);
    return cleanup;
  }, [status, generation, ref, resumeAt]);
}

/* -------------------------------------------------------------------------- */
/* video                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Poster, play, duration pill — then the clip, **in place**.
 *
 * `playsinline` is not decoration:
 * `MediaElementSession::requiresFullscreenForVideoPlayback()` still returns
 * true without it on iPhone (iPad exempt), so the clip would take over the
 * whole screen the moment it started. Verified against WebKit `main`,
 * 2026-08-21.
 *
 * It does **not** open a lightbox. A video that jumps into a modal loses the
 * reader's scroll position, and on iOS regaining it is not reliable.
 */
function VideoBox(props: {
  attachment: MediaAttachment;
  authorName: string;
  rounded: boolean;
  maxHeight: 'card' | 'comment';
}) {
  const { attachment } = props;
  const [started, setStarted] = useState(false);
  const ref = useExclusivePlayback<HTMLVideoElement>();
  const playback = usePlaybackTicket(attachment.id, started);
  const resumeAt = useResumePoint(playback);
  usePauseOffscreen(ref);

  const duration = attachment.durationMs;
  const label = WALL_RU.media.videoFrom(
    props.authorName,
    duration === null ? null : spellDuration(duration),
  );

  usePlayWhenReady(ref, playback, resumeAt);

  return (
    <div
      className={cn(
        // `w-full` for the same reason as the photo box above: a definite width
        // is what makes `max-height` a crop rather than a narrowing.
        'relative w-full overflow-hidden bg-muted',
        props.rounded ? 'rounded-lg' : 'rounded-none sm:rounded-lg',
      )}
      style={{
        aspectRatio: reservedRatio(attachment) ?? 4 / 5,
        maxHeight: props.maxHeight === 'comment' ? '240px' : '60dvh',
      }}
    >
      {started ? (
        playback.state.status === 'failed' || playback.state.status === 'lost' ? (
          <MediaFailure lost={playback.state.status === 'lost'} />
        ) : (
          <video
            ref={ref}
            // Both spellings. React maps `playsInline` to the attribute, and
            // the lower-case one is what older WebKit reads off the DOM.
            playsInline
            controls
            /*
              Still `none`, and it means something different now that `src` is a
              real URL rather than a blob the client already holds: without it
              the element would issue a metadata range request the moment the
              attribute lands. It never gets the chance, because `started` gates
              the mint and there is no `src` at all until the tap — but the
              attribute is the belt to that braces, and it is what keeps a
              re-mint from pre-buffering ahead of the seek below.
            */
            preload="none"
            aria-label={label}
            className="size-full bg-black object-contain"
            {...(playback.state.status === 'ready' ? { src: playback.state.src } : {})}
            onPlay={(event) => {
              claimPlayback(event.currentTarget);
            }}
            onError={(event) => {
              // Where the reader was, captured **before** the swap resets it.
              resumeAt.current = event.currentTarget.currentTime;
              playback.recover();
            }}
          />
        )
      ) : (
        <button
          type="button"
          onClick={() => {
            setStarted(true);
          }}
          aria-label={`${label}. ${WALL_RU.media.play}`}
          className="group absolute inset-0 flex items-center justify-center focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {/* 56px filled play, per §D7.14.4 — well over the 44px floor. */}
          <span className="flex size-14 items-center justify-center rounded-full bg-black/55 text-white transition-transform group-hover:scale-105">
            <Play className="size-6 translate-x-px fill-current" aria-hidden />
          </span>
        </button>
      )}

      {duration !== null && !started ? (
        /*
          The duration pill. A number on a card, and it passes D7.2 cleanly: a
          clip's length is not sayable any other way, it is not attached to a
          person, nothing sorts by it, and it is precisely the fact that decides
          whether you tap now or later. `aria-hidden` because the same number is
          already inside the button's accessible name, spelled as words.
        */
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[13px] leading-[18px] font-medium text-white tabular-nums"
        >
          {formatClock(duration)}
        </span>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* audio                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A 56px row, not a box (§D7.14.4).
 *
 * Audio has no picture, so a 4:5 box of nothing would be absurd. It is
 * distinguishable at a glance from a video precisely **because it is a
 * different shape**, not because of an icon — colour is never the only signal
 * (§B4), and neither is a glyph.
 *
 * **No waveform.** Drawing one needs either a server-side decoder (a dependency
 * this backend deliberately does not have) or forty numbers computed at record
 * time and carried in a column. Deferred, and named here so nobody reaches for
 * a waveform library.
 *
 * Nothing in the app can currently *create* one of these — see
 * `media/record.ts` for why the recorder is not shipped. The row exists because
 * the backend accepts `audio/mp4` and `audio/mpeg`, so a row can arrive, and a
 * card that could not draw one would be a broken card rather than an absent
 * feature.
 */
function AudioRow(props: { attachment: MediaAttachment; authorName: string }) {
  const { attachment } = props;
  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const ref = useExclusivePlayback<HTMLAudioElement>();
  const playback = usePlaybackTicket(attachment.id, started);
  const resumeAt = useResumePoint(playback);

  const total = attachment.durationMs;
  const label = WALL_RU.media.audioFrom(
    props.authorName,
    total === null ? null : spellDuration(total),
  );
  const remaining = total === null ? null : Math.max(0, total - elapsedMs);
  const progress = total && total > 0 ? Math.min(1, elapsedMs / total) : 0;

  usePlayWhenReady(ref, playback, resumeAt);

  const toggle = useCallback((): void => {
    const element = ref.current;
    if (!started || !element) {
      setStarted(true);
      return;
    }
    if (element.paused) {
      claimPlayback(element);
      void element.play().catch(() => undefined);
    } else {
      element.pause();
    }
  }, [ref, started]);

  if (playback.state.status === 'failed' || playback.state.status === 'lost') {
    return (
      <div className="flex h-14 items-center gap-3 rounded-lg bg-secondary px-3">
        <MediaFailure inline lost={playback.state.status === 'lost'} />
      </div>
    );
  }

  return (
    <div className="flex h-14 items-center gap-3 rounded-lg bg-secondary px-3 text-secondary-foreground">
      <button
        type="button"
        onClick={toggle}
        aria-label={`${label}. ${playing ? WALL_RU.media.pause : WALL_RU.media.playAudio}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-full bg-background/70 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {playing ? (
          <Pause className="size-5 fill-current" aria-hidden />
        ) : (
          <Play className="size-5 translate-x-px fill-current" aria-hidden />
        )}
      </button>

      {/* A hairline that fills as it plays. Not a scrubber: §D7.14.4 asks for a
          progress line, and a 3px drag target on a phone is a control nobody
          can hit. `aria-hidden` — the button already carries the whole story. */}
      <span aria-hidden className="h-px min-w-0 flex-1 bg-current/25">
        <span
          className="block h-px bg-current transition-[width] duration-200"
          style={{ width: `${String(Math.round(progress * 100))}%` }}
        />
      </span>

      {remaining !== null ? (
        <span aria-hidden className="shrink-0 text-[13px] leading-[18px] font-medium tabular-nums">
          {formatClock(remaining)}
        </span>
      ) : null}

      {started ? (
        <audio
          ref={ref}
          preload="none"
          {...(playback.state.status === 'ready' ? { src: playback.state.src } : {})}
          onPlay={(event) => {
            claimPlayback(event.currentTarget);
            setPlaying(true);
          }}
          onPause={() => {
            setPlaying(false);
          }}
          onError={(event) => {
            resumeAt.current = event.currentTarget.currentTime;
            playback.recover();
          }}
          onTimeUpdate={(event) => {
            setElapsedMs(Math.round(event.currentTarget.currentTime * 1000));
          }}
          onEnded={() => {
            setPlaying(false);
            setElapsedMs(0);
          }}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* shared bits                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The bytes would not come.
 *
 * Quiet and in place — never a toast. A failed attachment is not something the
 * reader did, and it is not something they can fix; the card around it is still
 * worth reading.
 *
 * `lost` is the second sentence and it is a different fact: a clip that *was*
 * playing and then could not be, whose re-mint came back 404 — the member was
 * suspended, `media:read` was revoked, or the note was deleted while they
 * watched. «Вложение не открылось» would be the wrong words there. It opened;
 * it stopped. See `media/ticket.ts`.
 */
function MediaFailure(props: { inline?: boolean; lost?: boolean } = {}) {
  return (
    <span
      className={cn(
        'flex items-center justify-center gap-2 text-[13px] leading-[18px] font-medium text-muted-foreground',
        props.inline ? '' : 'size-full',
      )}
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      {props.lost ? WALL_RU.media.playbackLost : WALL_RU.media.unavailable}
    </span>
  );
}
