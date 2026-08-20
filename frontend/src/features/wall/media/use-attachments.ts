import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaAttachment, MediaKind } from '@family/shared';

import { isApiError } from '@/shared/api/errors';

import { WALL_RU } from '../locale';
import { PhotoDecodeError, preparePhoto, probeDuration } from './encode';
import { formatDurationRu, formatMegabytes, kindOfType, limitsFor } from './limits';
import { discardDraft, isAbort, uploadMedia } from './upload';

/**
 * The composer's attachment strip, as a state machine.
 *
 * ## Upload starts when a file is picked, not when «Повесить» is tapped
 *
 * This is the whole reason `POST /api/media` is a separate phase (§D7.14.7,
 * D15 §2). By the time the member has written a sentence the bytes are already
 * up; a failure is per-file and retryable in place without touching the text;
 * and the note itself is one small JSON request that carries a few uuids.
 *
 * ## No outbox, deliberately
 *
 * `features/shopping/outbox.ts` is a durable IndexedDB queue and it exists
 * because a shop basement has no signal and «молоко куплено» is worthless
 * twenty minutes later. Media fails every part of that test: an outbox stores
 * *intent* and this is megabytes of *bytes*; WebKit has neither Background Sync
 * nor Background Fetch, so the queue would flush only when the app is reopened,
 * at which point re-picking the photo is two taps; and the queued bytes would
 * sit under the 7-day script-writable-storage cap and whole-origin LRU
 * eviction, making the "durable" queue the least durable thing in the feature.
 * A photo posted twenty minutes later is exactly as good as one posted now,
 * which is the property the shopping tick does not have.
 *
 * What replaces it is the cheap half, and it is genuinely enough: the composer
 * persists `{ title, body, attachments: [{id, kind}] }`, the server holds
 * unclaimed uploads for 24 hours, and a member interrupted by a phone call
 * comes back to a cold start with their **already-uploaded photos still on the
 * sheet** — restored from the server, because a `File` handle cannot be
 * persisted but an id can.
 *
 * ## Every refusal happens before a byte moves, except one
 *
 * Size, duration, count, mixed kinds and "this browser cannot decode it" are
 * all answered locally, instantly, from the contract's own numbers. The
 * exception is the format itself: the server decides that by sniffing magic
 * bytes, and its refusal comes back as a Russian sentence in
 * `error.details.file` which is surfaced verbatim on the tile. Inventing a
 * second wording here is how the two drift.
 */

export type TileStatus = 'uploading' | 'done' | 'failed';

export interface AttachmentTile {
  /** Stable local key. Not the attachment id — a failed tile has no id yet. */
  key: string;
  kind: MediaKind;
  /** Object URL of the local file, for the thumbnail. `null` on a restored tile. */
  previewUrl: string | null;
  status: TileStatus;
  /** 0…1 while uploading. */
  progress: number;
  /** Present once the upload succeeded. This is what goes in `attachmentIds`. */
  attachment: MediaAttachment | null;
  /** The Russian reason, shown on the tile. Only when `status === 'failed'`. */
  error: string | null;
}

/** What survives a cold start: ids and kinds, nothing that holds bytes. */
export interface PersistedAttachment {
  id: string;
  kind: MediaKind;
}

export interface AttachmentsApi {
  tiles: readonly AttachmentTile[];
  /** Ids of the finished uploads, **in draw order**. The array is the ordering. */
  attachmentIds: string[];
  /** A refusal that never became a tile — «Больше четырёх не поместится». */
  notice: string | null;
  /** True while any tile is still going up. Gates the submit button. */
  uploading: boolean;
  add: (files: FileList | readonly File[]) => void;
  retry: (key: string) => void;
  remove: (key: string) => void;
  dismissNotice: () => void;
  /** Everything is claimed: forget the tiles without deleting anything. */
  clear: () => void;
  /** The composer was abandoned: forget the tiles and reclaim the drafts. */
  discard: () => void;
  restore: (items: readonly PersistedAttachment[]) => void;
  persisted: () => PersistedAttachment[];
}

interface PendingFile {
  key: string;
  blob: Blob;
}

