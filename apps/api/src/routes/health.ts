import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(server: FastifyInstance) {
  server.get('/healthz', async () => ({ ok: true }));
}

