import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { getConfig } from '../config.js';
import { AppError } from '../errors.js';
import { getRedis } from '../redis.js';

/**
 * Transport-level security: CORS, headers, cookies, rate limiting and the
 * cross-site request check that backs up `SameSite=Lax` (D3).
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const securityPlugin = fp(
  async (app: FastifyInstance) => {
    const config = getConfig();

    await app.register(cookie, {
      secret: config.COOKIE_SECRET,
      parseOptions: { sameSite: 'lax', httpOnly: true, path: '/' },
    });

    await app.register(helmet, {
      // The API serves JSON and the OpenAPI reference; the PWA itself is served
      // by Caddy, which owns the app's CSP.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      // NOT `same-origin` — that breaks the Telegram login popup.
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      hsts: config.useSecureCookies
        ? { maxAge: 15_552_000, includeSubDomains: true, preload: false }
        : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    });

    await app.register(cors, {
      origin: (origin, cb) => {
        // Same-origin requests and non-browser clients send no Origin header.
        if (!origin) return cb(null, true);
        cb(null, config.allowedOrigins.includes(origin));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      maxAge: 86_400,
    });

    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      // Shared across replicas, and survives a restart.
      redis: getRedis(),
      nameSpace: 'rl:',
      keyGenerator: (request: FastifyRequest) => request.auth?.userId ?? request.ip,
      // Auth endpoints get their own much tighter limit, declared per route.
      allowList: () => false,
    });

    /**
     * CSRF defence in depth.
     *
     * `SameSite=Lax` already withholds the refresh cookie from cross-site POSTs,
     * and every other endpoint authenticates with an in-memory bearer token
     * (structurally CSRF-immune). This hook closes the remaining gap and makes
     * the guarantee explicit rather than incidental.
     *
     * OAuth callbacks legitimately arrive cross-site (Apple `form_post`), so
     * they opt out with `config: { allowCrossSite: true }`.
     */
    app.addHook('onRequest', async (request) => {
      if (SAFE_METHODS.has(request.method)) return;
      const routeConfig = request.routeOptions.config as { allowCrossSite?: boolean } | undefined;
      if (routeConfig?.allowCrossSite) return;

      const fetchSite = request.headers['sec-fetch-site'];
      if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        throw new AppError('FORBIDDEN', 'Cross-site request blocked');
      }

      const origin = request.headers.origin;
      if (origin && !config.allowedOrigins.includes(origin)) {
        throw new AppError('FORBIDDEN', 'Origin not allowed');
      }
    });
  },
  { name: 'security' },
);
