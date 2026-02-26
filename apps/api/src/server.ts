import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { registerHealthRoutes } from './routes/health.js';
import { registerDocsRoutes } from './routes/docs.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerIssueRoutes } from './routes/issues.js';
import { createDb } from './db.js';
import { createPgStore } from './store/pg.js';
import { createCommunityAccessController } from './auth/communityAccess.js';

export async function buildServer(): Promise<FastifyInstance> {
  const accessControl = createCommunityAccessController();
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  // Request logging
  server.addHook('onRequest', async (request) => {
    request.log.info({ method: request.method, url: request.url }, 'incoming request');
  });

  server.addHook('onResponse', async (request, reply) => {
    request.log.info(
      { method: request.method, url: request.url, statusCode: reply.statusCode, responseTime: reply.elapsedTime },
      'request completed'
    );
  });

  await server.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',') ?? true,
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
  });

  server.addHook('onRequest', async (request, reply) => {
    const decision = await accessControl.authorize({
      method: request.method,
      url: request.url,
      authorizationHeader: request.headers.authorization,
    });

    if (!decision.allowed) {
      return reply.code(decision.statusCode).send({ message: decision.message });
    }

    if (decision.login) {
      (request as any).viewer = {
        login: decision.login,
        source: decision.source,
      };
    }
  });

  const db = createDb();
  const store = createPgStore(db);
  server.addHook('onClose', async () => {
    await db.pool.end();
  });

  registerHealthRoutes(server);
  await registerDocsRoutes(server);
  registerAuthRoutes(server, accessControl);
  registerSessionRoutes(server, store);
  registerIssueRoutes(server, store);

  return server;
}
