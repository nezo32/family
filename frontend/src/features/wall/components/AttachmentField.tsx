import { useEffect, useRef, type ChangeEvent } from 'react';
import { AlertCircle, ImagePlus, Music, Paperclip, RotateCcw, Video, X } from 'lucide-react';

import { cn } from '@/shared/lib/utils';

import { WALL_RU } from '../locale';
import { MEDIA_ACCEPT } from '../media/limits';
import type { AttachmentsApi, AttachmentTile } from '../media/use-attachments';
import { useThumbnail } from '../media/source';

/**
 * The attachment strip inside a composer (§D7.14.7).
 *
 * ## Media is a property of a note, never a fourth door
 *
 * The single most available mistake in this whole feature is adding «Фото» to
 * the compose menu beside Объявление · Опрос · Спасибо. It is not there, and
 * there is no camera glyph on the compose row, none in the app bar, and no
 * attach control anywhere on Стена except **inside a composer the reader
 * deliberately opened**. A camera button on the feed surface is a one-tap path
 * from "reading the wall" to "posting a picture" with nothing said, and that is
 * a photo-sharing app — which D9 rejected by name.
 *
 * ## One `<input type="file">`, and no `capture`
 *
 * On iOS this raises WebKit's own three-item menu from `WKFileUploadPanel.mm` —
 * «Фотогалерея» / «Снять фото или видео» / «Выбрать файл», with the camera item
 * omitted on a device without one. A separate «Камера» button beside it would
 * be a second door onto a room the first door already opens. See `limits.ts`
 * for why `capture` must not be set and what `accept` carries.
 *
 * ## The row this replaces nothing of
 *
 * `composer-field.ts` was just restructured to stop these fields drawing a
 * second rounded box inside the `Section` row that already owns the ground, the
 * radius and the 16/12 inset. **This strip draws no surface of its own** for
 * the same reason: it is a row inside the section, the tiles are the only
 * things with a border, and the trigger is a plain 44px row like «Заголовок»
 * beside it. Nothing here reintroduces the chrome that change removed.
 */

export function AttachmentField(props: {
  attachments: AttachmentsApi;
  /** 4 on a post, 1 on a comment. */
  max: number;
  /** Compact = the 📎 form used on a comment composer (§D7.8b). */
  variant?: 'row' | 'compact';
  disabled?: boolean;
  className?: string;
}) {
  const { attachments, max } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const variant = props.variant ?? 'row';
  const full = attachments.tiles.length >= max;

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files) attachments.add(event.target.files);
    // Reset, so picking the *same* file twice in a row still fires `change`.
    event.target.value = '';
  };

  const trigger = (
    <>
      <input
        ref={inputRef}
        type="file"
        // Never `capture`. Never the `audio/*` wildcard. See `limits.ts`.
        accept={MEDIA_ACCEPT}
        multiple={max > 1}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={onPick}
      />
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => {
          inputRef.current?.click();
        }}
        {...(variant === 'compact' ? { 'aria-label': WALL_RU.media.attach } : {})}
        className={cn(
          'flex items-center gap-2 rounded-md text-[15px] leading-[22px] font-medium',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
          'disabled:opacity-50',
          variant === 'compact'
            ? 'size-11 shrink-0 items-center justify-center text-muted-foreground'
            : 'min-h-11 w-full px-4 text-start',
        )}
      >
        {variant === 'compact' ? (
          <Paperclip className="size-5" aria-hidden />
        ) : (
          <>
            <ImagePlus className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            {WALL_RU.media.add}
          </>
        )}
      </button>
    </>
  );

  return (
    <div className={cn(variant === 'compact' ? 'contents' : 'w-full', props.className)}>
      {/* The trigger disappears once the strip is full, rather than staying to
          offer a fifth attachment that would then be refused (§D7.8b applies
          the same rule to the comment composer's 📎). */}
      {!full ? trigger : null}

      {attachments.tiles.length > 0 ? (
        <ul
          className={cn(
            'flex flex-wrap items-start gap-2',
            variant === 'compact' ? 'w-full py-1' : 'px-4 pt-1 pb-3',
          )}
        >
          {attachments.tiles.map((tile) => (
            <Tile
              key={tile.key}
              tile={tile}
              onRemove={() => {
                attachments.remove(tile.key);
              }}
              onRetry={() => {
                attachments.retry(tile.key);
              }}
            />
          ))}
        </ul>
      ) : null}

      {attachments.notice ? (
        <Notice text={attachments.notice} onDismiss={attachments.dismissNotice} inset={variant} />
      ) : null}
    </div>
  );
}

/**
 * One 72px tile, in one of three states (§D7.14.7).
 *
 * | State     | Tile                                                              |
 * | --------- | ----------------------------------------------------------------- |
 * | uploading | thumbnail at 60 % opacity, determinate ring, ✕ cancels             |
 * | done      | thumbnail, ✕ removes and reclaims the draft server-side            |
 * | failed    | destructive hairline, ↻, and the Russian reason on one line        |
 *
 * A file that was too big or too long never becomes a tile at all — it is
 * refused at pick time with a sentence, so the strip only ever contains things
 * that are genuinely on their way.
 */
