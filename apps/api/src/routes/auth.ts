import type { FastifyInstance } from 'fastify';

export function registerAuthRoutes(server: FastifyInstance) {
  server.get('/auth/me', async (req, reply) => {
    const viewer = (req as any).viewer as
      | { login: string; source: 'community-md' | 'extra-allowlist' | 'access-control-disabled' }
      | undefined;

    if (!viewer?.login) {
      return reply.code(401).send({ message: 'Unauthorized' });
    }

    return {
      login: viewer.login,
      source: viewer.source,
    };
  });
}

