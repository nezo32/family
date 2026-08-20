import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getConfig, resetConfigForTests } from '../../../core/config.js';
import { hasTestDb } from '../../../test/db.js';
import { closeHarness, resetDatabase, startHarness, type Harness } from '../../../test/harness.js';
import { createOAuthTransactionStore } from './transactions.js';

/**
 * What a browser is shown when the OAuth callback runs twice.
 *
 * This is the failure the owner actually hit: linking Telegram from Настройки
 * produced two `GET /api/auth/telegram/callback` requests for one
 * authorization. The first redeemed the one-time `state`, attached the identity
 * and issued the session; the second found the state already spent, answered
 * `400 BAD_REQUEST`, and — because the callback is a **top-level navigation** —
 * that JSON envelope is what landed in the address bar:
 *
 * ```
 * {"error":{"code":"BAD_REQUEST","message":"OAuth state is unknown or has
 *  already been used","requestId":"dd7ef045-…"}}
 * ```
 *
 * English, developer-facing, no way back into the app, and shown to somebody
 * whose link had just worked. The duplicate itself is fixed in
 * `frontend/src/sw.ts`; this suite pins the surface, because a callback that can
 * only be reached by a browser must never render an API error body no matter
 * what goes wrong behind it.
 *
 * Needs a database because the replay guard *is* the `DELETE … RETURNING` — a
 * spent state is one the row is gone for, which nothing but Postgres can say.
 * The first callback is simulated by consuming the row through the store rather
 * than by injecting a request: a real first callback would exchange the code
 * against `oauth.telegram.org`, and this suite opens no sockets.
 */
describe.skipIf(!hasTestDb)('oauth callback surface (integration)', () => {
  let h: Harness;
  const previousBotToken = process.env.TELEGRAM_BOT_TOKEN;

  beforeAll(async () => {
    // `config.oauth.telegram.enabled` is just "is a bot token configured"; the
    // callback refuses before touching the database without one, and this suite
    // is about what happens *after* that check. No network follows: every
    // request below dies on the state lookup.
    process.env.TELEGRAM_BOT_TOKEN = '123456789:AAH-fake-bot-token-for-tests-only-0000000';
    resetConfigForTests();
    h = await startHarness();
  });

  afterAll(async () => {
    await closeHarness();
    if (previousBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousBotToken;
    resetConfigForTests();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  /** Mint a real transaction and spend it, exactly as a first callback would. */
  const spentState = async (intent: 'login' | 'link') => {
    const store = createOAuthTransactionStore(h.db);
    const state = await store.create({
      provider: 'telegram',
      nonce: 'nonce-for-the-first-callback',
      codeVerifier: 'verifier-for-the-first-callback',
      intent,
      redirectAfter: intent === 'link' ? '/settings/accounts' : null,
    });
    await store.consume(state, 'telegram');
    return state;
  };

  const callback = (state: string) =>
    h.app.inject({
      method: 'GET',
      url: `/api/auth/telegram/callback?code=duplicate-code&state=${encodeURIComponent(state)}`,
    });

  it('sends a replayed link callback to Способы входа, not to an error envelope', async () => {
    const response = await callback(await spentState('link'));

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin).toBe(getConfig().publicOrigin);
    expect(location.pathname).toBe('/settings/accounts');

    // Neutral, not `?error=`: the screen it lands on can read the truth off
    // `GET /me/identities` instead of being told a guess.
    expect(location.searchParams.get('oauth')).toBe('replayed');
    expect(location.searchParams.get('provider')).toBe('telegram');
    expect(location.searchParams.get('error')).toBeNull();

    // The bug, stated as an assertion.
    expect(response.body).not.toContain('BAD_REQUEST');
    expect(response.body).not.toContain('OAuth state');
  });

  it('sends a replayed login callback to the sign-in screen', async () => {
    const response = await callback(await spentState('login'));

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('oauth')).toBe('replayed');
    expect(location.searchParams.get('error')).toBeNull();
    expect(response.body).not.toContain('BAD_REQUEST');
  });

  /**
   * A state that never existed is the same observation as a spent one — that is
   * what delete-on-read buys (D3) — so it gets the same neutral landing. It is
   * not a session: whoever sent it arrives at a screen behind the auth guard
   * with nothing attached.
   */
  it('treats a forged state exactly like a spent one, and issues nothing', async () => {
    const response = await callback('k.a-state-nobody-ever-minted');

    expect(response.statusCode).toBe(302);
    expect(new URL(response.headers.location as string).searchParams.get('oauth')).toBe('replayed');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  /**
   * An expired state is a different story from a duplicate: nothing succeeded,
   * and the user has to start again. It stays an error — just not a JSON one.
   */
  it('keeps a real failure a real failure, on a page instead of in JSON', async () => {
    const store = createOAuthTransactionStore(h.db, () => new Date(Date.now() - 60 * 60 * 1000));
    const state = await store.create({ provider: 'telegram', nonce: 'n', intent: 'link' });

    const response = await callback(state);

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.pathname).toBe('/settings/accounts');
    expect(location.searchParams.get('error')).toBe('BAD_REQUEST');
    expect(location.searchParams.get('oauth')).toBeNull();
    expect(response.body).not.toContain('requestId');
  });
});
