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
        return { method: req.method, url: req.url, id: req.id };
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
