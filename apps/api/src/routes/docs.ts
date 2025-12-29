import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export async function registerDocsRoutes(server: FastifyInstance): Promise<void> {
  const require = createRequire(import.meta.url);
  // swagger-ui-dist is CommonJS; use require() for compatibility in ESM.
  const swaggerUiDist = require('swagger-ui-dist');
  const root = swaggerUiDist.getAbsoluteFSPath();

  const here = dirname(fileURLToPath(import.meta.url));
  const openApiPath = resolve(here, '..', '..', '..', '..', 'backend', 'api', 'openapi.yaml');

  // Serve OpenAPI spec
  server.get('/openapi.yaml', async (_req, reply) => {
    try {
      const content = await readFile(openApiPath, 'utf-8');
      reply.header('cache-control', 'no-store');
      return reply.type('text/yaml; charset=utf-8').send(content);
    } catch (err: unknown) {
      server.log.error({ err }, 'Failed to read OpenAPI spec');
      return reply.code(500).send({ error: 'Failed to load OpenAPI spec' });
    }
  });

  // Serve Swagger UI static assets
  await server.register(fastifyStatic, {
    root,
    prefix: '/docs/',
    decorateReply: false,
  });

  server.get('/docs', async (_req, reply) => {
    return reply.redirect('/docs/', 302);
  });

  server.get('/docs/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');

    // Use relative asset paths so it works behind reverse proxies.
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>API Docs</title>
    <link rel="stylesheet" href="./swagger-ui.css" />
    <style>
      html, body { height: 100%; margin: 0; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="./swagger-ui-bundle.js"></script>
    <script src="./swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = function () {
        window.ui = SwaggerUIBundle({
          url: '/openapi.yaml',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [
            SwaggerUIBundle.presets.apis,
            SwaggerUIStandalonePreset
          ],
          layout: 'BaseLayout'
        });
      };
    </script>
  </body>
</html>`;
  });
}
