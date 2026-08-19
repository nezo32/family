/**
 * The D11 delivery-ack queue.
 *
 * Imported by both `src/sw.ts` and the app shell, so it may use nothing beyond
 * IndexedDB and `fetch` — no DOM, no React, no `@/` alias.
 *
 * ## The contract (D11)
 *
 * | When | Endpoint |
 * |---|---|
 * | after `showNotification()` resolves in `push` | `POST /api/notifications/deliveries/:id/delivered` |
 * | in `notificationclick`, before navigating     | `POST /api/notifications/deliveries/:id/interacted` |
 *
 * Body is `{ occurredAt }` — an ISO-8601 instant recorded when the event
 * *actually happened*, not when the request finally went out. The server clamps
 * it into `[sentAt - skew, now]`, so a wrong device clock cannot invent a
 * receipt.
 *
 * ## Why there is a queue at all
 *
 * Two independent reasons, and both of them are the difference between a
 * working subscription and a dead one:
 *
 * 1. **The ack must never throw.** Showing the notification is the one thing iOS
 *    requires; an ack that rejects inside `event.waitUntil()` marks the whole
 *    push as failed and, three of those later, costs us the subscription. Every
 *    function here swallows its own errors and reports a boolean.
 * 2. **The service worker has no access token.** D3 keeps the access JWT in page
 *    memory only, and the ack endpoints are guarded by
 *    `notification:manage:own`. When a push arrives with the app swiped away
 *    there is no window to borrow a token from — which is exactly the case that
 *    matters most. So the SW records the ack durably and the *app* flushes it on
 *    the next foreground, through the normal authenticated client.
 *
 * The queue key is `${deliveryId}:${kind}`, so a replayed flush is a no-op both
 * here and server-side (delivery status only ever moves forward).
 */

export type AckKind = 'delivered' | 'interacted';

export interface QueuedAck {
  /** `${deliveryId}:${kind}` — the primary key, which makes replay idempotent. */
  key: string;
  deliveryId: string;
  kind: AckKind;
  /** When the push actually arrived / was tapped. */
  occurredAt: string;
  /** When it was written here, for the age cap below. */
  queuedAt: string;
}

const DB_NAME = 'family-push';
const DB_VERSION = 1;
const STORE = 'ack-queue';

/**
 * Acks older than this are dropped rather than flushed: the escalation sweep has
 * long since given up on them, and a stale `delivered` would only muddy the
 * "did this device receive anything" signal.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Guards against an unbounded queue on a device that is offline for a month. */
const MAX_QUEUE_SIZE = 200;

export function ackKey(deliveryId: string, kind: AckKind): string {
  return `${deliveryId}:${kind}`;
}

/** `POST /api/notifications/deliveries/:id/{delivered|interacted}`. */
export function ackPath(deliveryId: string, kind: AckKind): string {
  return `/notifications/deliveries/${encodeURIComponent(deliveryId)}/${kind}`;
}

/* -------------------------------------------------------------------------- */
/* IndexedDB plumbing — every function resolves, none of them throws           */
/* -------------------------------------------------------------------------- */

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      resolve(null);
    };
    // Another tab holds an old version open; give up rather than hang forever.
    request.onblocked = () => {
      resolve(null);
    };
  });
}

function finish(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => {
      resolve(true);
    };
    tx.onerror = () => {
      resolve(false);
    };
    tx.onabort = () => {
      resolve(false);
    };
  });
}

/** Store one ack. Returns `false` when storage was unavailable — never throws. */
export async function enqueueAck(ack: QueuedAck): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(ack);
    return await finish(tx);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Everything currently queued, oldest first, with expired entries dropped. */
export async function readQueuedAcks(now: number = Date.now()): Promise<QueuedAck[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).getAll();
    const rows = await new Promise<QueuedAck[]>((resolve) => {
      request.onsuccess = () => {
        resolve((request.result as QueuedAck[] | undefined) ?? []);
      };
      request.onerror = () => {
        resolve([]);
      };
    });
    return rows
      .filter((row) => now - Date.parse(row.queuedAt) < MAX_AGE_MS)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
      .slice(0, MAX_QUEUE_SIZE);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Drop the given keys. Called after a successful (or permanently failed) POST. */
export async function removeAcks(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const key of keys) store.delete(key);
    await finish(tx);
  } catch {
    // Nothing to do: a stale row is retried and is idempotent server-side.
  } finally {
    db.close();
  }
}

/* -------------------------------------------------------------------------- */
/* The service-worker side of the POST                                         */
/* -------------------------------------------------------------------------- */

export interface AckPostResult {
  /** The server accepted it (or told us it is already past this state). */
  ok: boolean;
  /**
   * True when retrying later could succeed — no token, offline, 5xx. `false`
   * means "give up and forget it": a 404 delivery, a 403 that will not change.
   */
  retryable: boolean;
}

/**
 * One ack POST. Resolves; never rejects.
 *
 * `token` is the in-memory access token when a window client could hand one
 * over, and `null` when the app is not running — which is the common case for a
 * push. Without a token the call is not even attempted: an unauthenticated POST
 * would 401, and burning a request to learn that is pointless when the app will
 * flush the queue on next foreground anyway.
 */
export async function postAck(
  ack: QueuedAck,
  options: { apiBase: string; token: string | null },
): Promise<AckPostResult> {
  if (!options.token) return { ok: false, retryable: true };

  try {
    const response = await fetch(`${options.apiBase}/api${ackPath(ack.deliveryId, ack.kind)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${options.token}`,
      },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ occurredAt: ack.occurredAt }),
    });
    if (response.ok) return { ok: true, retryable: false };
    // 401 → the borrowed token had already expired; the app will retry with a
    // fresh one. 404/403/400 → this delivery will never be ackable.
    return { ok: false, retryable: response.status === 401 || response.status >= 500 };
  } catch {
    // Network failure: the device is offline, which is precisely what the queue
    // is for.
    return { ok: false, retryable: true };
  }
}

/**
 * Record an ack and try to deliver it immediately.
 *
 * The write happens **first**: if the POST then fails, or the service worker is
 * killed mid-flight, the ack survives. Returns nothing on purpose — no caller
 * may branch on the outcome of an ack.
 */
export async function ackDelivery(
  deliveryId: string,
  kind: AckKind,
  options: { apiBase: string; token: string | null; occurredAt?: string },
): Promise<void> {
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  const ack: QueuedAck = {
    key: ackKey(deliveryId, kind),
    deliveryId,
    kind,
    occurredAt,
    queuedAt: new Date().toISOString(),
  };

  await enqueueAck(ack);
  const result = await postAck(ack, options);
  if (result.ok || !result.retryable) await removeAcks([ack.key]);
}
