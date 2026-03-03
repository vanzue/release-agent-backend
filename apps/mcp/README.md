# Release Agent MCP Server

An [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) server that exposes semantic issue search over the Release Agent database. Use it from any MCP-compatible client (GitHub Copilot, Claude Desktop, Cursor, etc.) to query similar issues by natural language.

## Tools

| Tool | Description |
|------|-------------|
| `search_similar_issues` | Semantic search — describe a problem in natural language, get back the most similar GitHub issues ranked by cosine similarity |
| `find_issues_like` | Find issues similar to a given issue number — uses the existing issue's embedding to find related issues |

## Setup

```bash
# 1. Install dependencies (from monorepo root)
pnpm install

# 2. Copy and fill in env vars
cp .env.example .env

# 3. Build
pnpm --filter @release-agent/mcp build
```

## Usage

### With GitHub Copilot (VS Code)

Add to your `.vscode/mcp.json`:

```json
{
  "servers": {
    "release-agent-issues": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to-repo>/release-agent-backend/apps/mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "AZURE_OPENAI_ENDPOINT": "https://...",
        "AZURE_OPENAI_API_KEY": "...",
        "ISSUE_EMBEDDING_MODEL_ID": "text-embedding-3-small"
      }
    }
  }
}
```

### With Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "release-agent-issues": {
      "command": "node",
      "args": ["<path-to-repo>/release-agent-backend/apps/mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "AZURE_OPENAI_ENDPOINT": "https://...",
        "AZURE_OPENAI_API_KEY": "...",
        "ISSUE_EMBEDDING_MODEL_ID": "text-embedding-3-small"
      }
    }
  }
}
```

### Dev mode

```bash
cd apps/mcp
cp .env.example .env  # fill in values
npx tsx --env-file=.env src/index.ts
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (same DB as API/worker) |
| `AZURE_OPENAI_ENDPOINT` | Yes | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_API_KEY` | Yes | Azure OpenAI API key |
| `ISSUE_EMBEDDING_MODEL_ID` | Yes | Embedding model deployment name |
| `AZURE_OPENAI_API_VERSION` | No | Azure API version (e.g. `2024-02-15-preview`) |
| `DB_POOL_MAX` | No | Max DB connections (default: 5) |
| `DEFAULT_REPO` | No | Default repo for queries (default: `microsoft/PowerToys`) |
