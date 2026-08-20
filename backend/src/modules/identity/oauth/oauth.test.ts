import { createHash, createHmac } from 'node:crypto';

import cookie from '@fastify/cookie';
import { fastify, type RouteOptions } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { ResponseBodyError } from 'openid-client';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../core/errors.js';
import { errorHandlerPlugin } from '../../../core/plugins/error-handler.js';
import { googleProfileFromClaims } from './google.js';
import oauthRoutes from './oauth.routes.js';
import { decideLinkOutcome, sanitizeRawProfile, type LinkDecisionInput } from './linking.js';
import {
  buildDataCheckString,
  computeTelegramHash,
  isTelegramTokenEndpoint,
  normalizeTelegramTokenResponse,
  probeTelegramLoginDomain,
  telegramAuthorizationParams,
  telegramLoginOrigin,
  telegramMiniAppSecretKey,
  telegramProfileFromClaims,
  telegramRefusalReason,
  telegramTokenErrorHint,
  telegramTokenErrorIn,
  telegramTokenFailureFrom,
  telegramWidgetSecretKey,
  TELEGRAM_CLIENT_SECRET_FIX,
  TELEGRAM_SCOPES,
  verifyTelegramInitData,
  verifyTelegramWidget,
} from './telegram.js';
import {
  assertTransactionUsable,
  createMemoryOAuthTransactionStore,
  OAUTH_TRANSACTION_TTL_MS,
} from './transactions.js';

/**
 * Unit tests for the OAuth module. **No network, no database.**
 *
 * Everything here is either pure or driven by the in-memory transaction store,
 * so the suite runs in CI without Docker and without a single outbound socket.
 */

const BOT_TOKEN = '123456789:AAH-fake-bot-token-for-tests-only-0000000';

/* ========================================================================== */
/* Telegram — the two HMAC derivations                                        */
/* ========================================================================== */

describe('telegram data-check-string', () => {
  it('sorts by key, excludes `hash`, and joins with newlines', () => {
    const dcs = buildDataCheckString(
      [
        ['username', 'ivan'],
        ['id', '42'],
        ['hash', 'deadbeef'],
        ['auth_date', '1700000000'],
      ],
      ['hash'],
    );
    expect(dcs).toBe('auth_date=1700000000\nid=42\nusername=ivan');
  });

  it('also excludes `signature` for Mini App payloads', () => {
    const dcs = buildDataCheckString(
      [
        ['signature', 'abc'],
        ['hash', 'def'],
        ['query_id', 'q1'],
      ],
      ['hash', 'signature'],
    );
    expect(dcs).toBe('query_id=q1');
  });
});

describe('telegram Login Widget HMAC (legacy)', () => {
  /**
   * Widget: key = SHA256(bot_token) — a **plain digest**, not an HMAC.
   * Recomputed here from first principles rather than imported, so the test
   * would fail if the implementation quietly changed derivation.
   */
  const handComputed = (dcs: string) =>
    createHmac('sha256', createHash('sha256').update(BOT_TOKEN).digest()).update(dcs).digest('hex');

  const authDate = 1_700_000_000;
  const now = new Date(authDate * 1000 + 60_000);

  const basePayload = {
    id: 987654321,
    first_name: 'Иван',
    last_name: 'Петров',
    username: 'ivan',
    auth_date: authDate,
  };

  const signWidget = (payload: Record<string, unknown>) => {
    const entries = Object.entries(payload).map(
      ([k, v]) => [k, String(v)] as readonly [string, string],
    );
    return handComputed(buildDataCheckString(entries));
  };

  it('derives the secret key as a plain SHA-256 digest of the bot token', () => {
    expect(telegramWidgetSecretKey(BOT_TOKEN).toString('hex')).toBe(
      createHash('sha256').update(BOT_TOKEN).digest('hex'),
    );
  });

  it('accepts a payload signed against the hand-computed fixture', () => {
    const hash = signWidget(basePayload);
    const profile = verifyTelegramWidget({
      payload: { ...basePayload, hash },
      botToken: BOT_TOKEN,
      now,
    });

    expect(profile.provider).toBe('telegram');
    expect(profile.providerUserId).toBe('987654321');
    expect(profile.displayName).toBe('Иван Петров');
    expect(profile.username).toBe('ivan');
    // Telegram gives no email, ever — so it can never be email-linked.
    expect(profile.email).toBeNull();
    expect(profile.emailVerified).toBe(false);
  });

  it('rejects a tampered field', () => {
    const hash = signWidget(basePayload);
    expect(() =>
      verifyTelegramWidget({
        payload: { ...basePayload, first_name: 'Мария', hash },
        botToken: BOT_TOKEN,
        now,
      }),
    ).toThrowError(/signature is invalid/);
  });

  it('rejects a payload signed with the Mini App derivation (swapped scheme)', () => {
    // The classic mix-up: signing widget data with the WebAppData key.
    const entries = Object.entries(basePayload).map(
      ([k, v]) => [k, String(v)] as readonly [string, string],
    );
    const wrong = computeTelegramHash(
      telegramMiniAppSecretKey(BOT_TOKEN),
      buildDataCheckString(entries),
    );

    expect(() =>
      verifyTelegramWidget({ payload: { ...basePayload, hash: wrong }, botToken: BOT_TOKEN, now }),
    ).toThrowError(/signature is invalid/);
  });

  it('rejects a stale auth_date', () => {
    const hash = signWidget(basePayload);
    const muchLater = new Date((authDate + 86_400 + 60) * 1000);
    expect(() =>
      verifyTelegramWidget({
        payload: { ...basePayload, hash },
        botToken: BOT_TOKEN,
        now: muchLater,
      }),
    ).toThrowError(/too old/);
  });

  it('rejects an auth_date from the future', () => {
    const hash = signWidget(basePayload);
    const earlier = new Date((authDate - 3600) * 1000);
    expect(() =>
      verifyTelegramWidget({
        payload: { ...basePayload, hash },
        botToken: BOT_TOKEN,
        now: earlier,
      }),
    ).toThrowError(/in the future/);
  });
});

