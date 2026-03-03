import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';

// ── Config ──────────────────────────────────────────────────────────────

const API_BASE_URL = (process.env.RELEASE_AGENT_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const API_TOKEN = process.env.RELEASE_AGENT_API_TOKEN;
const DEFAULT_REPO = process.env.DEFAULT_REPO ?? 'microsoft/PowerToys';
const PORT = parseInt(process.env.PORT ?? '3100', 10);

// ── API Client ──────────────────────────────────────────────────────────

async function apiGet<T = any>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, API_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {};
  if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Helpers ─────────────────────────────────────────────────────────────

interface SemanticSearchResponse {
  mode: string;
  issueNumber: number | null;
  query: string | null;
  results: Array<{
    issueNumber: number;
    title: string;
    state: string;
    similarity: number;
    reactionsCount?: number;
    commentsCount?: number;
    productLabels?: string[];
    updatedAt?: string;
  }>;
}

function formatResults(results: SemanticSearchResponse['results'], repoName: string): string {
  return results.map((r, i) =>
    `${i + 1}. #${r.issueNumber} [${r.state}] (${(Number(r.similarity) * 100).toFixed(1)}% similar)\n` +
    `   ${r.title}\n` +
    `   👍 ${r.reactionsCount ?? 0} reactions · 💬 ${r.commentsCount ?? 0} comments · ${(r.productLabels ?? []).join(', ') || 'no label'}\n` +
    `   https://github.com/${repoName}/issues/${r.issueNumber}`
  ).join('\n\n');
}

// ── MCP Server Factory ─────────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name: 'release-agent-issues',
    version: '1.0.0',
    description: 'Semantic search over Microsoft PowerToys GitHub issues. Find duplicate issues, related bug reports, feature requests, and known problems across PowerToys modules like FancyZones, PowerToys Run, Color Picker, Always On Top, File Locksmith, and more.',
  });

  // Tool 1: Search by natural-language query
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
        const data = await apiGet<SemanticSearchResponse>('/issues/semantic-search', {
          repo: repoName,
          q: query,
          productLabel,
          minSimilarity: (minSimilarity ?? 0.80).toString(),
          limit: (limit ?? 10).toString(),
        });

        const results = data.results ?? [];
        const text = results.length > 0
          ? `Found ${results.length} similar issues in ${repoName}:\n\n${formatResults(results, repoName)}`
          : `No similar issues found in ${repoName} for query: "${query}"`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
      }
    },
  );

  // Tool 2: Find issues similar to an existing issue by number
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
        const data = await apiGet<SemanticSearchResponse>('/issues/semantic-search', {
          repo: repoName,
          issueNumber: issueNumber.toString(),
          productLabel,
          minSimilarity: (minSimilarity ?? 0.80).toString(),
          limit: (limit ?? 10).toString(),
        });

        const results = data.results ?? [];
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

// ── HTTP Server ─────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// --- Streamable HTTP transport (modern clients) ---

app.post('/mcp', async (req, res) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e: any) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Method not allowed. Use POST.' }));
app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'Method not allowed.' }));

// --- Legacy SSE transport (VS Code, older clients) ---

const sseTransports = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

app.get('/sse', async (req, res) => {
  const server = createMcpServer();
  const transport = new SSEServerTransport('/messages', res);
  const sessionId = transport.sessionId;
  sseTransports.set(sessionId, { transport, server });
  res.on('close', () => {
    sseTransports.delete(sessionId);
    transport.close?.();
    server.close();
  });
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const entry = sseTransports.get(sessionId);
  if (!entry) {
    res.status(400).json({ error: 'Invalid or expired session. Connect to /sse first.' });
    return;
  }
  await entry.transport.handlePostMessage(req, res);
});

// --- Health ---

app.get('/health', (_req, res) => res.json({ status: 'ok', name: 'release-agent-mcp' }));

app.listen(PORT, () => {
  console.log(`Release Agent MCP server listening on http://localhost:${PORT}`);
  console.log(`  Streamable HTTP: POST http://localhost:${PORT}/mcp`);
  console.log(`  Legacy SSE:      GET  http://localhost:${PORT}/sse`);
});
