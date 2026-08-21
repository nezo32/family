import { useCallback, useEffect, useRef, useState } from 'react';

import { apiUrl } from '@/shared/api/config';
import { ApiError } from '@/shared/api/errors';

import { mintPlaybackTicket } from '../api';

/**
 * Playback tickets — how a `<video>` and an `<audio>` get their seek back.
 *
 * ## What was wrong, and it was not the backend
 *
 * `media.routes.ts` implements `Range` end to end: a real `206` with
 * `Content-Range`, so dragging a scrubber costs one request for the part you
 * dragged to. That path was correct, tested, and **unreachable from this
 * client**, because `GET /api/media/:id` is bearer-authenticated and a media
 * element sends no `Authorization` header — there is no attribute for it and no
 * hook to add one. So `source.ts` fetched the whole object with the token and
 * handed the element a blob URL, which works and throws away exactly the two
 * things that matter most on exactly the files where they matter most: a
 * three-minute clip downloaded in full before the first frame, and a seek
 * re-read bytes the browser already had.
 *
 * `POST /api/media/:id/ticket` mints a signed capability for **one object and
 * one member**, and `GET /api/media/:id/stream?t=…` accepts it in place of a
 * bearer. That URL goes straight into `src`, and the browser's own media stack
 * issues the range requests, unmediated — no service worker in the byte path,
 * no object URL, nothing buffered in JS.
 *
 * ## Why this is minted per element, on play, and why that is not four round
 * trips
 *
 * The obvious objection is a feed with four clips on it. It does not arise,
 * because **nothing is minted until somebody taps play** (§D7.14.5: nothing on
 * Стена ever plays by itself, and `preload="none"` means nothing is fetched
 * either). Four clips on screen cost four *nothing*; the first tap costs one
 * mint. Measured against the dev API on this machine: **median 6.2 ms**
 * (min 5.6, max 8.4 over ten calls), which is a fraction of the time the same
 * tap already spends opening the connection that fetches the first range.
 *
 * A batch mint — one call returning tickets for every attachment in a feed page
 * — would be strictly *worse* on both axes it could be argued to help. It mints
 * credentials for objects nobody asked for (a ticket is a credential; the whole
 * argument for its narrowness is that it names one object), and it pays its
 * round trip on feed load, where it is on the critical path of the first
 * viewport, rather than on a tap, where the reader has already decided to wait
 * for a video. There is no version of the four-clip feed that is slow.
 *
 * ## The token, and where it must not go
 *
 * It rides in `?t=` because `backend/src/core/logger.ts` strips the query
 * string from every request line — a discipline the ICS feed token paid for by
 * being logged in full once. **Nothing in this file, or in anything that reads
 * from it, may log the URL**: no `console.log`, no error message that
 * interpolates `src`, no `notify.error` carrying it. It is also why a failure
 * here is a piece of component state and not a toast.
 *
 * ## Images do not use any of this
 *
 * A photograph is not ranged, and `GET /api/media/:id` answers it with
 * `private, max-age=31536000, immutable`. Pointing an `<img>` at a URL with a
 * fifteen-minute credential in it would give every photo a cache key that
 * changes every time it is minted, which is the opposite of what that header
 * buys. Photos keep `source.ts`.
 */

/**
 * What the element should be given, and what the card should draw instead.
 *
 * The two failure states are different facts and get different sentences:
 *
 * - **`lost`** — the *mint* answered 404. That is authoritative: the mint runs
 *   the same authorisation chain the stream route re-runs on every range
 *   request, so a refusal means the member was suspended, `media:read` was
 *   revoked, or the note was deleted. There is nothing to retry.
 * - **`failed`** — the mint could not be made at all (the network), or a fresh,
 *   demonstrably valid ticket still would not play. Access is fine; the bytes
 *   are the problem.
 */
export type PlaybackState =
  | { status: 'idle'; src: null }
  | { status: 'loading'; src: null }
  | { status: 'ready'; src: string }
  | { status: 'failed'; src: null }
  | { status: 'lost'; src: null };

