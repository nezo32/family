import { createHash, createHmac } from 'node:crypto';

import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { fastify, type RouteOptions } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../core/errors.js';
import { errorHandlerPlugin } from '../../../core/plugins/error-handler.js';
import {
  APPLE_MAX_CLIENT_SECRET_LIFETIME_SECONDS,
  appleProfileFromClaims,
  coerceAppleBoolean,
  parseAppleUserField,
  signAppleClientSecret,
} from './apple.js';
import { googleProfileFromClaims } from './google.js';
import oauthRoutes from './oauth.routes.js';
import { decideLinkOutcome, sanitizeRawProfile, type LinkDecisionInput } from './linking.js';
import {
  buildDataCheckString,
  computeTelegramHash,
  telegramMiniAppSecretKey,
  telegramWidgetSecretKey,
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
    createHmac('sha256', createHash('sha256').update(BOT_TOKEN).digest())
      .update(dcs)
      .digest('hex');

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
      verifyTelegramWidget({ payload: { ...basePayload, hash }, botToken: BOT_TOKEN, now: muchLater }),
    ).toThrowError(/too old/);
  });

  it('rejects an auth_date from the future', () => {
    const hash = signWidget(basePayload);
    const earlier = new Date((authDate - 3600) * 1000);
    expect(() =>
      verifyTelegramWidget({ payload: { ...basePayload, hash }, botToken: BOT_TOKEN, now: earlier }),
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
/* Apple                                                                      */
/* ========================================================================== */

describe('apple string-or-boolean coercion', () => {
  it('accepts real booleans', () => {
    expect(coerceAppleBoolean(true)).toBe(true);
    expect(coerceAppleBoolean(false)).toBe(false);
  });

  it('accepts the string forms Apple also sends', () => {
    expect(coerceAppleBoolean('true')).toBe(true);
    expect(coerceAppleBoolean('True')).toBe(true);
    // The dangerous one: a naive truthiness check turns this into `true`.
    expect(coerceAppleBoolean('false')).toBe(false);
  });

  it('treats anything else as false', () => {
    expect(coerceAppleBoolean(undefined)).toBe(false);
    expect(coerceAppleBoolean(null)).toBe(false);
    expect(coerceAppleBoolean(1)).toBe(false);
    expect(coerceAppleBoolean('yes')).toBe(false);
  });

  it('applies the coercion to id_token claims', () => {
    const stringy = appleProfileFromClaims(
      {
        sub: '001122.abc.3344',
        nonce: 'n-1',
        email: 'zzz@privaterelay.appleid.com',
        email_verified: 'true',
        is_private_email: 'true',
      },
      'n-1',
    );
    expect(stringy.emailVerified).toBe(true);
    expect(stringy.isPrivateEmail).toBe(true);

    const booleany = appleProfileFromClaims(
      {
        sub: '001122.abc.3344',
        nonce: 'n-1',
        email: 'real@example.com',
        email_verified: true,
        is_private_email: false,
      },
      'n-1',
    );
    expect(booleany.emailVerified).toBe(true);
    expect(booleany.isPrivateEmail).toBe(false);

    const stringFalse = appleProfileFromClaims(
      { sub: 's', nonce: 'n-1', email_verified: 'false', is_private_email: 'false' },
      'n-1',
    );
    expect(stringFalse.emailVerified).toBe(false);
    expect(stringFalse.isPrivateEmail).toBe(false);
  });

  it('rejects an id_token whose nonce does not match', () => {
    expect(() => appleProfileFromClaims({ sub: 's', nonce: 'other' }, 'n-1')).toThrowError(
      /nonce does not match/,
    );
  });
});

describe('apple `user` field (first authorization only, unsigned)', () => {
  it('parses the name into a display name', () => {
    const parsed = parseAppleUserField(
      JSON.stringify({ name: { firstName: 'Иван', lastName: 'Петров' }, email: 'a@b.com' }),
    );
    expect(parsed.displayName).toBe('Иван Петров');
    expect(parsed.email).toBe('a@b.com');
  });

  it('survives a missing, empty or malformed field without failing the login', () => {
    expect(parseAppleUserField(undefined)).toEqual({ displayName: null, email: null });
    expect(parseAppleUserField('')).toEqual({ displayName: null, email: null });
    expect(parseAppleUserField('{not json')).toEqual({ displayName: null, email: null });
    expect(parseAppleUserField('{"name":{}}')).toEqual({ displayName: null, email: null });
  });

  it('never lets the unsigned field override the verified email', () => {
    const profile = appleProfileFromClaims(
      { sub: 'apple-sub', nonce: 'n', email: 'verified@example.com', email_verified: 'true' },
      'n',
      parseAppleUserField(JSON.stringify({ email: 'attacker@evil.example' })),
    );
    expect(profile.email).toBe('verified@example.com');
    // The name is the only thing taken from the unsigned blob.
    expect(profile.displayName).toBeNull();
  });
});

describe('apple client secret JWT', () => {
  const params = {
    teamId: 'TEAM123456',
    clientId: 'com.example.family.web',
    keyId: 'KEY7654321',
  };

  const withKey = async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    return exportPKCS8(privateKey);
  };

  it('signs ES256 with `kid` in the header and Apple’s claim layout', async () => {
    const privateKeyPem = await withKey();
    const now = new Date('2026-08-19T10:00:00.000Z');

    const { token, expiresAt } = await signAppleClientSecret({ privateKeyPem, ...params, now });

    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('ES256');
    // `kid` lives in the header, not the claims — Apple cannot pick the key otherwise.
    expect(header.kid).toBe('KEY7654321');

    const claims = decodeJwt(token);
    expect(claims.iss).toBe('TEAM123456'); // Team ID
    expect(claims.sub).toBe('com.example.family.web'); // Services ID
    expect(claims.aud).toBe('https://appleid.apple.com');

    const issuedAt = Math.floor(now.getTime() / 1000);
    expect(claims.iat).toBe(issuedAt);
    expect(claims.exp).toBe(expiresAt);
    expect(expiresAt - issuedAt).toBe(30 * 60);
    // Apple's hard cap. Exceed it and the token endpoint returns invalid_client.
    expect(expiresAt - issuedAt).toBeLessThanOrEqual(APPLE_MAX_CLIENT_SECRET_LIFETIME_SECONDS);
  });

  it('refuses a lifetime beyond Apple’s cap', async () => {
    const privateKeyPem = await withKey();
    await expect(
      signAppleClientSecret({
        privateKeyPem,
        ...params,
        lifetimeSeconds: APPLE_MAX_CLIENT_SECRET_LIFETIME_SECONDS + 1,
      }),
    ).rejects.toThrowError(/lifetime must be between/);
  });

  it('rejects a key that is not a PKCS#8 PEM', async () => {
    await expect(
      signAppleClientSecret({ privateKeyPem: 'not-a-key', ...params }),
    ).rejects.toBeInstanceOf(AppError);
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
      isPrivateEmail: false,
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

  it('never treats an Apple private-relay address as link-eligible', () => {
    const decision = decideLinkOutcome({
      ...base,
      profile: {
        provider: 'apple',
        providerUserId: 'apple-sub',
        email: 'xyz@privaterelay.appleid.com',
        emailVerified: true,
        isPrivateEmail: true,
      },
      emailOwnerUserId: 'user-7',
    });
    // A relay address is not an identity, so it cannot even produce a conflict.
    expect(decision).toEqual({ kind: 'create', asOwner: false });
  });

  it('never email-links a Telegram identity (it has no email at all)', () => {
    const decision = decideLinkOutcome({
      ...base,
      profile: {
        provider: 'telegram',
        providerUserId: '987654321',
        email: null,
        emailVerified: false,
        isPrivateEmail: false,
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

  it('does not grant ownership to a relay address that happens to match', () => {
    const decision = decideLinkOutcome({
      ...base,
      profile: { ...base.profile, isPrivateEmail: true },
      bootstrapOwnerEmail: 'ivan@example.com',
    });
    expect(decision).toEqual({ kind: 'create', asOwner: false });
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

  it('defaults intent to login and leaves the PKCE verifier null (Apple)', async () => {
    const store = createMemoryOAuthTransactionStore();
    const state = await store.create({ provider: 'apple', nonce: 'n' });
    const row = await store.consume(state, 'apple');
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

    await expect(store.consume(state, 'apple')).rejects.toThrowError(/does not belong/);
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
    await store.create({ provider: 'apple', nonce: 'b' });

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
    await app.register(formbody);
    await app.register(errorHandlerPlugin);
    await app.register(oauthRoutes, { prefix: '/api' });
    await app.ready();
    return { app, routes };
  };

  const configOf = (routes: RouteOptions[], method: string, url: string) => {
    const route = routes.find((r) => r.url === url && r.method === method);
    expect(route, `${method} ${url} is not registered`).toBeDefined();
    return (route?.config ?? {}) as { public?: boolean; allowCrossSite?: boolean; permission?: string };
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
      'POST /api/auth/apple/callback',
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
    // Apple posts this form from appleid.apple.com; without the opt-out the
    // security plugin rejects the callback in production only.
    expect(configOf(routes, 'POST', '/api/auth/apple/callback').allowCrossSite).toBe(true);
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

  it('answers 503 for a provider with no credentials configured', async () => {
    const { app } = await buildTestApp();

    const start = await app.inject({ method: 'GET', url: '/api/auth/google/start' });
    expect(start.statusCode).toBe(503);
    expect(start.json<{ error: { code: string } }>().error.code).toBe('SERVICE_UNAVAILABLE');

    // Reaches no database: the provider check runs before the state lookup.
    const apple = await app.inject({
      method: 'POST',
      url: '/api/auth/apple/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'code=abc&state=whatever',
    });
    expect(apple.statusCode).toBe(503);

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
