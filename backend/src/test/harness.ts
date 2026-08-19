import { randomUUID } from 'node:crypto';

import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

import type { Role } from '@family/shared';

import type { Db } from '../core/db.js';
import { getTestDb, truncateAll } from './db.js';

/**
 * Integration harness: one real Fastify app, one real database.
 *
 * Everything here drives the app through `app.inject()` so the request goes
 * through the *real* stack — security plugin, deny-by-default auth hook, Zod
 * validation, the error handler and the serializer. A test that calls a service
 * function directly cannot catch a missing route guard, a schema that strips a
 * field, or a 403 that should have been a 404; those are exactly the failures
 * this file exists to find.
 *
 * `src/test/db.ts` has already pointed `DATABASE_URL` at the test database at
 * import time, so `getDb()` inside the app and `getTestDb()` here are the same
 * pool.
 */

export interface TestUser {
  id: string;
  email: string;
  password: string;
  displayName: string;
  role: Role;
  accessToken: string;
  /** The raw refresh token, as it would sit in the cookie. */
  refreshToken: string;
  familyId: string;
}

export interface Harness {
  app: FastifyInstance;
  db: Db;
  close(): Promise<void>;
}

let cachedApp: FastifyInstance | undefined;

/**
 * Build the app once per worker.
 *
 * Vitest runs this suite in a single fork (`poolOptions.forks.singleFork`), and
 * `buildApp()` registers rate limiters and an under-pressure watchdog — building
 * one per test file would leak timers and make the run flaky rather than
 * isolated. State isolation comes from `truncateAll()`, not from a fresh app.
 */
export async function getApp(): Promise<FastifyInstance> {
  if (!cachedApp) {
    const { buildApp } = await import('../app.js');
    cachedApp = await buildApp();
    await cachedApp.ready();
  }
  return cachedApp;
}

export async function startHarness(): Promise<Harness> {
  const db = await getTestDb();
  const app = await getApp();
  return {
    app,
    db,
    close: async () => {
      /* the app is shared for the whole run; `closeHarness` tears it down */
    },
  };
}

export async function closeHarness(): Promise<void> {
  if (cachedApp) {
    await cachedApp.close();
    cachedApp = undefined;
  }
}

/**
 * Wipe every table **and** the rate-limit counters.
 *
 * `core/plugins/security.ts` keeps `@fastify/rate-limit` state in Redis under
 * `rl:`, which survives a database truncate and a process restart. Without this
 * the second run of the suite would start with the first run's counters and the
 * registration limit (5 per hour) would reject fixtures — a rerun that fails is
 * not an isolated test.
 */
export async function resetDatabase(): Promise<void> {
  await truncateAll();
  await clearRateLimits();
}

export async function clearRateLimits(): Promise<void> {
  const { getRedis } = await import('../core/redis.js');
  const redis = getRedis();
  const keys = await redis.keys('rl:*');
  if (keys.length > 0) await redis.del(...keys);
}

/**
 * A distinct client address per fixture user.
 *
 * `buildApp()` sets `trustProxy: true`, so `X-Forwarded-For` becomes
 * `request.ip` and therefore the rate-limit key. Registration allows five
 * attempts per hour per address; a suite that creates six members from one
 * address would fail on the sixth for reasons that have nothing to do with what
 * it is testing.
 */