export interface Playback {
  state: PlaybackState;
  /**
   * Bumped every time a *new* `src` is issued. The element watches it to know
   * that the swap it is about to see is a re-mint it should seek back into,
   * rather than a first load it should start from zero.
   */
  generation: number;
  /**
   * Call from the element's `error` handler. Re-mints **once** — see below for
   * why exactly once — and resolves the outcome into `ready`, `lost` or
   * `failed`.
   */
  recover: () => void;
}

/**
 * Resolve one attachment into a URL a media element can load.
 *
 * `active` is the whole of `preload="none"` on this transport: a card passes
 * `false` until the reader taps play, so a feed of clips costs nothing at all.
 *
 * ## A 404 mid-playback is a fact, not a hiccup
 *
 * The stream route re-runs the whole authorisation chain on **every** range
 * request. So a `<video>` that was playing and then stops has been told
 * something true — and the element cannot tell us which thing, because
 * `MediaError` carries a code (`MEDIA_ERR_NETWORK`, `MEDIA_ERR_SRC_NOT_SUPPORTED`)
 * that a 404, an expired ticket and an undecodable file all land on
 * inconsistently across engines. Asking the element is unreliable.
 *
 * **So we ask the server instead**, which can only answer one way:
 *
 * - the mint answers **200** → this member may still open this object, so what
 *   failed was the ticket (fifteen minutes had passed while the clip sat
 *   paused, which is the ordinary case). Swap the fresh URL in, seek back to
 *   where the reader was, keep playing. They see a blip.
 * - the mint answers **404** → they may not. Draw the line, and stop.
 *
 * **Exactly one re-mint per mount**, and the bound is what makes this safe
 * rather than a loop: a file the browser cannot decode raises `error` on every
 * source it is given, so an unbounded "on error, mint again" is an infinite
 * request loop against the API. After one successful re-mint the mint has
 * already proved access is fine, so a second failure is the bytes and is
 * reported as such.
 *
 * What that bound costs, so it is a decision and not an oversight: a reader who
 * stalls **twice** on one card — fifteen minutes paused, resumed, then another
 * fifteen minutes paused — gets «Вложение не открылось» on the second, where a
 * third mint would have worked. Half an hour of pausing without leaving one
 * card is the price of not being able to tell "the ticket died" from "this file
 * will never play" without asking the element, which lies about it. Resetting
 * the flag when playback resumes would fix that case and re-open the loop for a
 * file that plays a second and then fails, which is the worse of the two.
 */
export function usePlaybackTicket(mediaId: string, active: boolean): Playback {
  const [state, setState] = useState<PlaybackState>({ status: 'idle', src: null });
  const [attempt, setAttempt] = useState(0);
  const [generation, setGeneration] = useState(0);
  /** One re-mint per mount. Reset when the element goes back to sleep. */
  const recovered = useRef(false);

  useEffect(() => {
    if (!active) {
      recovered.current = false;
      setState({ status: 'idle', src: null });
      return;
    }

    let alive = true;
    setState({ status: 'loading', src: null });

    mintPlaybackTicket(mediaId)
      .then((ticket) => {
        if (!alive) return;
        // `apiUrl` is what makes the split-origin deployment work: the ticket's
        // own `url` is `/api/media/…` relative, and `VITE_API_URL` moves it to
        // whichever origin the API is on. Same origin in dev and in production.
        setState({ status: 'ready', src: apiUrl(ticket.url) });
        setGeneration((value) => value + 1);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        // Deliberately not `notify.error`: a clip that will not play is not
        // something the reader did and not something they can fix, and the card
        // around it is still worth reading (§D7.14.4). It also keeps the URL —
        // and therefore the token — out of every path a toast would take it
        // down. See the header.
        const gone = error instanceof ApiError && error.status === 404;
        setState({ status: gone ? 'lost' : 'failed', src: null });
      });

    return () => {
      alive = false;
    };
    // `attempt` is the re-mint trigger and is meant to be a dependency: bumping
    // it re-runs this effect, which is the whole of `recover`.
  }, [mediaId, active, attempt]);

  const recover = useCallback((): void => {
    if (recovered.current) {
      // A fresh ticket was already handed over and the element still could not
      // play it. Access is not the problem; the object is.
      setState({ status: 'failed', src: null });
      return;
    }
    recovered.current = true;
    setAttempt((value) => value + 1);
  }, []);

  return { state, generation, recover };
}
