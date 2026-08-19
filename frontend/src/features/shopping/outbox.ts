/**
 * The shopping outbox — a durable, IndexedDB-backed mutation queue.
 *
 * This is the only part of the app designed to be used with **no network at
 * all**: a shop basement, the dacha, the metro. Everything here follows from
 * three documents.
 *
 * ### `docs/research/ios-pwa-push.md` §7 — there is no Background Sync
 *
 * `ServiceWorkerRegistration.sync` and `periodicSync` are unimplemented in
 * WebKit. The only code that runs in the background on iOS is a `push` handler.
 * So this queue flushes on exactly two signals — the `online` event and
 * `visibilitychange -> visible` — and **never** promises the user background
 * delivery. `startOutboxAutoFlush()` deliberately contains no `sync`
 * registration; do not add one, it would work on Android and quietly mislead
 * everyone on iPhone.
 *
 * ### §3.7 — client storage is a cache, never the source of truth
 *
 * Postgres is the truth. This queue stores *intent* ("mark молоко bought at
 * 18:42"), not state, and every entry disappears the moment the server has
 * acknowledged it. Nothing reads its own list of items back out of IndexedDB.
 * `navigator.storage.persist()` is requested once, best effort, because Safari
 * grants it to installed home-screen apps and that is exactly our user.
 *
 * ### `docs/architecture/household.md` §4 — the idempotency contract
 *
 * 1. The `clientId` (UUID) is minted **before** the optimistic insert, never at
 *    flush time. It is the only dedupe key that exists — mint it late and a
 *    retried flush creates a second «молоко».
 * 2. `POST /lists/:id/items` answers `201` first time and `200` on replay, and
 *    returns the row either way. Because reconciliation is keyed on `clientId`,
 *    both answers take the identical path: swap the optimistic row for the
 *    returned one, drop the entry. There is deliberately no branch on status.
 * 3. `POST /items/:id/toggle` carries `occurredAt` — the moment of the *tap*.
 *    A queue that flushes twenty minutes later must record when the finger
 *    landed, not when the packet did. The server's state guard is the
 *    idempotency, and it discards a `bought:false` older than the stored
 *    `bought_at`: bought beats needed.
 *
 * ### Transaction discipline
 *
 * IndexedDB transactions auto-commit the moment the event loop goes idle, so a
 * transaction held across a `fetch()` does not merely block writers — it dies.
 * Every operation below opens its own short transaction and awaits its
 * completion before returning. `flushOutbox()` reads the whole queue, closes
 * the read, and only then touches the network; each removal opens a fresh
 * transaction afterwards. There is no code path where a transaction is open
 * while a request is in flight.
 */

/* -------------------------------------------------------------------------- */
/* Entry shapes                                                               */
/* -------------------------------------------------------------------------- */

export type OutboxKind = 'add' | 'toggle';

interface OutboxEntryBase {
  /**
   * Dedupe key **and** primary key. `add:<clientId>` for an insert,
   * `toggle:<itemId>` for a tick. Enqueuing an existing key overwrites rather
   * than appends, which is what makes a replayed `clientId` a no-op and makes
   * three frantic taps on the same checkbox collapse into one intent.
   */
  id: string;
  kind: OutboxKind;
  /** Epoch ms. Entries flush oldest-first so an add always precedes its toggle. */
  createdAt: number;
  attempts: number;
  /** `ErrorCode` of the last transient failure, for debugging. Never rendered. */
  lastErrorCode?: string;
}

export interface OutboxAddEntry extends OutboxEntryBase {
  kind: 'add';
  listId: string;
  /** Minted before the optimistic insert. The row's identity until the server answers. */
  clientId: string;
  item: {
    name: string;
    quantity: number | null;
    unit: string | null;
    category: string | null;
    note: string | null;
    isUrgent: boolean;
  };
}

export interface OutboxToggleEntry extends OutboxEntryBase {
  kind: 'toggle';
  listId: string;
  /**
   * The item being ticked. While its `add` is still queued this is the
   * optimistic id (= that entry's `clientId`); {@link remapItemId} rewrites it
   * to the server id as soon as the insert lands.
   */
  itemId: string;
  clientId: string;
  bought: boolean;
  /** ISO instant of the **tap**, not of the flush. */
  occurredAt: string;
}

export type OutboxEntry = OutboxAddEntry | OutboxToggleEntry;

export function addEntryId(clientId: string): string {
  return `add:${clientId}`;
}

export function toggleEntryId(itemId: string): string {
  return `toggle:${itemId}`;
}