export function useAttachments(options: { max: number }): AttachmentsApi {
  const { max } = options;
  const [tiles, setTiles] = useState<AttachmentTile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  /** The bytes behind each tile, kept out of state — a `Blob` is not UI. */
  const pending = useRef(new Map<string, PendingFile>());
  const aborters = useRef(new Map<string, AbortController>());
  const previews = useRef(new Set<string>());

  /**
   * A mirror of `tiles`, so `add` can decide without running inside a state
   * updater. Every write to `setTiles` in this hook goes through `commit`,
   * which is what keeps the two from drifting.
   */
  const tilesRef = useRef<AttachmentTile[]>([]);

  const commit = useCallback(
    (next: (current: readonly AttachmentTile[]) => AttachmentTile[]): void => {
      tilesRef.current = next(tilesRef.current);
      setTiles(tilesRef.current);
    },
    [],
  );

  const patch = useCallback(
    (key: string, next: Partial<AttachmentTile>): void => {
      commit((current) => current.map((tile) => (tile.key === key ? { ...tile, ...next } : tile)));
    },
    [commit],
  );

  const start = useCallback(
    (key: string, blob: Blob): void => {
      const controller = new AbortController();
      aborters.current.set(key, controller);
      patch(key, { status: 'uploading', progress: 0, error: null });

      uploadMedia(blob, {
        signal: controller.signal,
        onProgress: (fraction) => {
          patch(key, { progress: fraction });
        },
      }).then(
        (attachment) => {
          aborters.current.delete(key);
          patch(key, { status: 'done', progress: 1, attachment, error: null });
        },
        (error: unknown) => {
          aborters.current.delete(key);
          // A cancelled upload is a tile the member already removed. There is
          // nothing left to tell them about.
          if (isAbort(error)) return;
          patch(key, { status: 'failed', error: refusalOf(error) });
        },
      );
    },
    [patch],
  );

  const add = useCallback(
    (files: FileList | readonly File[]): void => {
      const picked = Array.from(files);
      if (picked.length === 0) return;
      setNotice(null);

      /*
        Computed **outside** `setTiles`, deliberately.

        A state updater has to be pure: React 19 runs it twice in StrictMode, and
        this one mints object URLs, writes to two refs and schedules an upload
        per accepted file. Left inside, every picked photo would upload twice in
        development and once in production — the worst place for a difference to
        live. `tilesRef` mirrors the state so the decision still sees the
        current strip; the `setTiles` call at the end is the pure part.
      */
      const current = tilesRef.current;
      {
        // The kind already committed to, if any. Only the first accepted file
        // gets to choose; §D7.14.2 forbids a mixture, and a video in tile 3 of
        // a 2×2 grid is 178px wide with a play button in it.
        let committed = current[0]?.kind ?? null;
        let room = max - current.length;
        const added: AttachmentTile[] = [];
        let refusal: string | null = null;

        for (const file of picked) {
          if (room <= 0) {
            refusal ??= max === 1 ? WALL_RU.media.onlyOne : WALL_RU.media.tooMany;
            break;
          }

          const kind = kindOfType(file.type) ?? 'image';
          if (committed !== null && kind !== committed) {
            refusal ??= WALL_RU.media.mixedKinds;
            continue;
          }
          // Video and audio are one-per-note whatever `max` says: the grid
          // holds four photos, never two clips (§D7.14.2).
          if (kind !== 'image' && (current.length > 0 || added.length > 0)) {
            refusal ??= WALL_RU.media.mixedKinds;
            continue;
          }
          if (kind !== 'image' && picked.length > 1 && added.length > 0) continue;

          const limits = limitsFor(kind);
          // Photos are re-encoded before this check bites, so the cap is
          // applied to what will actually be sent, not to what was picked. For
          // video and audio the picked file *is* what is sent.
          if (kind !== 'image' && file.size > limits.maxBytes) {
            refusal ??= WALL_RU.media.tooHeavy(kind, formatMegabytes(limits.maxBytes));
            continue;
          }

          const key = `att-${String(Date.now())}-${String(added.length)}-${randomSuffix()}`;
          const previewUrl = URL.createObjectURL(file);
          previews.current.add(previewUrl);
          pending.current.set(key, { key, blob: file });
          added.push({
            key,
            kind,
            previewUrl,
            status: 'uploading',
            progress: 0,
            attachment: null,
            error: null,
          });
          committed ??= kind;
          room -= 1;
        }

        if (refusal) setNotice(refusal);
        if (added.length > 0) {
          tilesRef.current = [...current, ...added];
          setTiles(tilesRef.current);
        }
        // Each accepted tile now goes through its own prepare-then-upload, out
        // of band, so a slow canvas re-encode never blocks the strip appearing.
        for (const tile of added)
          queueMicrotask(() => {
            prepareAndSend(tile.key);
          });
      }

      function prepareAndSend(key: string): void {
        const entry = pending.current.get(key);
        if (!entry || !(entry.blob instanceof File)) return;
        const file = entry.blob;
        const kind = kindOfType(file.type) ?? 'image';

        void (async () => {
          try {
            if (kind === 'image') {
              const prepared = await preparePhoto(file);
              if (prepared.size > limitsFor('image').maxBytes) {
                patch(key, {
                  status: 'failed',
                  error: WALL_RU.media.tooHeavy(
                    'image',
                    formatMegabytes(limitsFor('image').maxBytes),
                  ),
                });
                return;
              }
              pending.current.set(key, { key, blob: prepared });
              start(key, prepared);
              return;
            }

            const limits = limitsFor(kind);
            const durationMs = await probeDuration(file, kind);
            if (
              limits.maxDurationMs !== null &&
              durationMs !== null &&
              durationMs > limits.maxDurationMs
            ) {
              patch(key, {
                status: 'failed',
                error: WALL_RU.media.tooLong(kind, formatDurationRu(limits.maxDurationMs)),
              });
              return;
            }
            start(key, file);
          } catch (error) {
            patch(key, {
              status: 'failed',
              error:
                error instanceof PhotoDecodeError
                  ? WALL_RU.media.cannotOpenPhoto
                  : WALL_RU.media.uploadFailed,
            });
          }
        })();
      }
    },
    [max, patch, start],
  );

  const retry = useCallback(
    (key: string): void => {
      const entry = pending.current.get(key);
      if (!entry) return;
      start(key, entry.blob);
    },
    [start],
  );

  const forget = useCallback(
    (key: string, discardServerSide: boolean): void => {
      aborters.current.get(key)?.abort();
      aborters.current.delete(key);
      pending.current.delete(key);

      // Revoking an object URL and firing a DELETE are side effects, so they
      // happen here rather than inside the updater — same reason as `add`.
      const tile = tilesRef.current.find((item) => item.key === key);
      if (tile?.previewUrl) {
        URL.revokeObjectURL(tile.previewUrl);
        previews.current.delete(tile.previewUrl);
      }
      if (discardServerSide && tile?.attachment) {
        // Best effort. The tile is already gone from the composer, the row is
        // swept within 24 hours either way, and a toast saying that a photo
        // nobody can see failed to be forgotten is noise.
        void discardDraft(tile.attachment.id).catch(() => undefined);
      }
      commit((current) => current.filter((item) => item.key !== key));
    },
    [commit],
  );

  const remove = useCallback(
    (key: string): void => {
      setNotice(null);
      forget(key, true);
    },
    [forget],
  );

  const dropAll = useCallback(
    (discardServerSide: boolean): void => {
      for (const controller of aborters.current.values()) controller.abort();
      aborters.current.clear();
      pending.current.clear();
      setNotice(null);
      for (const tile of tilesRef.current) {
        if (tile.previewUrl) {
          URL.revokeObjectURL(tile.previewUrl);
          previews.current.delete(tile.previewUrl);
        }
        if (discardServerSide && tile.attachment) {
          void discardDraft(tile.attachment.id).catch(() => undefined);
        }
      }
      commit(() => []);
    },
    [commit],
  );

  /**
   * Stable, because `AttachmentField` hangs the notice's six-second
   * auto-dismiss timer off it. A fresh function every render restarts that
   * timer every render, and a refusal about a file nobody remembers then sits
   * under the composer for the rest of the session.
   */
  const dismissNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const clear = useCallback(() => {
    dropAll(false);
  }, [dropAll]);
  const discard = useCallback(() => {
    dropAll(true);
  }, [dropAll]);

  /**
   * Put a cold start's uploads back on the sheet.
   *
   * The tiles come back with no `previewUrl` — the `File` is long gone — so the
   * strip resolves their thumbnails from `/api/media/<id>`, which still answers
   * because the row is unclaimed rather than absent. A `MediaAttachment` is
   * synthesised from what was persisted plus the one thing the tile actually
   * draws; nothing here invents dimensions it does not have.
   */
  const restore = useCallback(
    (items: readonly PersistedAttachment[]): void => {
      commit(() =>
        items.map((item, index) => ({
          key: `restored-${String(index)}-${item.id}`,
          kind: item.kind,
          previewUrl: null,
          status: 'done' as const,
          progress: 1,
          attachment: {
            id: item.id,
            kind: item.kind,
            contentType: '',
            url: `/media/${item.id}`,
            byteSize: 0,
            width: null,
            height: null,
            durationMs: null,
            createdAt: new Date().toISOString(),
          },
          error: null,
        })),
      );
    },
    [commit],
  );

  const persisted = useCallback(
    (): PersistedAttachment[] =>
      tiles
        .filter((tile) => tile.attachment !== null)
        .map((tile) => ({ id: tile.attachment?.id ?? '', kind: tile.kind })),
    [tiles],
  );

  // Object URLs must not outlive the component that made them. This is a
  // cleanup on unmount only — the dependency array is empty on purpose, and the
  // set is a ref precisely so it can be read here without being a dependency.
  const previewSet = previews.current;
  useEffect(
    () => () => {
      for (const url of previewSet) URL.revokeObjectURL(url);
      previewSet.clear();
    },
    [previewSet],
  );

  return {
    tiles,
    attachmentIds: tiles
      .filter((tile) => tile.attachment !== null)
      .map((tile) => tile.attachment?.id ?? ''),
    notice,
    uploading: tiles.some((tile) => tile.status === 'uploading'),
    add,
    retry,
    remove,
    dismissNotice: dismissNotice,
    clear,
    discard,
    restore,
    persisted,
  };
}

/**
 * The server's own sentence, or ours.
 *
 * `error.details.file` is where every media refusal puts its Russian — the
 * format table, the per-kind 413, the unreadable-duration case. Surfacing it
 * verbatim is what keeps the composer from having a second, subtly different
 * vocabulary for the same refusals; §D7.14.6's whole point is that a refusal
 * names the way out, and the server already knows which way that is.
 */
function refusalOf(error: unknown): string {
  if (isApiError(error)) {
    const sentences = error.details?.file;
    if (sentences && sentences.length > 0) return sentences.join(' ');
  }
  return WALL_RU.media.uploadFailed;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
