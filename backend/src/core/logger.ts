import { pino, type LoggerOptions } from 'pino';

import { getConfig } from './config.js';

/**
 * Structured logging.
 *
 * Redaction is deliberately aggressive: this application handles OAuth codes,
 * refresh tokens and Web Push endpoints (which are capability URLs — anyone
 * holding one can send the family notifications). None of them may ever reach
 * a log file.
 */
const REDACT_PATHS = [
  // Bare keys as well as nested ones: pino's `*.x` wildcard matches one level
  // down, NOT the root of the merged object, so `logger.debug({ endpoint })`
  // would otherwise print in full.
  'endpoint',
  'token',
  'code',
  'password',
  'ticket',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.clientSecret',
  '*.code',
  '*.codeVerifier',
  '*.tokenHash',
  '*.endpoint',
  '*.p256dh',
  '*.auth',
  'subscription.endpoint',
  'subscription.keys',
];

export function buildLoggerOptions(): LoggerOptions {
  const config = getConfig();

  const base: LoggerOptions = {
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      req(req: { method: string; url: string; id: string }) {
        // Strip the query string. The ICS feed token and the account-status
        // ticket travel there, and both are long-lived capabilities — logging
        // one hands anyone with log access a permanent read of that member's
        // calendar. Fastify logs `req` at info on every request.
        return { method: req.method, url: req.url.split('?')[0], id: req.id };
      },
      res(res: { statusCode: number }) {
        return { statusCode: res.statusCode };
      },
    },
  };

  if (config.isProduction) return base;
  if (config.isTest) return { ...base, level: 'silent' };

  return {
    ...base,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
    },
  };
}

/** Logger for code that runs outside a request (workers, migrations, boot). */
export const logger = pino(buildLoggerOptions());