/* -------------------------------------------------------------------------- */
/* Storage driver                                                             */
/* -------------------------------------------------------------------------- */

const DB_NAME = 'family-shopping';
const DB_VERSION = 1;
const STORE = 'outbox';

interface OutboxDriver {
  all(): Promise<OutboxEntry[]>;
  put(entry: OutboxEntry): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * In-memory fallback. Used by jsdom (no IndexedDB) and by any browser where
 * opening the database fails — private windows, a corrupted store, a user who
 * blocked site data. Losing the queue on reload is far better than a shopping
 * screen that throws, and §3.7 already says this storage is only ever a cache.
 */
function createMemoryDriver(): OutboxDriver {
  const rows = new Map<string, OutboxEntry>();
  return {
    all: () => Promise.resolve([...rows.values()]),
    put: (entry) => {
      rows.set(entry.id, entry);
      return Promise.resolve();
    },
    remove: (id) => {
      rows.delete(id);
      return Promise.resolve();
    },
    clear: () => {
      rows.clear();
      return Promise.resolve();
    },
  };
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

/** Resolves when the transaction has actually committed, not when the request fired. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    request.onblocked = () => {
      reject(new Error('IndexedDB open blocked'));
    };
  });
}

function createIdbDriver(): OutboxDriver {
  let handle: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => (handle ??= openDatabase());

  /**
   * One short transaction per call. `run` receives the store, returns a value,
   * and we await the *commit* — so by the time the caller continues, nothing is
   * held open. No `await` of anything else may appear inside `run`.
   */
  async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>) {
    const database = await db();
    const transaction = database.transaction(STORE, mode);
    const result = run(transaction.objectStore(STORE));
    const [value] = await Promise.all([result, committed(transaction)]);
    return value;
  }

  return {
    all: () => tx('readonly', (store) => promisify(store.getAll() as IDBRequest<OutboxEntry[]>)),
    put: (entry) =>
      tx('readwrite', async (store) => {
        await promisify(store.put(entry));
      }),
    remove: (id) =>
      tx('readwrite', async (store) => {
        await promisify(store.delete(id));
      }),
    clear: () =>
      tx('readwrite', async (store) => {
        await promisify(store.clear());
      }),
  };
}

let driver: OutboxDriver | null = null;

function getDriver(): OutboxDriver {
  if (driver) return driver;
  if (typeof indexedDB === 'undefined') {
    driver = createMemoryDriver();
    return driver;
  }
  const idb = createIdbDriver();
  // Fall back to memory the first time IndexedDB actually misbehaves.
  driver = {
    all: () => idb.all().catch(() => degrade().all()),
    put: (entry) => idb.put(entry).catch(() => degrade().put(entry)),
    remove: (id) => idb.remove(id).catch(() => degrade().remove(id)),
    clear: () => idb.clear().catch(() => degrade().clear()),
  };
  return driver;
}

function degrade(): OutboxDriver {
  console.warn('[shopping] IndexedDB unavailable — queueing in memory for this session only');
  driver = createMemoryDriver();
  return driver;
}

/** Best effort, once, silently. WebKit grants it to installed home-screen apps (§6). */
let persistenceRequested = false;
export function requestPersistentStorage(): void {
  if (persistenceRequested) return;
  persistenceRequested = true;
  void navigator.storage?.persist?.().catch(() => undefined);
}

/* -------------------------------------------------------------------------- */
/* Observable state                                                           */
/* -------------------------------------------------------------------------- */

export interface OutboxState {
  /** How many changes are still waiting. Drives the honest offline banner. */
  pending: number;
  /**
   * Ids a row can be recognised by while it is unsent — an add's `clientId`
   * and a toggle's `itemId`. `ItemRow` shows «не отправлено» for any row whose
   * `clientId` or `id` is in here.
   */
  pendingIds: ReadonlySet<string>;
  flushing: boolean;
}

const EMPTY_STATE: OutboxState = { pending: 0, pendingIds: new Set(), flushing: false };

let state: OutboxState = EMPTY_STATE;
const listeners = new Set<() => void>();

