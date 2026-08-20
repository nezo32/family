import type { ChangeDomain, RevisionMap } from '@family/shared';
import { CHANGE_DOMAINS } from '@family/shared';

import { logger } from './logger.js';
import { getRedis } from './redis.js';

/**
 * The revision store behind `GET /api/changes` (D12,
 * `docs/architecture/sync.md` §3).
 *
 * Seven integers in one Redis hash, incremented by every successful write and
 * read by the change feed. No TTL, no trimming, no growth — and deliberately no
 * pub/sub, so this is ordinary command traffic on the *shared* ioredis client
 * rather than a second connection.
 *
 * ## Redis is not the source of truth here
 *
 * The counters carry no data: they are a signal saying "something in this
 * domain moved". Losing them costs one extra refetch per client and nothing
 * else, which is why nothing in this file retries, and why a failed bump is
 * logged at `warn` and swallowed. A write that succeeded must never be reported
 * as failed because a cache counter could not be incremented.
 *
 * Persistence is `appendonly yes` / `appendfsync everysec`
 * (`infra/docker-compose.yml`), so the counters normally survive a restart. If
 * they are ever lost they restart at 1 — *lower* than the numbers clients are
 * holding — which the client's `!==` comparison reads as "changed" and handles
 * by invalidating each domain exactly once. That is the whole recovery story.
 */

export const REVISION_HASH_KEY = 'family:rev';

const KNOWN_DOMAINS = new Set<string>(CHANGE_DOMAINS);

/**
 * Increment one counter per domain, in a single pipeline.
 *
 * Callers inside an HTTP request do not await this — the response has already
 * been sent by the time the `onResponse` hook runs (§4.1). Workers do await it,
 * because a job that returns before its bump is dispatched may have its process
 * torn down first.
 *
 * Never throws.
 */
export async function bumpRevisions(domains: readonly ChangeDomain[]): Promise<void> {
  if (domains.length === 0) return;

  try {
    const pipeline = getRedis().pipeline();
    for (const domain of domains) pipeline.hincrby(REVISION_HASH_KEY, domain, 1);
    await pipeline.exec();
  } catch (err) {
    // A latency bug, never a correctness bug: the affected queries still
    // refresh on focus and on mount.
    logger.warn({ err, domains }, 'failed to bump change revisions');
  }
}

/**
 * The whole map, coerced to numbers.
 *
 * Unknown fields are dropped rather than passed through: the response schema is
 * an enum-keyed record and would reject a stray key outright, so a hash left
 * over from an older domain list must not reach the serializer. A hash that
 * does not exist yet reads as `{}`, which the client treats as a baseline and
 * not as a change.
 *
 * Throws if Redis is unreachable — the route lets that become a 500 and the
 * client's degraded mode (§5.4) takes over after three failures.
 */
export async function readRevisions(): Promise<RevisionMap> {
  const raw = await getRedis().hgetall(REVISION_HASH_KEY);

  const map: RevisionMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_DOMAINS.has(key)) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;
    map[key as ChangeDomain] = parsed;
  }
  return map;
}
