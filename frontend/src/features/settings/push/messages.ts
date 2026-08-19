/**
 * The message protocol between `src/sw.ts` and the app.
 *
 * Imported by both sides (relative paths only — see `payload.ts`) so a renamed
 * message type is a compile error rather than a silently dead notification tap.
 */

/** SW → page: "the user tapped a notification, take them here." */
export const PUSH_NAVIGATE = 'FAMILY_PUSH_NAVIGATE' as const;

/** SW → page: "I queued at least one delivery ack, flush it when you can." */
export const ACKS_PENDING = 'FAMILY_PUSH_ACKS_PENDING' as const;

/**
 * SW → page: "lend me the in-memory access token."
 *
 * D3 keeps the access JWT out of every storage the service worker can read, so
 * borrowing it from a live window is the only way an ack can go out
 * immediately. The reply travels back over the `MessagePort` in `ports[0]`.
 * When no window is open — the normal case for a push — the SW gets nothing and
 * falls back to the IndexedDB queue.
 */
export const TOKEN_REQUEST = 'FAMILY_PUSH_TOKEN_REQUEST' as const;

export interface PushNavigateMessage {
  type: typeof PUSH_NAVIGATE;
  /** Same-origin path, already sanitised by `safeNavigatePath`. */
  url: string;
  deliveryId: string | null;
}

export interface AcksPendingMessage {
  type: typeof ACKS_PENDING;
}

export interface TokenRequestMessage {
  type: typeof TOKEN_REQUEST;
}

export interface TokenReplyMessage {
  token: string | null;
}

export type SwMessage = PushNavigateMessage | AcksPendingMessage | TokenRequestMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isPushNavigateMessage(value: unknown): value is PushNavigateMessage {
  return isRecord(value) && value.type === PUSH_NAVIGATE && typeof value.url === 'string';
}

export function isAcksPendingMessage(value: unknown): value is AcksPendingMessage {
  return isRecord(value) && value.type === ACKS_PENDING;
}

export function isTokenRequestMessage(value: unknown): value is TokenRequestMessage {
  return isRecord(value) && value.type === TOKEN_REQUEST;
}
