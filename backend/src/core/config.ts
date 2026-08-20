import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Parsed once at boot and exported as a frozen object. The process refuses to
 * start on an invalid environment — a misconfigured secret should be a loud
 * crash at deploy time, not a subtle auth bug at 2am.
 */

const bool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .default(defaultValue ? 'true' : 'false');

const secret = (name: string, min = 32) =>
  z
    .string({ required_error: `${name} is required` })
    .min(
      min,
      `${name} must be at least ${min} characters — generate one with \`openssl rand -base64 48\``,
    );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    TZ: z.string().default('Europe/Moscow'),

    // --- HTTP ---
    HOST: z.string().default('0.0.0.0'),
    BACKEND_PORT: z.coerce.number().int().positive().default(3000),
    /** Public origin the PWA is served from. Drives CORS, cookies and OAuth redirect URIs. */
    APP_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
    // `silent` is a real pino level and the honest choice for tests.
    LOG_LEVEL: z
      .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
    /** Comma-separated extra origins allowed by CORS (dev tooling, LAN testing). */
    CORS_EXTRA_ORIGINS: z.string().default(''),
    /**
     * Multiplies every rate limit. **Ignored in production**, where it is
     * forced to 1.
     *
     * Exists for automated end-to-end runs: the access token lives in memory
     * only, so each fresh browser context has to call `POST /auth/refresh`, and
     * a suite that opens ~90 contexts in under a minute trips the 60/minute cap
     * and goes red for a reason that has nothing to do with the code. A real
     * family generates roughly one refresh a minute, so the shipped limits are
     * not the problem — the harness is.
     */
    RATE_LIMIT_FACTOR: z.coerce.number().int().min(1).max(1000).default(1),

    // --- Data stores ---
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    REDIS_URL: z.string().url(),

    // --- Crypto / sessions ---
    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
    COOKIE_SECRET: secret('COOKIE_SECRET'),
    /** AES-256-GCM key (base64, 32 bytes) for provider tokens at rest. */
    ENCRYPTION_KEY: secret('ENCRYPTION_KEY', 32),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600), // 10 min
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    /** Concurrent-refresh grace window. See D3 — this is not optional. */
    REFRESH_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(20),

    // --- Web Push (VAPID) ---
    VAPID_PUBLIC_KEY: z.string().default(''),
    VAPID_PRIVATE_KEY: z.string().default(''),
    VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),

    // --- OAuth: Google ---
    GOOGLE_CLIENT_ID: z.string().default(''),
    GOOGLE_CLIENT_SECRET: z.string().default(''),

    // --- OAuth / bot: Telegram ---
    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_BOT_USERNAME: z.string().default(''),
    TELEGRAM_CLIENT_SECRET: z.string().default(''),

    // --- Object storage (S3-compatible; RustFS in the reference stack) ---
    /**
     * Base URL of the S3 API, e.g. `http://rustfs:9000`. Empty disables
     * storage entirely — the app still boots and uploads answer 503.
     */
    S3_ENDPOINT: z.string().default(''),
    /** RustFS ignores the region, but the SDK refuses to sign without one. */
    S3_REGION: z.string().default('us-east-1'),
    S3_ACCESS_KEY_ID: z.string().default(''),
    S3_SECRET_ACCESS_KEY: z.string().default(''),
    S3_BUCKET: z.string().default('family-media'),
    /**
     * Mandatory for every non-AWS implementation: virtual-hosted style would
     * resolve `family-media.rustfs` in DNS, which does not exist.
     */
    S3_FORCE_PATH_STYLE: bool(true),
    /** Hard server-side cap on an uploaded avatar, in bytes. */
    AVATAR_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(2 * 1024 * 1024),

    // --- Bootstrap ---
    /** The first user signing in with this email is auto-approved as `owner`. */
    BOOTSTRAP_OWNER_EMAIL: z.string().default(''),

    // --- Feature switches ---
    // Off unless asked for. The reference exposes no data, but a public
    // instance has no reason to advertise its whole surface.
    ENABLE_SWAGGER: bool(false),
    ENABLE_WORKERS: bool(true),
    RUN_MIGRATIONS_ON_BOOT: bool(false),
  })
  .transform((env) => {
    const publicUrl = new URL(env.APP_PUBLIC_URL);
    const extraOrigins = env.CORS_EXTRA_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      ...env,
      isProduction: env.NODE_ENV === 'production',
      /**
       * Never let a stray env var weaken production. The knob is a test
       * affordance; in production the shipped limits are the limits.
       */
      rateLimitFactor: env.NODE_ENV === 'production' ? 1 : env.RATE_LIMIT_FACTOR,
      isTest: env.NODE_ENV === 'test',
      isDevelopment: env.NODE_ENV === 'development',

      publicOrigin: publicUrl.origin,
      cookieDomain: publicUrl.hostname,
      /** `__Host-` cookies require Secure, which requires HTTPS. */
      useSecureCookies: publicUrl.protocol === 'https:',
      allowedOrigins: [publicUrl.origin, ...extraOrigins],

      oauth: {
        google: {
          enabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          redirectUri: `${publicUrl.origin}/api/auth/google/callback`,
        },
        telegram: {
          enabled: Boolean(env.TELEGRAM_BOT_TOKEN),
          botToken: env.TELEGRAM_BOT_TOKEN,
          botUsername: env.TELEGRAM_BOT_USERNAME,
          clientSecret: env.TELEGRAM_CLIENT_SECRET,
          /**
           * Telegram's OIDC `client_id` is the numeric bot id — the part of the
           * bot token before the colon.
           *
           * Matched rather than split: a value with no colon is not a bot token,
           * and `split(':')[0]` would hand back the whole string, which is the
           * secret. That secret would then travel as `client_id` in an
           * authorization URL — in a browser address bar, in access logs, in a
           * Referer header. An empty `botId` fails loudly in
           * `getTelegramConfiguration` instead.
           */
          botId: /^(\d+):/.exec(env.TELEGRAM_BOT_TOKEN)?.[1] ?? '',
          redirectUri: `${publicUrl.origin}/api/auth/telegram/callback`,
        },
      },

      push: {
        enabled: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
      },

      /**
       * Object storage, same shape as `oauth` and `push`: an `enabled` flag
       * plus the settings, so a deployment that has not configured RustFS
       * still boots and simply refuses uploads (503) instead of crashing at
       * startup. All four values are required — a half-configured client
       * fails at request time with an opaque signing error, which is a far
       * worse way to learn that `S3_SECRET_ACCESS_KEY` was never set.
       */
      storage: {
        enabled: Boolean(
          env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET,
        ),
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        bucket: env.S3_BUCKET,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        avatarMaxBytes: env.AVATAR_MAX_BYTES,
      },
    };
  });

export type Config = z.infer<typeof envSchema>;

let cached: Config | undefined;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}

/** The process-wide config. Lazily parsed so tests can call `loadConfig` directly. */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test helper — resets the memoized config. */
export function resetConfigForTests(): void {
  cached = undefined;
}
