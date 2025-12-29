import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { registerHealthRoutes } from './routes/health.js';
import { registerDocsRoutes } from './routes/docs.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { createDb } from './db.js';
import { createPgStore } from './store/pg.js';

export async function buildServer(): Promise<FastifyInstance> {
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
  });

  const db = createDb();
  const store = createPgStore(db);
  server.addHook('onClose', async () => {
    await db.pool.end();
  });

  registerHealthRoutes(server);
  await registerDocsRoutes(server);
  registerSessionRoutes(server, store);

  return server;
}
