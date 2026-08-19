import formbody from '@fastify/formbody';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import underPressure from '@fastify/under-pressure';
import scalar from '@scalar/fastify-api-reference';
import { fastify, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';

import { getConfig } from './core/config.js';
import { pingDb } from './core/db.js';
import { buildLoggerOptions } from './core/logger.js';
import { authPlugin } from './core/plugins/auth.js';
import { errorHandlerPlugin } from './core/plugins/error-handler.js';
import { securityPlugin } from './core/plugins/security.js';
import { pingRedis } from './core/redis.js';

/**
 * Builds the Fastify instance.
 *
 * Kept separate from `main.ts` so tests can build an app, drive it with
 * `app.inject()` and tear it down without binding a port.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function sanitizeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

export async function buildApp(): Promise<FastifyInstance> {
  const config = getConfig();

  const app = fastify({
    loggerInstance: undefined,
    logger: buildLoggerOptions(),
    /**
     * Trust exactly one hop — the reverse proxy in front of us.
     *
     * `true` trusts the whole chain, which means `request.ip` becomes the
     * left-most `X-Forwarded-For` entry: a value the client writes. That
     * silently defeats every per-IP rate limit (an attacker just rotates the
     * header) and poisons `audit_log.ip`.
     */
    trustProxy: 1,
    // The inbound id is echoed in error bodies and written to every log line,
    // so it is constrained rather than trusted: an unbounded client-controlled
    // string is a log-injection primitive.
    genReqId: (req) => sanitizeRequestId(req.headers['x-request-id']) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
    disableRequestLogging: config.isTest,
    bodyLimit: 2 * 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
  }).withTypeProvider<ZodTypeProvider>();

  // Zod is the single source of truth for validation, serialization and OpenAPI.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  // Apple's Sign in with Apple callback is an application/x-www-form-urlencoded POST.
  await app.register(formbody);

  await app.register(securityPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  await app.register(underPressure, {
    maxEventLoopDelay: 2_000,
    maxHeapUsedBytes: 0,
    maxRssBytes: 0,
    retryAfter: 30,
    exposeStatusRoute: false,
  });

  if (config.ENABLE_SWAGGER) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Family API',
          description: 'Backend for the family application (tasks, calendar, moneybox, chores).',
          version: '0.1.0',
        },
        servers: [{ url: `${config.publicOrigin}/api` }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
        security: [{ bearerAuth: [] }],
      },
      transform: jsonSchemaTransform,
    });

    await app.register(scalar, {
      routePrefix: '/docs',
      configuration: { title: 'Family API', theme: 'purple' },
    });
  }

  /* ----------------------------- health probes ----------------------------- */

  app.get('/health', { config: { public: true }, schema: { hide: true } }, async () => ({
    status: 'ok',
    uptime: process.uptime(),
  }));

  app.get('/ready', { config: { public: true }, schema: { hide: true } }, async (_req, reply) => {
    const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
    const ready = db && redis;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', db, redis });
  });

  /* ------------------------------ API routes -------------------------------
   * Feature modules are registered here under the `/api` prefix by the module
   * registry in `src/modules/index.ts` as each one lands.
   * ------------------------------------------------------------------------- */
  const { registerModules } = await import('./modules/index.js');
  await app.register(registerModules, { prefix: '/api' });

  return app;
}