function emit(next: OutboxState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore` subscribe. */
export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `useSyncExternalStore` snapshot — stable identity between changes. */
export function getOutboxState(): OutboxState {
  return state;
}

async function refreshState(flushing = state.flushing): Promise<OutboxEntry[]> {
  const entries = await getDriver().all();
  const pendingIds = new Set<string>();
  for (const entry of entries) {
    pendingIds.add(entry.kind === 'add' ? entry.clientId : entry.itemId);
  }
  emit({ pending: entries.length, pendingIds, flushing });
  return entries;
}

/** Re-reads the queue from storage. Call on mount and after a foreground. */
export async function refreshOutbox(): Promise<void> {
  await refreshState();
}

/* -------------------------------------------------------------------------- */
/* Enqueue                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A UUID that works outside a secure context too.
 *
 * `crypto.randomUUID` is unavailable on `http://192.168.x.x` (a LAN dev server
 * is not a secure context), and the whole design falls apart without a client
 * id, so there is a `getRandomValues` fallback and, failing that, a
 * time-plus-random one.
 */
export function newClientId(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16));
    // RFC 4122 version 4 / variant 10xx.
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const rand = Math.random().toString(16).slice(2).padEnd(12, '0');
  return `${Date.now().toString(16).padStart(12, '0')}-4${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 12)}`;
}

export interface EnqueueAddInput {
  listId: string;
  /** Minted by the caller **before** it renders the optimistic row. */
  clientId: string;
  item: OutboxAddEntry['item'];
}

export async function enqueueAdd(input: EnqueueAddInput): Promise<OutboxAddEntry> {
  const entry: OutboxAddEntry = {
    id: addEntryId(input.clientId),
    kind: 'add',
    createdAt: Date.now(),
    attempts: 0,
    listId: input.listId,
    clientId: input.clientId,
    item: input.item,
  };
  await getDriver().put(entry);
  await refreshState();
  return entry;
}

export interface EnqueueToggleInput {
  listId: string;
  itemId: string;
  bought: boolean;
  /** The moment of the tap. Defaults to now, which is the same thing at tap time. */
  occurredAt?: string;
}

