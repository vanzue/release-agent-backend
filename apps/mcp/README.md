# Release Agent MCP Server

An [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) server that exposes semantic issue search over the Release Agent database. Use it from any MCP-compatible client (GitHub Copilot, Claude Desktop, Cursor, etc.) to query similar issues by natural language.

## Tools

| Tool | Description |
|------|-------------|
| `search_similar_issues` | Semantic search — describe a problem in natural language, get back the most similar GitHub issues ranked by cosine similarity |
| `find_issues_like` | Find issues similar to a given issue number — uses the existing issue's embedding to find related issues |

## Prerequisites

Before connecting, make sure:

1. **The Release Agent database is running** — the MCP server connects to the same PostgreSQL + pgvector database used by the API and worker. You need a working `DATABASE_URL`.
2. **Issues have been synced and embedded** — the worker must have already synced GitHub issues and generated embeddings via Azure OpenAI. Without embeddings, semantic search won't return results.
3. **Azure OpenAI is configured** — the MCP server calls Azure OpenAI to embed your search queries at runtime (for `search_similar_issues`).
4. **Node.js 18+** is installed.

## Build

```bash
# From the monorepo root:
pnpm install
pnpm --filter @release-agent/mcp build
```

This produces `apps/mcp/dist/index.js` — the MCP server entry point.

## Connecting to the MCP Server

The server uses **stdio** transport — the MCP client spawns it as a child process and communicates over stdin/stdout. You provide the env vars in the client config.

---

### GitHub Copilot (VS Code / VS Code Insiders)

1. Open your project in VS Code
2. Create or edit `.vscode/mcp.json` in your workspace root:

```json
{
  "servers": {
    "release-agent-issues": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Users/kaitao/codes/release-agent/release-agent-backend/apps/mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:password@localhost:5432/release_agent",
        "AZURE_OPENAI_ENDPOINT": "https://your-resource.openai.azure.com/",
        "AZURE_OPENAI_API_KEY": "your-api-key",
        "AZURE_OPENAI_API_VERSION": "2024-02-15-preview",
        "ISSUE_EMBEDDING_MODEL_ID": "text-embedding-3-small",
        "DEFAULT_REPO": "microsoft/PowerToys"
      }
    }
  }
}
```

3. Reload VS Code — the MCP server will appear in the Copilot tool list
4. In Copilot Chat, you can now ask things like:
   - *"Search for issues about FancyZones crashing on multi-monitor setups"*
   - *"Find issues similar to #12345"*

> **Tip:** You can also put this in your **user-level** `settings.json` under `"mcp.servers"` to make it available across all projects.

---

### GitHub Copilot CLI (this tool)

Add to your MCP config (usually `~/.config/github-copilot/mcp.json` or as directed by your setup):

```json
{
  "servers": {
    "release-agent-issues": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Users/kaitao/codes/release-agent/release-agent-backend/apps/mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:password@localhost:5432/release_agent",
        "AZURE_OPENAI_ENDPOINT": "https://your-resource.openai.azure.com/",
        "AZURE_OPENAI_API_KEY": "your-api-key",
        "AZURE_OPENAI_API_VERSION": "2024-02-15-preview",
        "ISSUE_EMBEDDING_MODEL_ID": "text-embedding-3-small",
        "DEFAULT_REPO": "microsoft/PowerToys"
      }
    }
  }
}
```

---

### Claude Desktop

1. Open Claude Desktop settings → Developer → Edit Config
2. Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "release-agent-issues": {
      "command": "node",
      "args": ["C:/Users/kaitao/codes/release-agent/release-agent-backend/apps/mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://user:password@localhost:5432/release_agent",
        "AZURE_OPENAI_ENDPOINT": "https://your-resource.openai.azure.com/",
        "AZURE_OPENAI_API_KEY": "your-api-key",
        "AZURE_OPENAI_API_VERSION": "2024-02-15-preview",
        "ISSUE_EMBEDDING_MODEL_ID": "text-embedding-3-small",
        "DEFAULT_REPO": "microsoft/PowerToys"
      }
    }
  }
}
```

3. Restart Claude Desktop — the tools will appear in the toolbox icon

---

### Cursor

1. Open Cursor Settings → MCP
2. Click "Add new MCP server"
3. Choose **stdio** transport and configure:
   - **Command:** `node`
   - **Args:** `C:/Users/kaitao/codes/release-agent/release-agent-backend/apps/mcp/dist/index.js`
   - **Env vars:** same as above

---

### Dev / Testing Mode

For local development or testing the server directly:

```bash
cd apps/mcp
cp .env.example .env   # fill in your actual values
npx tsx --env-file=.env src/index.ts
```

The server reads from stdin and writes to stdout using JSON-RPC. You can test with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (same DB as API/worker) |
| `AZURE_OPENAI_ENDPOINT` | Yes | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_API_KEY` | Yes | Azure OpenAI API key |
| `ISSUE_EMBEDDING_MODEL_ID` | Yes | Embedding model deployment name (e.g. `text-embedding-3-small`) |
| `AZURE_OPENAI_API_VERSION` | No | Azure API version (e.g. `2024-02-15-preview`) |
| `DB_POOL_MAX` | No | Max DB connections (default: 5) |
| `DEFAULT_REPO` | No | Default repo for queries (default: `microsoft/PowerToys`) |

## Tool Reference

### `search_similar_issues`

Search by natural-language description. The server embeds your query via Azure OpenAI and finds the most similar issues using pgvector cosine similarity.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural-language description of the problem |
| `repo` | string | No | GitHub repo full name (default: `DEFAULT_REPO`) |
| `productLabel` | string | No | Filter to a product area label |
| `state` | `"open"` \| `"closed"` | No | Filter by issue state |
| `minSimilarity` | number (0-1) | No | Similarity threshold (default: 0.80) |
| `limit` | number (1-50) | No | Max results (default: 10) |

**Example prompts:**
- *"Find issues about keyboard shortcuts not working in PowerToys Run"*
- *"Search for crash reports related to Color Picker on Windows 11"*
- *"Are there any issues about high CPU usage in FancyZones?"*

### `find_issues_like`

Find issues semantically similar to an existing issue by its number. Uses the stored embedding — no Azure OpenAI call needed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `issueNumber` | number | Yes | The issue number to find similar issues for |
| `repo` | string | No | GitHub repo full name (default: `DEFAULT_REPO`) |
| `productLabel` | string | No | Filter to a product area label |
| `state` | `"open"` \| `"closed"` | No | Filter by issue state |
| `minSimilarity` | number (0-1) | No | Similarity threshold (default: 0.80) |
| `limit` | number (1-50) | No | Max results (default: 10) |

**Example prompts:**
- *"Find issues similar to #34567"*
- *"What other open issues are like issue 12345?"*
- *"Show me duplicates of #9999 in the FancyZones product area"*
