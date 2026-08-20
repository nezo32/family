import { mediaAttachmentSchema, type MediaAttachment } from '@family/shared';

import { api } from '@/shared/api/client';
import { apiUrl } from '@/shared/api/config';
import { ApiError, NetworkError, toApiError } from '@/shared/api/errors';
import { refreshAccessToken } from '@/shared/api/refresh';
import { getAccessToken } from '@/shared/api/token-store';

/**
 * `POST /api/media` — the one request in this app that is not `fetch`.
 *
 * ## Why XHR, and why that is not a style choice
 *
 * `fetch()` reports **download** progress and not upload progress, and
 * streaming request bodies (`duplex: 'half'`) are unavailable in Safari. A
 * determinate ring on a tile needs `upload.onprogress`, and `XMLHttpRequest` is
 * the only thing in the platform that has one. So this file exists, and it is
 * deliberately the *only* place that talks to the network without going through
 * `shared/api/client.ts`.
 *
 * ## The `File` goes in whole, and that is load-bearing on iOS
 *
 * **Never base64, never an `ArrayBuffer`, never a JSON body with the bytes
 * inlined.** WebKit takes an `UnboundedNetworking` RunningBoard assertion for
 * the duration of an upload — the class of assertion that lets a native app
 * finish a transfer while backgrounded, and unlike a plain `Background`
 * assertion it does not time out after thirty seconds. The trigger is narrow
 * and it is in `ResourceRequestBase::hasUpload()`, verified against WebKit
 * `main` on 2026-08-21:
 *
 * ```cpp
 * for (auto& element : body->elements()) {
 *     if (std::holds_alternative<FormDataElement::EncodedFileData>(element.data)
 *      || std::holds_alternative<FormDataElement::EncodedBlobData>(element.data))
 *         return true;
 * }
 * return false;
 * ```
 *
 * A plain `Data` element — which is what a base64 string or an inlined buffer
 * becomes — returns **false**, gets no assertion, and dies the moment the
 * family member answers a phone call. The difference is invisible in every
 * desktop test anybody will run. Hence `FormData` with the real `File`/`Blob`
 * appended, and hence this comment.
 *
 * (Re-encoded photos arrive here as a `Blob` rather than a `File` — see
 * `encode.ts`. That is fine: `EncodedBlobData` is the other half of the `||`.)
 *
 * **What is still unresolved** (§D7.14.11 item 3): whether that assertion
 * survives a **screen lock** as opposed to an app switch, and whether the
 * promise below is ever resolved after a resume or is simply dropped with the
 * page. There is no primary source in either direction. It does not change this
 * file, because the two-phase design answers both the same way: the bytes are
 * staged server-side with a 24-hour claim window, so a lost promise costs a
 * re-pick and never a lost note.
 *
 * ## Auth
 *
 * The same bearer header and the same single-flight refresh as every other
 * request — `getAccessToken()` for the header, `refreshAccessToken()` once on a
 * 401, then one retry. An XHR that quietly invents its own auth path is how a
 * token-rotation bug is born (D3), so this is a thin adapter over the existing
 * accessor rather than a second API layer. `credentials: 'same-origin'` is
 * XHR's `withCredentials = false` plus a same-origin URL, which is what
 * `apiUrl()` produces.
 */

export interface UploadOptions {
  /** 0…1. Called on every `upload.onprogress` tick that carries a total. */
  onProgress?: (fraction: number) => void;
  /** Aborts the request. The promise then rejects with an `AbortError`. */
  signal?: AbortSignal;
}

export function uploadMedia(file: Blob, options: UploadOptions = {}): Promise<MediaAttachment> {
  return send(file, options, false);
}

function send(file: Blob, options: UploadOptions, retried: boolean): Promise<MediaAttachment> {
  return new Promise<MediaAttachment>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/media'), true);
    xhr.responseType = 'text';
    xhr.setRequestHeader('accept', 'application/json');

    const token = getAccessToken();
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);

    // `content-type` is deliberately never set: the browser has to write the
    // multipart boundary itself, and setting the header strips it.
    const body = new FormData();
    // The real object, whole. See the header — this is the line iOS reads.
    body.append('file', file, filenameFor(file));

    const onAbort = (): void => {
      xhr.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const done = (): void => {
      options.signal?.removeEventListener('abort', onAbort);
    };

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total === 0) return;
      options.onProgress?.(Math.min(1, event.loaded / event.total));
    };

    xhr.onabort = () => {
      done();
      reject(abortError());
    };

    // A transport failure — offline, DNS, the connection dropped mid-body. Not
    // an HTTP status, so there is nothing to parse and nothing to retry here.
    xhr.onerror = () => {
      done();
      reject(new NetworkError(new Error('Upload failed')));
    };

    xhr.ontimeout = () => {
      done();
      reject(new NetworkError(new Error('Upload timed out')));
    };

    xhr.onload = () => {
      done();
      const requestId = xhr.getResponseHeader('x-request-id') ?? undefined;

      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = mediaAttachmentSchema.safeParse(parseJson(xhr.responseText));
        if (parsed.success) resolve(parsed.data);
        // A 201 whose body is not a `mediaAttachment` is a contract drift, and
        // it has to fail loudly at the boundary rather than as `undefined.kind`
        // three components deep — the same rule `features/wall/api.ts` follows.
        else reject(new ApiError({ code: 'INTERNAL_ERROR', status: xhr.status, requestId }));
        return;
      }

      const error = toApiError(xhr.status, parseJson(xhr.responseText), requestId);

      // Exactly one silent refresh and one retry, mirroring `client.ts`. A cold
      // PWA start has no access token at all, so the very first upload after a
      // resume legitimately lands here.
      if (xhr.status === 401 && !retried) {
        void refreshAccessToken().then((fresh) => {
          if (!fresh) {
            reject(error);
            return;
          }
          send(file, options, true).then(resolve, reject);
        }, reject);
        return;
      }

      reject(error);
    };

    xhr.send(body);
  });
}

/**
 * A name for the part, invented here.
 *
 * The server never trusts, stores or echoes it — the stored `Content-Type`
 * comes from the magic bytes and the served filename is `<id>.<ext>` — so this
 * exists only because a multipart part without a `filename` is parsed as a
 * *field* rather than as a *file* by `@fastify/multipart`, and the route would
 * then answer «Expected one multipart file part».
 */
function filenameFor(file: Blob): string {
  if (file instanceof File && file.name.length > 0) return file.name;
  return 'upload';
}

function parseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The same shape `fetch` throws on an abort, so callers can treat a cancelled
 * upload exactly as they treat a cancelled query — a caller's decision, not a
 * failure worth a toast.
 */
function abortError(): DOMException {
  return new DOMException('Upload aborted', 'AbortError');
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * `DELETE /api/media/:id` — the ✕ on a tile that has finished uploading.
 *
 * Only ever called for a **draft**: the server answers 409 for anything already
 * claimed, because removing a posted attachment is a post delete (§D7.14.9,
 * attachments are immutable once claimed). Failure is swallowed by the caller
 * on purpose — the tile has already gone from the composer, the row is swept
 * within 24 hours either way, and a toast saying a photo nobody can see any
 * more failed to be forgotten is noise.
 */
export async function discardDraft(id: string): Promise<void> {
  await api.del<unknown>(`/media/${id}`);
}
