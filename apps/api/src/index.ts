import { buildServer } from './server.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';

const server = await buildServer();
await server.listen({ port, host });

