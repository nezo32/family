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
    .min(min, `${name} must be at least ${min} characters — generate one with \`openssl rand -base64 48\``);

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

    // --- OAuth: Apple ---
    APPLE_CLIENT_ID: z.string().default(''),
    APPLE_TEAM_ID: z.string().default(''),
    APPLE_KEY_ID: z.string().default(''),
    /** Base64 of the AuthKey_XXXX.p8 file. */
    APPLE_PRIVATE_KEY_BASE64: z.string().default(''),

    // --- OAuth / bot: Telegram ---
    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_BOT_USERNAME: z.string().default(''),
    TELEGRAM_CLIENT_SECRET: z.string().default(''),

    // --- Bootstrap ---
    /** The first user signing in with this email is auto-approved as `owner`. */
    BOOTSTRAP_OWNER_EMAIL: z.string().default(''),

    // --- Feature switches ---
    ENABLE_SWAGGER: bool(true),
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
        apple: {
          enabled: Boolean(
            env.APPLE_CLIENT_ID &&
              env.APPLE_TEAM_ID &&
              env.APPLE_KEY_ID &&
              env.APPLE_PRIVATE_KEY_BASE64,
          ),
          clientId: env.APPLE_CLIENT_ID,
          teamId: env.APPLE_TEAM_ID,
          keyId: env.APPLE_KEY_ID,
          privateKeyPem: env.APPLE_PRIVATE_KEY_BASE64
            ? Buffer.from(env.APPLE_PRIVATE_KEY_BASE64, 'base64').toString('utf8')
            : '',
          redirectUri: `${publicUrl.origin}/api/auth/apple/callback`,
        },
        telegram: {
          enabled: Boolean(env.TELEGRAM_BOT_TOKEN),
          botToken: env.TELEGRAM_BOT_TOKEN,
          botUsername: env.TELEGRAM_BOT_USERNAME,
          clientSecret: env.TELEGRAM_CLIENT_SECRET,
          /** Telegram's OIDC client_id is the numeric bot id, i.e. the token prefix. */
          botId: env.TELEGRAM_BOT_TOKEN.split(':')[0] ?? '',
          redirectUri: `${publicUrl.origin}/api/auth/telegram/callback`,
        },
      },

      push: {
        enabled: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
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
