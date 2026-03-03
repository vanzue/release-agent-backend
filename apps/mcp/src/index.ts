import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pg from 'pg';

const { Pool } = pg;

// ── Config ──────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('Missing DATABASE_URL');

const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION;
const ISSUE_EMBEDDING_MODEL_ID = process.env.ISSUE_EMBEDDING_MODEL_ID;
const DEFAULT_REPO = process.env.DEFAULT_REPO ?? 'microsoft/PowerToys';

if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !ISSUE_EMBEDDING_MODEL_ID) {
  throw new Error('Missing Azure OpenAI configuration (AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, ISSUE_EMBEDDING_MODEL_ID)');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number.parseInt(process.env.DB_POOL_MAX ?? '5', 10),
});

// ── Helpers ─────────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  const baseURL = AZURE_OPENAI_ENDPOINT!.replace(/\/?$/, '/');
  const url = AZURE_OPENAI_API_VERSION
    ? `${baseURL}openai/deployments/${encodeURIComponent(ISSUE_EMBEDDING_MODEL_ID!)}/embeddings?api-version=${encodeURIComponent(AZURE_OPENAI_API_VERSION)}`
    : `${baseURL}openai/v1/embeddings`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': AZURE_OPENAI_API_KEY! },
    body: JSON.stringify({
      ...(AZURE_OPENAI_API_VERSION ? {} : { model: ISSUE_EMBEDDING_MODEL_ID }),
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

async function searchIssuesByEmbedding(input: {
  repo: string;
  embedding: number[];
  productLabel?: string;
  state?: 'open' | 'closed';
  minSimilarity: number;
  limit: number;
}) {
  const embeddingLiteral = `[${input.embedding.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}]`;
  const params: any[] = [
    input.repo,
    embeddingLiteral,
    input.minSimilarity,
    ISSUE_EMBEDDING_MODEL_ID?.trim() || null,
  ];

  let productFilter = '';
  if (input.productLabel) {
    params.push([input.productLabel]);
    productFilter = `having array_agg(distinct p.product_label) @> $${params.length}`;
  }

  let stateFilter = '';
  if (input.state) {
    params.push(input.state);
    stateFilter = `and i.state = $${params.length}`;
  }

  params.push(input.limit);

  const sql = `
    select
      i.issue_number,
      i.title,
      i.state,
      i.updated_at,
      i.reactions_count,
      i.comments_count,
      1 - (i.embedding <=> $2::vector) as similarity,
      coalesce(array_agg(distinct p.product_label) filter (where p.product_label is not null), '{}') as product_labels
    from issues i
    left join issue_products p on p.repo = i.repo and p.issue_number = i.issue_number
    where i.repo = $1
      and i.embedding is not null
      and vector_dims(i.embedding) = vector_dims($2::vector)
      and ($4::text is null or i.embedding_model = $4)
      and 1 - (i.embedding <=> $2::vector) >= $3
      ${stateFilter}
    group by i.issue_number, i.title, i.state, i.updated_at, i.reactions_count, i.comments_count, i.embedding
    ${productFilter}
    order by similarity desc
    limit $${params.length}
  `;

  const res = await pool.query(sql, params);
  return res.rows.map((r: any) => ({
    issueNumber: Number(r.issue_number),
    title: r.title as string,
    state: r.state as string,
    similarity: Number(r.similarity ?? 0),
    reactionsCount: Number(r.reactions_count ?? 0),
    commentsCount: Number(r.comments_count ?? 0),
    productLabels: (r.product_labels as string[]) ?? [],
    updatedAt: r.updated_at as string,
  }));
}

async function getIssueEmbedding(repo: string, issueNumber: number) {
  const sql = `
    select i.title, i.embedding, i.embedding_model
    from issues i
    where i.repo = $1 and i.issue_number = $2
  `;
  const res = await pool.query(sql, [repo, issueNumber]);
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    title: r.title as string,
    embedding: r.embedding as string | null,
    embeddingModel: r.embedding_model as string | null,
  };
}

// ── MCP Server ──────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'release-agent-issues',
  version: '1.0.0',
});

