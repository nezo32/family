/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /**
   * Absolute origin of the API, e.g. `https://family.example.com`.
   * Empty string in dev — requests go to `/api/...` and Vite proxies them, which
   * keeps `__Host-rt` a same-origin cookie.
   */
  readonly VITE_API_URL: string;
  /** VAPID application server public key (base64url), for Web Push subscribe. */
  readonly VITE_VAPID_PUBLIC_KEY: string;
  /** Telegram bot username without the leading `@`, used by the login widget. */
  readonly VITE_TELEGRAM_BOT_USERNAME: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * The `version` field of `frontend/package.json`, inlined at build time by the
 * `define` in `vite.config.ts` (and mirrored in `vitest.config.ts`).
 *
 * Rendered at the bottom of `/settings` — «какая у вас версия?» is the first
 * question any support conversation asks, and an installed PWA gives the user
 * no other way to answer it.
 */
declare const __APP_VERSION__: string;