describe('telegram Mini App initData HMAC', () => {
  /**
   * Mini App: key = HMAC_SHA256(key="WebAppData", message=bot_token).
   * Telegram documents it as `HMAC_SHA256(<bot_token>, "WebAppData")` —
   * **message first, key second** — which is the #1 source of the bug.
   */
  const handComputed = (dcs: string) =>
    createHmac('sha256', createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest())
      .update(dcs)
      .digest('hex');

  const authDate = 1_700_000_000;
  const now = new Date(authDate * 1000 + 5_000);
  const user = JSON.stringify({
    id: 555000111,
    first_name: 'Аня',
    username: 'anya',
    language_code: 'ru',
  });

  const fields: [string, string][] = [
    ['auth_date', String(authDate)],
    ['query_id', 'AAF_test'],
    ['user', user],
  ];

  const buildInitData = (hash: string, extra: [string, string][] = []) => {
    const params = new URLSearchParams([...fields, ...extra]);
    params.set('hash', hash);
    return params.toString();
  };

  it('derives the secret key with "WebAppData" as the KEY and the bot token as the MESSAGE', () => {
    expect(telegramMiniAppSecretKey(BOT_TOKEN).toString('hex')).toBe(
      createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest('hex'),
    );
  });

  it('is NOT the same as the swapped derivation', () => {
    const swapped = createHmac('sha256', BOT_TOKEN).update('WebAppData').digest('hex');
    expect(telegramMiniAppSecretKey(BOT_TOKEN).toString('hex')).not.toBe(swapped);
  });

  it('accepts initData signed against the hand-computed fixture', () => {
    const hash = handComputed(buildDataCheckString(fields));
    const profile = verifyTelegramInitData({
      initData: buildInitData(hash),
      botToken: BOT_TOKEN,
      now,
    });

    expect(profile.providerUserId).toBe('555000111');
    expect(profile.username).toBe('anya');
    expect(profile.displayName).toBe('Аня');
    expect(profile.email).toBeNull();
  });

  it('rejects initData whose hash was built with the operands swapped', () => {
    // key = bot_token, message = "WebAppData" — the wrong way round.
    const swappedKey = createHmac('sha256', BOT_TOKEN).update('WebAppData').digest();
    const wrong = computeTelegramHash(swappedKey, buildDataCheckString(fields));

    expect(() =>
      verifyTelegramInitData({ initData: buildInitData(wrong), botToken: BOT_TOKEN, now }),
    ).toThrowError(/signature is invalid/);
  });

  it('rejects initData signed with the Login Widget derivation', () => {
    const wrong = computeTelegramHash(
      telegramWidgetSecretKey(BOT_TOKEN),
      buildDataCheckString(fields),
    );
    expect(() =>
      verifyTelegramInitData({ initData: buildInitData(wrong), botToken: BOT_TOKEN, now }),
    ).toThrowError(/signature is invalid/);
  });

  it('excludes `signature` from the data-check-string', () => {
    // A genuine payload carries `signature`; including it would break the hash.
    const hash = handComputed(buildDataCheckString(fields));
    const profile = verifyTelegramInitData({
      initData: buildInitData(hash, [['signature', 'ed25519-thing']]),
      botToken: BOT_TOKEN,
      now,
    });
    expect(profile.providerUserId).toBe('555000111');
  });

  it('enforces auth_date freshness', () => {
    const hash = handComputed(buildDataCheckString(fields));
    expect(() =>
      verifyTelegramInitData({
        initData: buildInitData(hash),
        botToken: BOT_TOKEN,
        now: new Date((authDate + 86_401) * 1000),
      }),
    ).toThrowError(/too old/);
  });

  it('honours a tighter custom max age', () => {
    const hash = handComputed(buildDataCheckString(fields));
    expect(() =>
      verifyTelegramInitData({
        initData: buildInitData(hash),
        botToken: BOT_TOKEN,
        now: new Date((authDate + 120) * 1000),
        maxAgeSeconds: 60,
      }),
    ).toThrowError(/too old/);
  });
});

