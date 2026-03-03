import type { FastifyInstance } from 'fastify';
import type { PgStore } from '../store/pg.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const DEFAULT_REPO = process.env.DEFAULT_REPO ?? 'microsoft/PowerToys';

// Embedding helper (same as issues.ts)
async function embedText(text: string): Promise<number[]> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
  const modelId = process.env.ISSUE_EMBEDDING_MODEL_ID;

  if (!endpoint || !apiKey || !modelId) {
    throw new Error('Missing Azure OpenAI configuration for embeddings');
  }

  const baseURL = endpoint.replace(/\/?$/, '/');
  const url = apiVersion
    ? `${baseURL}openai/deployments/${encodeURIComponent(modelId)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`
    : `${baseURL}openai/v1/embeddings`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      ...(apiVersion ? {} : { model: modelId }),
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Azure OpenAI embeddings error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as any;
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error('Invalid embeddings response');
  return embedding.map((n: any) => Number(n));
}

interface SearchResult {
  issueNumber: number;
  title: string;
  state: string;
  similarity: number;
  reactionsCount?: number;
  commentsCount?: number;
  productLabels: string[];
  updatedAt: string;
}

function formatResults(results: SearchResult[], repoName: string): string {
  return results.map((r, i) =>
    `${i + 1}. #${r.issueNumber} [${r.state}] (${(Number(r.similarity) * 100).toFixed(1)}% similar)\n` +
    `   ${r.title}\n` +
    `   👍 ${r.reactionsCount} reactions · 💬 ${r.commentsCount} comments · ${(r.productLabels ?? []).join(', ') || 'no label'}\n` +
    `   https://github.com/${repoName}/issues/${r.issueNumber}`
  ).join('\n\n');
}

function createMcpServer(store: PgStore) {
  const server = new McpServer({
    name: 'release-agent-issues',
    version: '1.0.0',
    description: 'Semantic search over Microsoft PowerToys GitHub issues. Find duplicate issues, related bug reports, feature requests, and known problems across PowerToys modules like FancyZones, PowerToys Run, Color Picker, Always On Top, File Locksmith, and more.',
  });

  server.tool(
    'search_similar_issues',
    'Search Microsoft PowerToys GitHub issues by semantic similarity. Describe a bug, feature request, or problem in natural language (e.g. "FancyZones crashes on multi-monitor", "Color Picker high DPI", "PowerToys Run slow startup") and get back the most similar issues ranked by relevance. Useful for finding duplicates, prior art, and related reports across all PowerToys modules.',
    {
      query: z.string().describe('Natural-language description of the issue or problem to search for'),
      repo: z.string().optional().describe(`GitHub repo full name (default: ${DEFAULT_REPO})`),
      productLabel: z.string().optional().describe('Filter to a specific product area label'),
      minSimilarity: z.number().min(0).max(1).optional().describe('Minimum cosine similarity threshold (default: 0.80)'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default: 10)'),
    },
    async ({ query, repo, productLabel, minSimilarity, limit }) => {
      const repoName = repo ?? DEFAULT_REPO;
      try {
        const embedding = await embedText(query);
        const results = await store.searchIssuesByEmbedding({
          repoFullName: repoName,
          embedding,
          embeddingModel: process.env.ISSUE_EMBEDDING_MODEL_ID?.trim() || undefined,
          productLabel,
          minSimilarity: minSimilarity ?? 0.80,
          limit: limit ?? 10,
        });

        const text = results.length > 0
          ? `Found ${results.length} similar issues in ${repoName}:\n\n${formatResults(results, repoName)}`
          : `No similar issues found in ${repoName} for query: "${query}"`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'find_issues_like',
    "Find Microsoft PowerToys GitHub issues that are semantically similar to a given issue number. Provide an existing PowerToys issue number and get back related issues — useful for duplicate detection, triage, and understanding the scope of a problem across PowerToys modules.",
    {
      issueNumber: z.number().int().describe('The issue number to find similar issues for'),
      repo: z.string().optional().describe(`GitHub repo full name (default: ${DEFAULT_REPO})`),
      productLabel: z.string().optional().describe('Filter to a specific product area label'),
      minSimilarity: z.number().min(0).max(1).optional().describe('Minimum cosine similarity threshold (default: 0.80)'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default: 10)'),
    },
    async ({ issueNumber, repo, productLabel, minSimilarity, limit }) => {
      const repoName = repo ?? DEFAULT_REPO;
      try {
        const results = await store.findSimilarIssues({
          repoFullName: repoName,
          issueNumber,
          productLabel,
          minSimilarity: minSimilarity ?? 0.80,
          limit: limit ?? 10,
        });

        const text = results.length > 0
          ? `Issues similar to #${issueNumber}:\n\n${formatResults(results, repoName)}`
          : `No similar issues found for #${issueNumber} in ${repoName}.`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  return server;
}

// ── SSE session tracking ──────────────────────────────────────────────

const sseTransports = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

// ── Route registration ────────────────────────────────────────────────

export function registerMcpRoutes(app: FastifyInstance, store: PgStore) {

  // Streamable HTTP transport (modern clients)
  app.post('/mcp', async (req, reply) => {
    try {
      const server = createMcpServer(store);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const raw = reply.raw;
      raw.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req.raw, raw, req.body);
      // Tell Fastify we've already handled the response
      reply.hijack();
    } catch (e: any) {
      if (!reply.sent) reply.code(500).send({ error: e.message });
    }
  });

  app.get('/mcp', async (_req, reply) => {
    reply.code(405).send({ error: 'Method not allowed. Use POST.' });
  });

  app.delete('/mcp', async (_req, reply) => {
    reply.code(405).send({ error: 'Method not allowed.' });
  });

  // Legacy SSE transport (older clients)
  app.get('/sse', async (req, reply) => {
    const server = createMcpServer(store);
    const transport = new SSEServerTransport('/messages', reply.raw);
    const sessionId = transport.sessionId;
    sseTransports.set(sessionId, { transport, server });
    reply.raw.on('close', () => {
      sseTransports.delete(sessionId);
      transport.close?.();
      server.close();
    });
    await server.connect(transport);
    reply.hijack();
  });

  app.post('/messages', async (req, reply) => {
    const sessionId = (req.query as any).sessionId as string;
    const entry = sseTransports.get(sessionId);
    if (!entry) {
      reply.code(400).send({ error: 'Invalid or expired session. Connect to /sse first.' });
      return;
    }
    await entry.transport.handlePostMessage(req.raw, reply.raw);
    reply.hijack();
  });
}
