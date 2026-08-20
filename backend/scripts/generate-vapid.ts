/**
 * Generates a VAPID key pair for Web Push.
 *
 *   pnpm --filter @family/backend run gen:vapid
 *
 * Run once per deployment and paste the output into `.env`. Rotating these keys
 * invalidates every existing push subscription — every family member would have
 * to re-enable notifications from an installed PWA, which on iOS needs a fresh
 * user gesture. Treat the private key as a long-lived secret.
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

const subject = process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com';

console.log(
  [
    '',
    'VAPID key pair generated. Add these to your .env:',
    '',
    `VAPID_PUBLIC_KEY=${publicKey}`,
    `VAPID_PRIVATE_KEY=${privateKey}`,
    `VAPID_SUBJECT=${subject}`,
    '',
    'And expose the public key to the PWA build:',
    '',
    `VITE_VAPID_PUBLIC_KEY=${publicKey}`,
    '',
    'Note: VAPID_SUBJECT must be a real, resolvable mailto: address or https:// URL.',
    'Apple rejects anything else with 403 {"reason":"BadJwtToken"} — a subject like',
    'mailto:admin@localhost will silently break push on every iPhone in the family.',
    '',
  ].join('\n'),
);