/* ========================================================================== */
/* Telegram — one human, one identity, across all three flows                 */
/* ========================================================================== */

/**
 * The regression lock for the `sub`-versus-`id` trap.
 *
 * Telegram's `id_token` carries **both** `sub` (the OIDC subject, returned by
 * the `openid` scope) and `id` (the numeric Telegram user id, returned by
 * `profile`) — two claims behind two different scopes, holding two different
 * values. Telegram's own worked example pairs `"sub": "1234123412341234123"`
 * with `"id": 987654321`.
 *
 * The Login Widget and Mini App fallbacks have only `id` to work with. So if
 * the OIDC path ever keys off `sub` again, one family member signing in through
 * both routes gets **two** `user_identities` rows — and because registration is
 * admin-gated, their second sign-in shows up as a stranger awaiting approval.
 *
 * These tests fail the moment any one flow drifts off `id`.
 */
describe('telegram identity key parity', () => {
  const TELEGRAM_USER_ID = 987_654_321;
  /** Deliberately unequal to the user id, exactly as Telegram's docs show it. */
  const OIDC_SUBJECT = '1234123412341234123';
  const authDate = 1_700_000_000;
  const now = new Date(authDate * 1000 + 5_000);

  /** The documented id_token payload, minus the claims we do not read. */
  const oidcProfile = () =>
    telegramProfileFromClaims({
      iss: 'https://oauth.telegram.org',
      aud: '123456789',
      sub: OIDC_SUBJECT,
      iat: authDate,
      exp: authDate + 3600,
      id: TELEGRAM_USER_ID,
      name: 'Иван Петров',
      given_name: 'Иван',
      family_name: 'Петров',
      preferred_username: 'ivan',
      picture: 'https://cdn4.telesco.pe/file/avatar.jpg',
    });

  const widgetProfile = () => {
    const payload: Record<string, string> = {
      id: String(TELEGRAM_USER_ID),
      first_name: 'Иван',
      last_name: 'Петров',
      username: 'ivan',
      auth_date: String(authDate),
    };
    const hash = computeTelegramHash(
      telegramWidgetSecretKey(BOT_TOKEN),
      buildDataCheckString(Object.entries(payload)),
    );
    return verifyTelegramWidget({ payload: { ...payload, hash }, botToken: BOT_TOKEN, now });
  };

  const miniAppProfile = () => {
    const fields: [string, string][] = [
      ['auth_date', String(authDate)],
      [
        'user',
        JSON.stringify({
          id: TELEGRAM_USER_ID,
          first_name: 'Иван',
          last_name: 'Петров',
          username: 'ivan',
        }),
      ],
    ];
    const hash = computeTelegramHash(
      telegramMiniAppSecretKey(BOT_TOKEN),
      buildDataCheckString(fields),
    );
    const params = new URLSearchParams(fields);
    params.set('hash', hash);
    return verifyTelegramInitData({ initData: params.toString(), botToken: BOT_TOKEN, now });
  };

  it('resolves OIDC, widget and Mini App to one and the same providerUserId', () => {
    const expected = String(TELEGRAM_USER_ID);
    expect(oidcProfile().providerUserId).toBe(expected);
    expect(widgetProfile().providerUserId).toBe(expected);
    expect(miniAppProfile().providerUserId).toBe(expected);
  });

  it('keys the OIDC flow on `id`, never on `sub`', () => {
    expect(oidcProfile().providerUserId).not.toBe(OIDC_SUBJECT);
  });

  it('normalizes the numeric `id` claim to the string the fallbacks produce', () => {
    // `id` is a JSON number over OIDC and a string everywhere else. Leaving it
    // un-normalized would split the identity just as effectively as reading the
    // wrong claim, and `text` columns compare exactly.
    expect(typeof oidcProfile().providerUserId).toBe('string');
    expect(oidcProfile().providerUserId).toBe(widgetProfile().providerUserId);
  });

  it('keeps `sub` in raw_profile — it is worth logging, just not a join key', () => {
    expect(oidcProfile().rawProfile).toMatchObject({ sub: OIDC_SUBJECT, flow: 'oidc' });
  });

  it('refuses an id_token with no `id` claim instead of falling back to `sub`', () => {
    // Silently substituting `sub` here is what would mint the duplicate
    // identity, so a missing `profile` scope has to be fatal and loud.
    expect(() =>
      telegramProfileFromClaims({ iss: 'https://oauth.telegram.org', sub: OIDC_SUBJECT }),
    ).toThrowError(/`profile` scope/);
  });
});

/* ========================================================================== */
/* Google                                                                     */
/* ========================================================================== */

