import { Redis, type RedisOptions } from 'ioredis';

import { getConfig } from './config.js';
import { logger } from './logger.js';

/**
 * Redis connections.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on the connections it uses for
 * blocking commands, and it must NOT share a connection with ordinary command
 * traffic — hence the separate factories.
 */

const baseOptions: RedisOptions = {
  lazyConnect: false,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
};

let client: Redis | undefined;
const bullConnections: Redis[] = [];

/** Shared connection for ordinary cache/lock traffic. */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(getConfig().REDIS_URL, baseOptions);
    client.on('error', (err) => logger.error({ err }, 'redis error'));
  }
  return client;
}

/**
 * A dedicated connection for a BullMQ Queue or Worker.
 * Each queue/worker gets its own; they are tracked so shutdown can close them.
 */
export function createBullConnection(): Redis {
  const conn = new Redis(getConfig().REDIS_URL, {
    ...baseOptions,
    // Required by BullMQ for blocking operations.
    maxRetriesPerRequest: null,
  });
  conn.on('error', (err) => logger.error({ err }, 'redis (bullmq) error'));
  bullConnections.push(conn);
  return conn;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([
    ...bullConnections.map((c) => c.quit()),
    client ? client.quit() : Promise.resolve(),
  ]);
  bullConnections.length = 0;
  client = undefined;
}

/** Liveness probe used by `/ready`. */
export async function pingRedis(): Promise<boolean> {
  try {
    return (await getRedis().ping()) === 'PONG';
  } catch {
    return false;
  }
}
