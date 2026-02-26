import type { FastifyInstance } from 'fastify';
import type { CommunityAccessController, ViewerSource } from '../auth/communityAccess.js';

function deriveApiOrigin(req: any): string {
  const rawProto =
    (typeof req.headers?.['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto']
      : undefined) ?? 'https';
  const rawHost =
    (typeof req.headers?.['x-forwarded-host'] === 'string'
      ? req.headers['x-forwarded-host']
      : undefined) ??
    (typeof req.headers?.host === 'string' ? req.headers.host : undefined);

  const proto = rawProto.split(',')[0]?.trim() || 'https';
  const host = rawHost?.split(',')[0]?.trim() || '';
  if (!host) {
    throw new Error('Unable to resolve API host for OAuth callback URL');
  }
  return `${proto}://${host}`;
}

export function registerAuthRoutes(server: FastifyInstance, accessControl: CommunityAccessController) {
  server.get('/auth/github/start', async (req, reply) => {
    const query = (req.query ?? {}) as { returnTo?: string };
    const returnToPath = query.returnTo;

    try {
      const apiOrigin = deriveApiOrigin(req);
      const { redirectUrl } = accessControl.beginGithubOAuth({ apiOrigin, returnToPath });
      return reply.redirect(redirectUrl, 302);
    } catch (err: any) {
      req.log.error({ err }, 'GitHub OAuth start failed');
      try {
        const fallback = accessControl.buildFrontendRedirect({
          returnToPath,
          error: err?.message ?? 'Unable to start GitHub login',
        });
        return reply.redirect(fallback, 302);
      } catch {
        return reply.code(503).send({ message: err?.message ?? 'Unable to start GitHub login' });
      }
    }
  });

  server.get('/auth/github/callback', async (req, reply) => {
    const query = (req.query ?? {}) as { code?: string; state?: string };
    const code = query.code?.trim();
    const state = query.state?.trim();

    if (!code || !state) {
      try {
        const fallback = accessControl.buildFrontendRedirect({
          error: 'Missing OAuth code or state',
        });
        return reply.redirect(fallback, 302);
      } catch {
        return reply.code(400).send({ message: 'Missing OAuth code or state' });
      }
    }

    try {
      const apiOrigin = deriveApiOrigin(req);
      const result = await accessControl.completeGithubOAuth({
        apiOrigin,
        code,
        state,
      });

      const redirectUrl = accessControl.buildFrontendRedirect({
        returnToPath: result.returnToPath,
        sessionToken: result.sessionToken,
      });
      return reply.redirect(redirectUrl, 302);
    } catch (err: any) {
      req.log.error({ err }, 'GitHub OAuth callback failed');
      try {
        const fallback = accessControl.buildFrontendRedirect({
          error: err?.message ?? 'GitHub login failed',
        });
        return reply.redirect(fallback, 302);
      } catch {
        return reply.code(401).send({ message: err?.message ?? 'GitHub login failed' });
      }
    }
  });

  server.get('/auth/me', async (req, reply) => {
    const viewer = (req as any).viewer as
      | { login: string; source: ViewerSource }
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