export async function enqueueToggle(input: EnqueueToggleInput): Promise<OutboxToggleEntry> {
  const entry: OutboxToggleEntry = {
    id: toggleEntryId(input.itemId),
    kind: 'toggle',
    createdAt: Date.now(),
    attempts: 0,
    listId: input.listId,
    itemId: input.itemId,
    clientId: newClientId(),
    bought: input.bought,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
  await getDriver().put(entry);
  await refreshState();
  return entry;
}

/**
 * Rewrites queued toggles that still point at an optimistic id.
 *
 * Sequence this fixes: offline, the user adds «молоко» (id = its `clientId`)
 * and immediately ticks it. Two entries queue up. On flush the insert lands
 * first and the server hands back a real uuid — the toggle must follow the row,
 * not the ghost.
 */
export async function remapItemId(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const driverRef = getDriver();
  const entries = await driverRef.all();
  for (const entry of entries) {
    if (entry.kind !== 'toggle' || entry.itemId !== fromId) continue;
    await driverRef.remove(entry.id);
    await driverRef.put({ ...entry, id: toggleEntryId(toId), itemId: toId });
  }
}

/** Drops everything. Used on sign-out and by tests. */
export async function clearOutbox(): Promise<void> {
  await getDriver().clear();
  emit({ pending: 0, pendingIds: new Set(), flushing: false });
}

/* -------------------------------------------------------------------------- */
/* Flush                                                                      */
/* -------------------------------------------------------------------------- */

/** After this many transient failures we stop hoping and roll the change back. */
const MAX_ATTEMPTS = 8;

export interface OutboxHandlers {
  /**
   * Send one entry. Resolves when the server has accepted it (`200` or `201` —
   * both mean accepted, see the header) and the cache has been reconciled.
   * Throws to signal failure; {@link isPermanentFailure} decides retry vs drop.
   */
  perform: (entry: OutboxEntry) => Promise<void>;
  /**
   * Send several queued inserts for one list as a single
   * `POST /lists/:id/items/bulk`. Optional — without it the batch is sent one
   * request at a time, which is correct, just chattier.
   */
  performBatch?: (entries: OutboxAddEntry[]) => Promise<void>;
  /**
   * The change will never be sent — the server rejected it, or we ran out of
   * attempts. Roll the optimistic row back and tell the user, in Russian.
   */
  onDrop?: (entry: OutboxEntry, error: unknown) => void;
}

/** The server caps `items[]` at 100 per bulk request. */
const MAX_BATCH = 100;

/**
 * Consecutive inserts into the same list travel together.
 *
 * A family standing in the kitchen types six lines into the quick-add box at
 * once; replaying that as six requests over a two-bar connection is six chances
 * to fail. Only *consecutive* entries are merged, so an insert never overtakes
 * the toggle that was queued between them.
 */
function batchEntries(entries: readonly OutboxEntry[]): OutboxEntry[][] {
  const batches: OutboxEntry[][] = [];
  for (const entry of entries) {
    const current = batches.at(-1);
    const head = current?.[0];
    if (
      current &&
      head?.kind === 'add' &&
      entry.kind === 'add' &&
      head.listId === entry.listId &&
      current.length < MAX_BATCH
    ) {
      current.push(entry);
    } else {
      batches.push([entry]);
    }
  }
  return batches;
}

export interface FlushResult {
  sent: number;
  dropped: number;
  /** Entries still queued when we gave up (we are offline). */
  remaining: number;
}

/**
 * A 4xx will not become a 2xx by asking again — the body is wrong, the row is
 * gone, or the caller lacks the permission. `408` and `429` are the two 4xx
 * that genuinely mean "later", so they stay in the queue. Anything without a
 * status (a `NetworkError`) is the offline case and always retries.
 */
export function isPermanentFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return false;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

let inFlight: Promise<FlushResult> | null = null;

/**
 * Drain the queue, oldest entry first.
 *
 * Single-flight: `online` and `visibilitychange` fire together when a phone
 * wakes up on Wi-Fi, and two concurrent drains would send every mutation twice.
 * (Twice is survivable — that is what `clientId` is for — but it doubles the
 * traffic of the one screen that is used with a bad connection.)
 *
 * A transient failure stops the whole drain: if the first request timed out we
 * are offline, and hammering the remaining nine wastes battery and reorders
 * nothing usefully. Ordering matters — an `add` must reach the server before
 * the `toggle` that follows it.
 */
export function flushOutbox(handlers: OutboxHandlers): Promise<FlushResult> {
  inFlight ??= runFlush(handlers).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runFlush(handlers: OutboxHandlers): Promise<FlushResult> {
  // One short read transaction, fully committed before any network call.
  const entries = (await refreshState(true)).sort((a, b) => a.createdAt - b.createdAt);

  const driverRef = getDriver();
  let sent = 0;
  let dropped = 0;
  let offline = false;

  for (const batch of batchEntries(entries)) {
    if (offline) break;
    try {
      await send(handlers, batch);
      for (const entry of batch) await driverRef.remove(entry.id);
      sent += batch.length;
    } catch (error) {
      const permanent = isPermanentFailure(error);
      for (const entry of batch) {
        const attempts = entry.attempts + 1;
        if (permanent || attempts >= MAX_ATTEMPTS) {
          await driverRef.remove(entry.id);
          dropped += 1;
          handlers.onDrop?.(entry, error);
          continue;
        }
        const code = codeOf(error);
        await driverRef.put({ ...entry, attempts, ...(code ? { lastErrorCode: code } : {}) });
        // Transient: we are offline. Stop after this batch and wait for the
        // next `online` / foreground signal rather than burning the battery.
        offline = true;
      }
      // A *rejected* batch says nothing about the next one, so a permanent
      // failure keeps the drain going.
    }
  }

  const remaining = await refreshState(false);
  return { sent, dropped, remaining: remaining.length };
}

async function send(handlers: OutboxHandlers, batch: OutboxEntry[]): Promise<void> {
  const [first] = batch;
  if (first === undefined) return;
  if (batch.length === 1) {
    await handlers.perform(first);
    return;
  }
  if (handlers.performBatch) {
    await handlers.performBatch(batch.filter((entry) => entry.kind === 'add'));
    return;
  }
  for (const entry of batch) await handlers.perform(entry);
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/* -------------------------------------------------------------------------- */
/* Auto-flush                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Wire the queue to the only two signals iOS gives us.
 *
 * **No Background Sync** (`ios-pwa-push.md` §7): `registration.sync` does not
 * exist in WebKit, so there is no such call here and the UI never says
 * "отправим в фоне". What it says is «отправим, когда откроете приложение со
 * связью», which is the truth.
 *
 * `visibilitychange -> visible` matters more than `online` on iOS: a
 * backgrounded PWA is frozen or killed outright (§8), so returning to the app
 * is usually the first moment our code runs again.
 */
export function startOutboxAutoFlush(handlers: OutboxHandlers): () => void {
  requestPersistentStorage();

  const flush = (): void => {
    void flushOutbox(handlers).catch(() => undefined);
  };

  const onVisible = (): void => {
    if (document.visibilityState === 'visible') flush();
  };

  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', onVisible);

  // Catch up on whatever a previous session left behind.
  void refreshOutbox().then(flush, () => undefined);

  return () => {
    window.removeEventListener('online', flush);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
