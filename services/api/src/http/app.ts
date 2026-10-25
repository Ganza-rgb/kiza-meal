import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { ApiErrorBody } from '@kiza/shared';
import type { Ctx } from '../context';
import { ApiError } from '../errors';
import { makeAuthHook } from './auth';
import { adminRoutes } from './routes/admin';
import { devRoutes } from './routes/dev';
import { publicRoutes } from './routes/public';
import { scanRoutes } from './routes/scan';
import { studentRoutes } from './routes/student';

export interface BuildOptions {
  logger?: boolean;
}

export async function buildApp(ctx: Ctx, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          level: 'info',
          // Never log credentials, tokens, QR payloads or photos.
          redact: ['req.headers.authorization', 'req.headers["x-kiza-device"]'],
          serializers: {
            req: (req) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }),
          },
        }
      : false,
    bodyLimit: 256 * 1024,
    trustProxy: false,
  });

  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: { code: 'rate_limited', message: `Too many attempts. Try again in ${context.after}.` },
    }),
  });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', makeAuthHook(ctx));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      const body: ApiErrorBody = { error: { code: err.code, message: err.message, details: err.details } };
      return reply.code(err.status).send(body);
    }
    const e = err as { statusCode?: number; code?: string; message?: string; error?: unknown };
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: e.message ?? 'Too many attempts' } });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: 'validation_failed', message: e.message ?? 'Bad request' } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Unexpected server error' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint' } }));

  publicRoutes(app, ctx);
  studentRoutes(app, ctx);
  scanRoutes(app, ctx);
  adminRoutes(app, ctx);
  if (ctx.config.devTools && !ctx.config.production) devRoutes(app, ctx);

  return app;
}