describe('google claim mapping', () => {
  it('keys the identity on `sub`, never on `email`', () => {
    const profile = googleProfileFromClaims(
      {
        sub: '110169484474386276334',
        nonce: 'n-1',
        email: 'somebody@example.com',
        email_verified: true,
        name: 'Somebody',
        picture: 'https://lh3.googleusercontent.com/a/x',
      },
      'n-1',
    );
    expect(profile.providerUserId).toBe('110169484474386276334');
    expect(profile.providerUserId).not.toBe(profile.email);
    expect(profile.emailVerified).toBe(true);
  });

  it('rejects a mismatched or absent nonce', () => {
    expect(() => googleProfileFromClaims({ sub: 's', nonce: 'other' }, 'n-1')).toThrowError(
      /nonce does not match/,
    );
    expect(() => googleProfileFromClaims({ sub: 's' }, 'n-1')).toThrowError(/nonce does not match/);
  });

  it('rejects a token with no subject', () => {
    expect(() => googleProfileFromClaims({ nonce: 'n-1' }, 'n-1')).toThrowError(/no subject/);
  });
});

/* ========================================================================== */
/* raw_profile sanitisation                                                   */
/* ========================================================================== */

describe('sanitizeRawProfile', () => {
  it('strips every credential-shaped key', () => {
    const out = sanitizeRawProfile({
      iss: 'https://accounts.google.com',
      access_token: 'ya29.secret',
      refresh_token: 'r.secret',
      id_token: 'ey.secret',
      code: 'abc',
      client_secret: 'shh',
      hash: 'deadbeef',
      signature: 'sig',
      locale: 'ru',
      dropped: undefined,
    });
    expect(out).toEqual({ iss: 'https://accounts.google.com', locale: 'ru' });
  });
});

/* ========================================================================== */
/* linking decision table                                                     */
/* ========================================================================== */

describe('decideLinkOutcome', () => {
  const base: LinkDecisionInput = {
    intent: 'login',
    sessionUserId: null,
    profile: {
      provider: 'google',
      providerUserId: 'sub-123',
      email: 'ivan@example.com',
      emailVerified: true,
    },
    existingIdentity: null,
    sessionUserProviderIdentity: null,
    emailOwnerUserId: null,
    registrationAllowed: true,
    bootstrapOwnerEmail: null,
  };

  it('logs in a known (provider, sub) and never consults email', () => {
    const decision = decideLinkOutcome({
      ...base,
      existingIdentity: { id: 'identity-1', userId: 'user-1' },
      // Deliberately contradictory: a different user owns this email. Irrelevant.
      emailOwnerUserId: 'someone-else',
    });
    expect(decision).toEqual({ kind: 'login', userId: 'user-1', identityId: 'identity-1' });
  });

  it('logs in a known subject even when the provider dropped the email entirely', () => {
    const decision = decideLinkOutcome({
      ...base,
      profile: { ...base.profile, email: null, emailVerified: false },
      existingIdentity: { id: 'identity-1', userId: 'user-1' },
    });
    expect(decision.kind).toBe('login');
  });

  it('attaches a new subject to the authenticated user on intent=link', () => {
    const decision = decideLinkOutcome({
      ...base,
      intent: 'link',
      sessionUserId: 'user-1',
    });
    expect(decision).toEqual({ kind: 'attach', userId: 'user-1' });
  });

  it('409s when the subject already belongs to a different user', () => {
    const decision = decideLinkOutcome({
      ...base,
      intent: 'link',
      sessionUserId: 'user-1',
      existingIdentity: { id: 'identity-9', userId: 'user-9' },
    });
    expect(decision).toEqual({ kind: 'conflict', reason: 'identity_owned_by_another_user' });
  });

  it('409s when the user already has an identity for this provider', () => {
    const decision = decideLinkOutcome({
      ...base,
      intent: 'link',
      sessionUserId: 'user-1',
      sessionUserProviderIdentity: { id: 'identity-existing' },
    });
    expect(decision).toEqual({ kind: 'conflict', reason: 'provider_already_linked' });
  });

  it('treats re-linking the same account as an idempotent login', () => {
    const decision = decideLinkOutcome({
      ...base,
      intent: 'link',
      sessionUserId: 'user-1',
      existingIdentity: { id: 'identity-1', userId: 'user-1' },
    });
    expect(decision).toEqual({ kind: 'login', userId: 'user-1', identityId: 'identity-1' });
  });

  it('rejects intent=link without a session', () => {
    const decision = decideLinkOutcome({ ...base, intent: 'link', sessionUserId: null });
    expect(decision).toEqual({ kind: 'conflict', reason: 'link_requires_session' });
  });

  it('creates a pending_approval user for an unknown subject', () => {
    const decision = decideLinkOutcome(base);
    expect(decision).toEqual({ kind: 'create', asOwner: false });
  });

  it('NEVER auto-links on an email match, even when both sides are verified', () => {
    const decision = decideLinkOutcome({
      ...base,
      profile: { ...base.profile, emailVerified: true },
      emailOwnerUserId: 'user-7',
    });
    // The whole point: not `{ kind: 'login', userId: 'user-7' }`.
    expect(decision).toEqual({ kind: 'conflict', reason: 'email_belongs_to_existing_user' });
  });

  it('never email-links a Telegram identity (it has no email at all)', () => {
    const decision = decideLinkOutcome({
      ...base,
      profile: {
        provider: 'telegram',
        providerUserId: '987654321',
        email: null,
        emailVerified: false,
      },
      emailOwnerUserId: 'user-7',
    });
    expect(decision).toEqual({ kind: 'create', asOwner: false });
  });

  it('refuses to register anyone when registration is closed', () => {
    const decision = decideLinkOutcome({ ...base, registrationAllowed: false });
    expect(decision).toEqual({ kind: 'reject', reason: 'registration_closed' });
  });

  it('auto-approves the bootstrap owner, case-insensitively', () => {
    const decision = decideLinkOutcome({ ...base, bootstrapOwnerEmail: 'IVAN@Example.com ' });
    expect(decision).toEqual({ kind: 'create', asOwner: true });
  });
});