let addressCounter = 0;
export function nextClientAddress(): string {
  addressCounter += 1;
  return `10.${(addressCounter >> 16) & 0xff}.${(addressCounter >> 8) & 0xff}.${addressCounter & 0xff}`;
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

export interface AsOptions {
  /** Bearer token. Omit for an anonymous request. */
  token?: string | null;
  /** Raw refresh token to present as the refresh cookie. */
  refreshToken?: string | null;
}

export async function request(
  app: FastifyInstance,
  options: InjectOptions & AsOptions,
): Promise<LightMyRequestResponse> {
  const { token, refreshToken, headers, cookies, ...rest } = options;

  const { refreshCookieName } = await import('../core/auth/tokens.js');

  return app.inject({
    ...rest,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    cookies: {
      ...(refreshToken ? { [refreshCookieName()]: refreshToken } : {}),
      ...cookies,
    },
  });
}

/** `response.json()` typed, with a readable failure when the status is wrong. */
export function expectStatus(response: LightMyRequestResponse, expected: number): void {
  if (response.statusCode !== expected) {
    throw new Error(
      `expected ${expected}, got ${response.statusCode}: ${response.body.slice(0, 800)}`,
    );
  }
}

export function errorCode(response: LightMyRequestResponse): string | undefined {
  try {
    return (response.json() as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

/** The refresh cookie the response set, or `undefined` when it set none. */
export async function refreshCookieOf(
  response: LightMyRequestResponse,
): Promise<{ value: string } | undefined> {
  const { refreshCookieName } = await import('../core/auth/tokens.js');
  const name = refreshCookieName();
  const cookie = response.cookies.find((c) => c.name === name);
  return cookie ? { value: cookie.value } : undefined;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Register through the real `POST /auth/register` route.
 *
 * The **first** user registered against an empty database is the bootstrap
 * owner and is the only one who receives a session; everybody else lands in
 * `pending_approval` with no session at all, which is the invariant the
 * registration tests assert.
 */
export async function registerUser(
  app: FastifyInstance,
  input: { email?: string; password?: string; displayName?: string } = {},
): Promise<{
  response: LightMyRequestResponse;
  email: string;
  password: string;
  displayName: string;
}> {
  const email = input.email ?? `u-${randomUUID()}@example.test`;
  const password = input.password ?? 'Correct-horse-battery-9';
  const displayName = input.displayName ?? 'Тестовый участник';

  const response = await request(app, {
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': nextClientAddress() },
    payload: { email, password, displayName },
  });

  return { response, email, password, displayName };
}

export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  const response = await request(app, {
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': nextClientAddress() },
    payload: { email, password },
  });
  expectStatus(response, 200);

  const body = response.json() as { accessToken: string; user: { id: string } };
  const cookie = await refreshCookieOf(response);
  if (!cookie) throw new Error('login set no refresh cookie');

  return { accessToken: body.accessToken, refreshToken: cookie.value, userId: body.user.id };
}

/**
 * Create the bootstrap owner.
 *
 * Registration against an empty family auto-approves the first account as
 * `owner` — otherwise nobody could ever approve anybody. Every other fixture
 * user is created by registering and then having this owner approve them, so
 * the tests exercise the real approval path rather than writing rows behind it.
 */
export async function createOwner(app: FastifyInstance): Promise<TestUser> {
  const { response, email, password, displayName } = await registerUser(app, {
    displayName: 'Владелец',
  });
  expectStatus(response, 200);

  const body = response.json() as {
    session: { accessToken: string; user: { id: string; role: Role } } | null;
  };
  if (!body.session) {
    throw new Error('the first registration must receive a session — is the database empty?');
  }
  const cookie = await refreshCookieOf(response);
  if (!cookie) throw new Error('bootstrap registration set no refresh cookie');

  return {
    id: body.session.user.id,
    email,
    password,
    displayName,
    role: body.session.user.role,
    accessToken: body.session.accessToken,
    refreshToken: cookie.value,
    familyId: '',
  };
}

/**
 * Register a member and have `approver` approve them at `role`, then log in.
 *
 * Goes through `POST /auth/register` → `POST /members/:id/approve` →
 * `POST /auth/login`, i.e. exactly what a real member does.
 */
export async function createMember(
  app: FastifyInstance,
  approver: TestUser,
  role: Role,
  input: { displayName?: string; choreWeight?: number } = {},
): Promise<TestUser> {
  const { response, email, password, displayName } = await registerUser(app, {
    displayName: input.displayName ?? `Участник ${role}`,
  });
  expectStatus(response, 200);

  const pending = response.json() as { pending: { ticket: string } | null };
  if (!pending.pending) throw new Error('a non-bootstrap registration must not receive a session');

  const list = await request(app, {
    method: 'GET',
    url: '/api/members/pending',
    token: approver.accessToken,
  });
  expectStatus(list, 200);
  const items = (list.json() as { items: { id: string; displayName: string }[] }).items;
  const target = items.find((m) => m.displayName === displayName);
  if (!target) throw new Error(`registered member ${displayName} is not pending`);

  const approve = await request(app, {
    method: 'POST',
    url: `/api/members/${target.id}/approve`,
    token: approver.accessToken,
    payload: { role, ...(input.choreWeight === undefined ? {} : { choreWeight: input.choreWeight }) },
  });
  expectStatus(approve, 200);

  const session = await login(app, email, password);

  return {
    id: session.userId,
    email,
    password,
    displayName,
    role,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    familyId: '',
  };
}

/** Look up the id of the one pending member with this display name. */
export async function pendingIdOf(
  app: FastifyInstance,
  approver: TestUser,
  displayName: string,
): Promise<string> {
  const list = await request(app, {
    method: 'GET',
    url: '/api/members/pending',
    token: approver.accessToken,
  });
  expectStatus(list, 200);
  const items = (list.json() as { items: { id: string; displayName: string }[] }).items;
  const found = items.find((m) => m.displayName === displayName);
  if (!found) throw new Error(`no pending member named ${displayName}`);
  return found.id;
}