// Tool 1: Search by natural-language query
server.tool(
  'search_similar_issues',
  'Search GitHub issues by semantic similarity. Provide a natural-language description of a bug, feature, or problem and get back the most similar issues.',
  {
    query: z.string().describe('Natural-language description of the issue or problem to search for'),
    repo: z.string().optional().describe(`GitHub repo full name (default: ${DEFAULT_REPO})`),
    productLabel: z.string().optional().describe('Filter to a specific product area label'),
    state: z.enum(['open', 'closed']).optional().describe('Filter by issue state'),
    minSimilarity: z.number().min(0).max(1).optional().describe('Minimum cosine similarity threshold (default: 0.80)'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default: 10)'),
  },
  async ({ query, repo, productLabel, state, minSimilarity, limit }) => {
    const repoName = repo ?? DEFAULT_REPO;
    const embedding = await embedText(query);
    const results = await searchIssuesByEmbedding({
      repo: repoName,
      embedding,
      productLabel,
      state,
      minSimilarity: minSimilarity ?? 0.80,
      limit: limit ?? 10,
    });

    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No similar issues found in ${repoName} for query: "${query}"` }] };
    }

    const lines = results.map((r, i) =>
      `${i + 1}. #${r.issueNumber} [${r.state}] (${(r.similarity * 100).toFixed(1)}% similar)\n` +
      `   ${r.title}\n` +
      `   👍 ${r.reactionsCount} reactions · 💬 ${r.commentsCount} comments · ${r.productLabels.join(', ') || 'no label'}\n` +
      `   https://github.com/${repoName}/issues/${r.issueNumber}`
    );

    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} similar issues in ${repoName}:\n\n${lines.join('\n\n')}`,
      }],
    };
  },
);

// Tool 2: Find issues similar to an existing issue by number
server.tool(
  'find_issues_like',
  'Find issues that are semantically similar to a given issue number. Uses the existing issue\'s embedding to search for related issues.',
  {
    issueNumber: z.number().int().describe('The issue number to find similar issues for'),
    repo: z.string().optional().describe(`GitHub repo full name (default: ${DEFAULT_REPO})`),
    productLabel: z.string().optional().describe('Filter to a specific product area label'),
    state: z.enum(['open', 'closed']).optional().describe('Filter by issue state'),
    minSimilarity: z.number().min(0).max(1).optional().describe('Minimum cosine similarity threshold (default: 0.80)'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default: 10)'),
  },
  async ({ issueNumber, repo, productLabel, state, minSimilarity, limit }) => {
    const repoName = repo ?? DEFAULT_REPO;
    const issue = await getIssueEmbedding(repoName, issueNumber);

    if (!issue) {
      return { content: [{ type: 'text', text: `Issue #${issueNumber} not found in ${repoName}.` }] };
    }
    if (!issue.embedding) {
      return { content: [{ type: 'text', text: `Issue #${issueNumber} ("${issue.title}") has no embedding yet. It may not have been processed.` }] };
    }

    // Parse the stored pgvector string "[0.1,0.2,...]" into a number array
    const embedding = issue.embedding
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((v: string) => Number(v));

    const results = await searchIssuesByEmbedding({
      repo: repoName,
      embedding,
      productLabel,
      state,
      minSimilarity: minSimilarity ?? 0.80,
      limit: (limit ?? 10) + 1, // fetch one extra since the source issue will be in results
    });

    // Filter out the source issue itself
    const filtered = results.filter((r) => r.issueNumber !== issueNumber).slice(0, limit ?? 10);

    if (filtered.length === 0) {
      return { content: [{ type: 'text', text: `No similar issues found for #${issueNumber} ("${issue.title}") in ${repoName}.` }] };
    }

    const lines = filtered.map((r, i) =>
      `${i + 1}. #${r.issueNumber} [${r.state}] (${(r.similarity * 100).toFixed(1)}% similar)\n` +
      `   ${r.title}\n` +
      `   👍 ${r.reactionsCount} reactions · 💬 ${r.commentsCount} comments · ${r.productLabels.join(', ') || 'no label'}\n` +
      `   https://github.com/${repoName}/issues/${r.issueNumber}`
    );

    return {
      content: [{
        type: 'text',
        text: `Issues similar to #${issueNumber} ("${issue.title}"):\n\n${lines.join('\n\n')}`,
      }],
    };
  },
);

// ── Start ───────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