/* ========================================================================== */
/* OAuth transaction store                                                    */
/* ========================================================================== */

describe('oauth transaction store', () => {
  it('round-trips everything the callback needs', async () => {
    const store = createMemoryOAuthTransactionStore();
    const state = await store.create({
      provider: 'google',
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
      intent: 'link',
      linkUserId: 'user-1',
      redirectAfter: '/settings/identities',
    });

    const row = await store.consume(state, 'google');
    expect(row).toMatchObject({
      state,
      provider: 'google',
      nonce: 'nonce-1',
      codeVerifier: 'verifier-1',
      intent: 'link',
      linkUserId: 'user-1',
      redirectAfter: '/settings/identities',
    });
  });

  it('defaults intent to login and leaves the PKCE verifier null when unset', async () => {
    const store = createMemoryOAuthTransactionStore();
    const state = await store.create({ provider: 'telegram', nonce: 'n' });
    const row = await store.consume(state, 'telegram');
    expect(row.intent).toBe('login');
    expect(row.codeVerifier).toBeNull();
  });

  it('is consume-once: the second redemption fails', async () => {
    const store = createMemoryOAuthTransactionStore();
    const state = await store.create({ provider: 'google', nonce: 'n', codeVerifier: 'v' });

    await expect(store.consume(state, 'google')).resolves.toBeDefined();
    await expect(store.consume(state, 'google')).rejects.toThrowError(
      /unknown or has already been used/,
    );
  });

  it('cannot tell a forged state apart from a spent one', async () => {
    const store = createMemoryOAuthTransactionStore();
    await expect(store.consume('never-existed', 'google')).rejects.toThrowError(
      /unknown or has already been used/,
    );
  });

  it('burns the row even when the provider does not match', async () => {
    const store = createMemoryOAuthTransactionStore();
    const state = await store.create({ provider: 'google', nonce: 'n' });

    await expect(store.consume(state, 'telegram')).rejects.toThrowError(/does not belong/);
    // A cross-provider probe must not leave the state usable.
    await expect(store.consume(state, 'google')).rejects.toThrowError(
      /unknown or has already been used/,
    );
  });

  it('still accepts a row one second inside the 10-minute TTL', async () => {
    let now = new Date('2026-08-19T10:00:00.000Z');
    const store = createMemoryOAuthTransactionStore(() => now);
    const state = await store.create({ provider: 'google', nonce: 'n' });

    now = new Date(now.getTime() + OAUTH_TRANSACTION_TTL_MS - 1_000);
    await expect(store.consume(state, 'google')).resolves.toBeDefined();
  });

  it('expires at exactly the TTL boundary', async () => {
    let now = new Date('2026-08-19T10:00:00.000Z');
    const store = createMemoryOAuthTransactionStore(() => now);
    const state = await store.create({ provider: 'google', nonce: 'n' });

    now = new Date(now.getTime() + OAUTH_TRANSACTION_TTL_MS);
    await expect(store.consume(state, 'google')).rejects.toThrowError(/expired/);
  });

  it('sweeps expired rows', async () => {
    let now = new Date('2026-08-19T10:00:00.000Z');
    const store = createMemoryOAuthTransactionStore(() => now);
    await store.create({ provider: 'google', nonce: 'a' });
    await store.create({ provider: 'telegram', nonce: 'b' });

    now = new Date(now.getTime() + OAUTH_TRANSACTION_TTL_MS + 1_000);
    await expect(store.sweep()).resolves.toBe(2);
  });

  it('applies the same policy when the row is handed in directly', () => {
    const row = {
      state: 's',
      provider: 'google' as const,
      nonce: 'n',
      codeVerifier: null,
      intent: 'login' as const,
      linkUserId: null,
      redirectAfter: null,
      expiresAt: new Date('2026-08-19T10:10:00.000Z'),
    };

    expect(assertTransactionUsable(row, 'google', new Date('2026-08-19T10:09:59.000Z'))).toBe(row);
    expect(() =>
      assertTransactionUsable(row, 'google', new Date('2026-08-19T10:10:00.000Z')),
    ).toThrowError(AppError);
    expect(() => assertTransactionUsable(undefined, 'google')).toThrowError(AppError);
  });
});