function Tile(props: { tile: AttachmentTile; onRemove: () => void; onRetry: () => void }) {
  const { tile } = props;
  const failed = tile.status === 'failed';

  return (
    <li className={cn('flex flex-col gap-1', failed && 'w-full')}>
      <div className="flex items-start gap-2">
        <div
          className={cn(
            'relative size-18 shrink-0 overflow-hidden rounded-md bg-muted',
            failed && 'ring-1 ring-destructive',
          )}
        >
          <Thumbnail tile={tile} />

          {tile.status === 'uploading' ? <ProgressRing fraction={tile.progress} /> : null}

          <button
            type="button"
            onClick={props.onRemove}
            aria-label={WALL_RU.media.remove}
            /*
              The ✕ is 28px of ink inside a 44px target: the hit area is padded
              outwards with `-m-2 p-2` so the thumbnail is not eaten by its own
              remove button, while the finger still gets the floor from §F1.
            */
            className="absolute end-0 top-0 flex size-11 items-start justify-end p-1 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-black/60 text-white">
              <X className="size-3.5" aria-hidden />
            </span>
          </button>
        </div>

        {failed ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="flex items-start gap-1.5 text-[13px] leading-[18px] font-medium text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 wrap-break-word">{tile.error}</span>
            </p>
            <button
              type="button"
              onClick={props.onRetry}
              className="-mx-2 flex min-h-11 items-center gap-1.5 self-start rounded-md px-2 text-[13px] leading-[18px] font-medium underline-offset-4 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              {WALL_RU.media.retry}
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The tile's picture.
 *
 * Local `File` first — instant, free, and available before a single byte has
 * been uploaded. A **restored** tile has no `File` (a cold start took it) but
 * does have an id, so its thumbnail comes back from `/api/media/<id>`, which
 * still answers because the row is unclaimed rather than absent. That is the
 * visible half of the 24-hour claim window: the member who was interrupted by a
 * phone call comes back to their sheet with their photos on it.
 *
 * A video or audio tile has no picture at all, and gets its glyph. Drawing a
 * frame would mean decoding the clip, which is the work `preload="none"` exists
 * to avoid.
 */
function Thumbnail(props: { tile: AttachmentTile }) {
  const { tile } = props;
  const remote = useThumbnail(
    tile.previewUrl === null && tile.kind === 'image' && tile.attachment
      ? tile.attachment.url
      : // A URL nothing will ever ask for. `useThumbnail` is a hook and cannot
        // be called conditionally; an empty path resolves to `failed` and draws
        // nothing, which is the same as not asking.
        '',
  );
  const src = tile.previewUrl ?? remote;

  if (tile.kind === 'video' || tile.kind === 'audio') {
    const Icon = tile.kind === 'video' ? Video : Music;
    return (
      <span className="flex size-full items-center justify-center text-muted-foreground">
        <Icon className="size-6" aria-hidden />
      </span>
    );
  }

  if (!src) return <span className="block size-full" aria-hidden />;

  return (
    <img
      src={src}
      alt=""
      className={cn(
        'size-full object-cover',
        tile.status === 'uploading' && 'opacity-60',
        tile.status === 'failed' && 'opacity-40',
      )}
      draggable={false}
    />
  );
}

/**
 * Determinate, and it says nothing out loud.
 *
 * `aria-hidden` is load-bearing rather than tidy. A `role="progressbar"` here
 * would put `aria-valuenow="40"` into the accessibility tree — a **number
 * narrated on Стена**, which is exactly the leak D14 records: a load bar on
 * Семья once read «40 % (своя доля 33 %)» aloud while drawing no numbers at
 * all. The state a screen reader needs is "this attachment is still going up",
 * and the composer's footer already says that in words.
 */
function ProgressRing(props: { fraction: number }) {
  const percent = Math.round(Math.max(0, Math.min(1, props.fraction)) * 100);
  return (
    <span aria-hidden className="absolute inset-0 flex items-center justify-center">
      <span
        className="size-8 rounded-full"
        style={{
          background: `conic-gradient(var(--color-primary) ${String(percent)}%, rgba(0,0,0,0.28) 0)`,
        }}
      />
      <span className="absolute size-5 rounded-full bg-background/80" />
    </span>
  );
}

/**
 * A refusal that never became a tile — «Больше четырёх не поместится».
 *
 * `role="status"`, not `role="alert"`: it is the answer to something the member
 * just did, it is not urgent, and an assertive live region interrupts whatever
 * they were reading. It clears itself the next time they pick something.
 */
function Notice(props: { text: string; onDismiss: () => void; inset: 'row' | 'compact' }) {
  // Auto-dismiss, so a refusal about a file that no longer matters does not sit
  // under the composer for the rest of the session.
  //
  // The dependencies are the *text* and the callback, not `props`: an object
  // literal is a new identity on every render, which would restart the timer on
  // every keystroke in the note above and mean the notice never went away.
  // `dismissNotice` is `useCallback`-stable for the same reason.
  const { text, onDismiss } = props;
  useEffect(() => {
    const timer = setTimeout(onDismiss, 6000);
    return () => {
      clearTimeout(timer);
    };
  }, [text, onDismiss]);

  return (
    <p
      role="status"
      className={cn(
        'pb-2 text-[13px] leading-[18px] font-medium text-muted-foreground',
        props.inset === 'row' ? 'px-4' : '',
      )}
    >
      {text}
    </p>
  );
}
