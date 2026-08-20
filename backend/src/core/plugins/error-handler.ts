import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';

import type { ApiErrorBody, ErrorCode } from '@family/shared';

import { getConfig } from '../config.js';
import { AppError } from '../errors.js';

/**
 * The single place an error becomes an HTTP response.
 *
 * Every non-2xx body has the same shape (`ApiErrorBody`) so the client can
 * switch on `error.code` and render a Russian message from its own catalogue —
 * the English `message` here is for developers and logs only.
 */

function fieldErrorsFromZod(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

function respond(
  reply: FastifyReply,
  requestId: string,
  code: ErrorCode,
  status: number,
  message: string,
  details?: Record<string, string[]>,
): FastifyReply {
  const body: ApiErrorBody = {
    error: { code, message, ...(details ? { details } : {}), requestId },
  };
  return reply.code(status).send(body);
}

export const errorHandlerPlugin = fp(
  async (app: FastifyInstance) => {
    const config = getConfig();

    app.setNotFoundHandler(
      { preHandler: app.hasDecorator('rateLimit') ? undefined : undefined },
      (request, reply) =>
        respond(
          reply,
          request.id,
          'NOT_FOUND',
          404,
          `Route ${request.method} ${request.url} not found`,
        ),
    );

    app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
      /* ---------- request validation ---------- */
      if (hasZodFastifySchemaValidationErrors(error)) {
        const details: Record<string, string[]> = {};
        for (const issue of error.validation) {
          const key = issue.params.issue.path.join('.') || '_';
          (details[key] ??= []).push(issue.params.issue.message);
        }
        request.log.info({ details }, 'request validation failed');
        return respond(
          reply,
          request.id,
          'VALIDATION_ERROR',
          400,
          'Request validation failed',
          details,
        );
      }

      /* ---------- response serialization: always our bug ---------- */
      if (isResponseSerializationError(error)) {
        request.log.error(
          { err: error, method: error.method, url: error.url },
          'response does not match its schema',
        );
        return respond(reply, request.id, 'INTERNAL_ERROR', 500, 'Response serialization failed');
      }

      if (error instanceof ZodError) {
        return respond(
          reply,
          request.id,
          'VALIDATION_ERROR',
          400,
          'Validation failed',
          fieldErrorsFromZod(error),
        );
      }

      /* ---------- our own errors ---------- */
      if (AppError.isAppError(error)) {
        const logPayload = { err: error, code: error.code, context: error.context };
        if (error.statusCode >= 500) request.log.error(logPayload, error.message);
        else request.log.info(logPayload, error.message);
        return respond(
          reply,
          request.id,
          error.code,
          error.statusCode,
          error.message,
          error.details,
        );
      }

      /* ---------- fastify / framework errors ---------- */
      const fastifyError = error as { statusCode?: number; code?: string; message?: string };

      if (fastifyError.statusCode === 429) {
        return respond(reply, request.id, 'RATE_LIMITED', 429, 'Too many requests');
      }
      if (fastifyError.statusCode === 413) {
        return respond(reply, request.id, 'PAYLOAD_TOO_LARGE', 413, 'Payload too large');
      }
      if (fastifyError.statusCode === 415) {
        return respond(reply, request.id, 'UNSUPPORTED_MEDIA_TYPE', 415, 'Unsupported media type');
      }
      if (
        fastifyError.statusCode &&
        fastifyError.statusCode >= 400 &&
        fastifyError.statusCode < 500
      ) {
        return respond(
          reply,
          request.id,
          'BAD_REQUEST',
          fastifyError.statusCode,
          fastifyError.message ?? 'Bad request',
        );
      }

      /* ---------- anything else is a genuine 500 ---------- */
      request.log.error({ err: error }, 'unhandled error');
      return respond(
        reply,
        request.id,
        'INTERNAL_ERROR',
        500,
        config.isProduction
          ? 'Internal server error'
          : ((error as Error)?.message ?? 'Internal server error'),
      );
    });
  },
  { name: 'error-handler' },
);