/* ========================================================================== */
/* Telegram - the login origin and the BotFather domain                       */
/* ========================================================================== */

/**
 * These exist because of a production outage that showed as «Bot domain
 * invalid» on Telegram's own page: a bare plain-text 200 that our callback
 * never sees, so no server log and no Russian message could ever be produced
 * from it. Everything below is the part we can assert without a network.
 */
describe('telegram login origin', () => {
  it('is the bare origin of APP_PUBLIC_URL - no trailing slash, no path', () => {
    expect(telegramLoginOrigin('https://nezo.su')).toBe('https://nezo.su');
    expect(telegramLoginOrigin('https://nezo.su/')).toBe('https://nezo.su');
    expect(telegramLoginOrigin('https://nezo.su/app/?next=/x#frag')).toBe('https://nezo.su');
  });

  it('lower-cases the host and drops the default port', () => {
    // Telegram compares the string literally against the registered domain.
    expect(telegramLoginOrigin('https://NEZO.SU')).toBe('https://nezo.su');
    expect(telegramLoginOrigin('https://nezo.su:443')).toBe('https://nezo.su');
  });

  it('keeps a non-default port and never rewrites the host', () => {
    expect(telegramLoginOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    // `www.` is a real difference from `cookieDomain`'s point of view, so it is
    // APP_PUBLIC_URL that must be fixed - not silently patched here.
    expect(telegramLoginOrigin('https://www.nezo.su')).toBe('https://www.nezo.su');
  });

  it('refuses a non-http(s) or malformed APP_PUBLIC_URL', () => {
    expect(() => telegramLoginOrigin('ftp://nezo.su')).toThrowError(AppError);
    expect(() => telegramLoginOrigin('nezo.su')).toThrowError(AppError);
  });

  it('defaults to the configured public origin', () => {
    expect(telegramLoginOrigin()).toBe(new URL(process.env.APP_PUBLIC_URL ?? '').origin);
  });
});

describe('telegram authorization parameters', () => {
  const params = telegramAuthorizationParams({
    state: 'st',
    nonce: 'no',
    codeChallenge: 'cc',
    redirectUri: 'https://nezo.su/api/auth/telegram/callback',
    origin: telegramLoginOrigin('https://nezo.su/'),
  });

  it('sends `origin` as the exact public origin', () => {
    // The single most common cause of «Bot domain invalid» after the domain
    // itself: a trailing slash, a path, or http where the bot expects https.
    expect(params.origin).toBe('https://nezo.su');
    expect(params.origin?.endsWith('/')).toBe(false);
    expect(new URL(params.origin ?? '').protocol).toBe('https:');
  });

  it('derives redirect_uri from the same origin it sends', () => {
    expect(new URL(params.redirect_uri ?? '').origin).toBe(params.origin);
    expect(new URL(params.redirect_uri ?? '').pathname).toBe('/api/auth/telegram/callback');
  });

  it('is a PKCE code flow carrying the bot_access scope', () => {
    expect(params.response_type).toBe('code');
    expect(params.code_challenge_method).toBe('S256');
    expect(params.code_challenge).toBe('cc');
    expect(params.state).toBe('st');
    expect(params.nonce).toBe('no');
    expect(params.scope).toBe(TELEGRAM_SCOPES);
    expect(TELEGRAM_SCOPES).toContain('telegram:bot_access');
  });
});

describe('telegram refusal detection', () => {
  it('recognises the bare plain-text refusals, case-insensitively', () => {
    expect(telegramRefusalReason('Bot domain invalid')).toBe('bot domain invalid');
    expect(telegramRefusalReason('  ORIGIN REQUIRED\n')).toBe('origin required');
    expect(telegramRefusalReason('bot_id required')).toBe('bot_id required');
  });

  it('does not mistake the real widget page for a refusal', () => {
    expect(telegramRefusalReason('<!DOCTYPE html><html><body>Telegram</body></html>')).toBeNull();
    expect(telegramRefusalReason('')).toBeNull();
  });
});

describe('telegram login domain probe', () => {
  const reply = (body: string) =>
    (() => Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

  it('asks Telegram with the origin and bot id we would really send', async () => {
    let seen = '';
    const spy = ((url: URL) => {
      seen = url.href;
      return Promise.resolve(new Response('<!DOCTYPE html>', { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await probeTelegramLoginDomain({
      botId: '8936828934',
      origin: 'https://nezo.su',
      fetchImpl: spy,
    });

    const asked = new URL(seen);
    expect(asked.origin).toBe('https://oauth.telegram.org');
    expect(asked.pathname).toBe('/auth');
    expect(asked.searchParams.get('bot_id')).toBe('8936828934');
    expect(asked.searchParams.get('origin')).toBe('https://nezo.su');
    expect(result.ok).toBe(true);
    expect(result.indeterminate).toBe(false);
  });

  it("reports Telegram's own words when the domain is not registered", async () => {
    const result = await probeTelegramLoginDomain({
      botId: '8936828934',
      origin: 'https://nezo.su',
      fetchImpl: reply('Bot domain invalid'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bot domain invalid');
    // The two facts a diagnosis needs, carried on the result itself.
    expect(result.origin).toBe('https://nezo.su');
    expect(result.botId).toBe('8936828934');
  });

  it('never blocks a login because the probe itself failed', async () => {
    const dead = (() => Promise.reject(new Error('ENOTFOUND'))) as unknown as typeof fetch;
    const result = await probeTelegramLoginDomain({
      botId: '8936828934',
      origin: 'https://nezo.su',
      fetchImpl: dead,
    });
    // Unreachable proves nothing - refusing to start sign-in would be a worse
    // outage than the one the check exists to catch.
    expect(result.ok).toBe(true);
    expect(result.indeterminate).toBe(true);
  });
});

/* ========================================================================== */
/* Telegram — token endpoint client authentication                            */
/* ========================================================================== */

describe('telegram token endpoint errors', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

  it('finds an OAuth error object in a response body', () => {
    expect(telegramTokenErrorIn({ error: 'invalid_client' })).toEqual({
      error: 'invalid_client',
      description: null,
    });
    expect(
      telegramTokenErrorIn({ error: 'invalid_grant', error_description: 'code expired' }),
    ).toEqual({ error: 'invalid_grant', description: 'code expired' });
  });

  it('never reads a successful token response as a failure', () => {
    expect(telegramTokenErrorIn({ access_token: 'a', token_type: 'Bearer' })).toBeNull();
    expect(telegramTokenErrorIn({})).toBeNull();
    expect(telegramTokenErrorIn(null)).toBeNull();
    expect(telegramTokenErrorIn('invalid_client')).toBeNull();
    // A body that somehow carries both is a success — the token is what matters.
    expect(telegramTokenErrorIn({ access_token: 'a', error: 'invalid_client' })).toBeNull();
  });

  /**
   * The whole reason this machinery exists: Telegram rejects a token request
   * with HTTP 200, which `oauth4webapi` does not treat as an error response at
   * all. Left alone it surfaces as «"response" body "access_token" property must
   * be a string», which names neither Telegram nor the client secret.
   */
  it("rewrites Telegram's HTTP 200 rejection to the status RFC 6749 requires", async () => {
    const normalized = await normalizeTelegramTokenResponse(json({ error: 'invalid_client' }));
    expect(normalized.status).toBe(400);
    await expect(normalized.json()).resolves.toEqual({ error: 'invalid_client' });
  });

  it('leaves a genuine token response alone', async () => {
    const normalized = await normalizeTelegramTokenResponse(
      json({ access_token: 'a', token_type: 'Bearer', id_token: 'jwt' }),
    );
    expect(normalized.status).toBe(200);
    await expect(normalized.json()).resolves.toMatchObject({ access_token: 'a' });
  });

  it('passes through non-JSON and non-200 responses untouched', async () => {
    const html = new Response('<!DOCTYPE html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    expect(await normalizeTelegramTokenResponse(html)).toBe(html);

    const already400 = json({ error: 'invalid_client' }, 400);
    expect(await normalizeTelegramTokenResponse(already400)).toBe(already400);
  });

  it('normalizes only the token endpoint, not discovery or JWKS', () => {
    expect(isTelegramTokenEndpoint('https://oauth.telegram.org/token')).toBe(true);
    expect(isTelegramTokenEndpoint('https://oauth.telegram.org/auth')).toBe(false);
    expect(isTelegramTokenEndpoint('https://oauth.telegram.org/.well-known/jwks.json')).toBe(false);
    // A look-alike host must not get its responses rewritten.
    expect(isTelegramTokenEndpoint('https://oauth.telegram.org.evil.test/token')).toBe(false);
    expect(isTelegramTokenEndpoint('not a url')).toBe(false);
  });

  it("unwraps the library error back into Telegram's own words", () => {
    const err = new ResponseBodyError('server responded with an error in the response body', {
      cause: { error: 'invalid_client', error_description: 'client authentication failed' },
      response: new Response('{}', { status: 400 }),
    });
    expect(telegramTokenFailureFrom(err)).toEqual({
      error: 'invalid_client',
      description: 'client authentication failed',
    });
    expect(telegramTokenFailureFrom(new Error('boom'))).toBeNull();
  });

  /**
   * `invalid_client` is the only symptom of a missing or wrong
   * `TELEGRAM_CLIENT_SECRET`, and the single most likely wrong guess is the bot
   * token — every other Telegram flow in this module keys off it. The hint has
   * to rule that out explicitly or it does not help anyone.
   */
  it('explains invalid_client in terms of where the secret comes from', () => {
    const hint = telegramTokenErrorHint('invalid_client');
    expect(hint).toBeTruthy();
    expect(hint).toContain('TELEGRAM_CLIENT_SECRET');
    expect(hint).toContain('BotFather');
    expect(hint).toContain('NOT the bot token');
    expect(telegramTokenErrorHint('something_new')).toBeNull();
  });

  it('does not offer the bot token as a client secret anywhere', () => {
    // A guard against a future "helpful" derivation: the client secret is
    // issued by BotFather and is not computable from anything we hold.
    expect(TELEGRAM_CLIENT_SECRET_FIX).toContain('BotFather');
    expect(TELEGRAM_CLIENT_SECRET_FIX).toContain('Login Widget');
  });
});

/* ========================================================================== */
/* route wiring                                                               */
/* ========================================================================== */

/**
 * Registration-level assertions only — no provider is configured in the test
 * environment, so every one of these requests is answered before anything
 * reaches the network or the database.
 */
describe('oauth route plugin', () => {
  const buildTestApp = async () => {
    const routes: RouteOptions[] = [];
    const app = fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addHook('onRoute', (route) => {
      routes.push(route);
    });
    // Decorators normally supplied by the auth plugin, which needs Redis.
    app.decorateRequest('auth', null);
    app.decorateRequest('scope', null);
    await app.register(cookie);
    await app.register(errorHandlerPlugin);
    await app.register(oauthRoutes, { prefix: '/api' });
    await app.ready();
    return { app, routes };
  };

  const configOf = (routes: RouteOptions[], method: string, url: string) => {
    const route = routes.find((r) => r.url === url && r.method === method);
    expect(route, `${method} ${url} is not registered`).toBeDefined();
    return (route?.config ?? {}) as {
      public?: boolean;
      allowCrossSite?: boolean;
      permission?: string;
    };
  };

  it('registers every documented route under /api', async () => {
    const { app, routes } = await buildTestApp();
    // Fastify mirrors every GET as a HEAD; the boot assertion ignores those too.
    const registered = routes
      .map((r) => `${String(r.method)} ${r.url}`)
      .filter((r) => !r.startsWith('HEAD '))
      .sort();
    expect(registered).toEqual([
      'GET /api/auth/:provider/link',
      'GET /api/auth/:provider/start',
      'GET /api/auth/google/callback',
      'GET /api/auth/telegram/callback',
      'POST /api/auth/telegram/miniapp',
      'POST /api/auth/telegram/widget',
    ]);
    await app.close();
  });

  it('declares an access mode on every route (deny by default)', async () => {
    const { app, routes } = await buildTestApp();
    for (const route of routes) {
      const cfg = (route.config ?? {}) as { public?: boolean; permission?: string };
      expect(
        cfg.public === true || typeof cfg.permission === 'string',
        `${String(route.method)} ${route.url} declares no access mode`,
      ).toBe(true);
    }
    await app.close();
  });

  it('exempts the cross-site provider POSTs from the Sec-Fetch-Site check', async () => {
    const { app, routes } = await buildTestApp();
    // The Telegram fallbacks post from Telegram's own origin; without the
    // opt-out the security plugin rejects them in production only.
    expect(configOf(routes, 'POST', '/api/auth/telegram/widget').allowCrossSite).toBe(true);
    expect(configOf(routes, 'POST', '/api/auth/telegram/miniapp').allowCrossSite).toBe(true);
    // The GET callbacks are top-level navigations, so they need no exemption.
    expect(configOf(routes, 'GET', '/api/auth/google/callback').allowCrossSite).toBeUndefined();
    await app.close();
  });

  it('requires identity:manage:own to start a link flow', async () => {
    const { app, routes } = await buildTestApp();
    expect(configOf(routes, 'GET', '/api/auth/:provider/link').permission).toBe(
      'identity:manage:own',
    );
    await app.close();
  });

  it('sends a browser back to the login screen when a provider is unavailable', async () => {
    const { app } = await buildTestApp();

    // `/start` is a top-level navigation: a JSON error envelope in the address
    // bar is unreadable, English, and offers no way back into the app.
    const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' });
    expect(start.statusCode).toBe(302);
    const location = new URL(start.headers.location as string);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('error')).toBe('SERVICE_UNAVAILABLE');
    // Named, so the screen can say *which* provider is out rather than blaming
    // sign-in as a whole.
    expect(location.searchParams.get('provider')).toBe('google');

    // The callback is not a screen anybody can reach on purpose, and stays JSON.
    // Reaches no database: the provider check runs before the state lookup.
    const callback = await app.inject({
      method: 'GET',
      url: '/api/auth/google/callback?code=abc&state=whatever',
    });
    expect(callback.statusCode).toBe(503);

    await app.close();
  });

  it('keeps a caller mistake a JSON 4xx rather than an outage screen', async () => {
    const { app } = await buildTestApp();
    // A bad request is not a provider outage and must not be disguised as one.
    const res = await app.inject({ method: 'GET', url: '/api/auth/google/start?intent=link' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an unknown provider with a validation error, not a crash', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/facebook/start' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('refuses intent=link on the unauthenticated /start route', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/google/start?intent=link' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
    await app.close();
  });
});
