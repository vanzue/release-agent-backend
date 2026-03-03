# Release Agent MCP Server

A remote [MCP](https://modelcontextprotocol.io/) (Model Context Protocol) server that exposes semantic issue search over the Release Agent platform. It runs as an HTTP endpoint — clients connect by URL only, with no database credentials or API keys required on the client side.

## Architecture

```
┌─────────────────┐       HTTP/JSON-RPC        ┌─────────────────┐       HTTP        ┌──────────────────┐
│  MCP Client     │  ───────────────────────►  │  MCP Server     │  ─────────────►  │  Release Agent   │
│  (VS Code,      │    POST /mcp               │  (:3100)        │                  │  API (:3001)     │
│  Claude, etc.)  │                            │                 │                  │  (DB, Embeddings)│
└─────────────────┘                            └─────────────────┘                  └──────────────────┘
```

The MCP server is a thin proxy that forwards tool calls to the Release Agent API. All sensitive configuration (database, Azure OpenAI keys) stays on the server side.

## Tools

| Tool | Description |
|------|-------------|
| `search_similar_issues` | Semantic search — describe a problem in natural language, get back the most similar GitHub issues ranked by cosine similarity |
| `find_issues_like` | Find issues similar to a given issue number — uses the existing issue's embedding to find related issues |

## Deployment

### 1. Build

```bash
# From the monorepo root:
pnpm install
pnpm --filter @release-agent/mcp build
```

### 2. Configure

Create a `.env` file (or set environment variables):

```bash
# Required: URL of the Release Agent API
RELEASE_AGENT_API_URL=http://localhost:3001

# Optional: Bearer token for API auth
# RELEASE_AGENT_API_TOKEN=your-token

# Optional
PORT=3100
DEFAULT_REPO=microsoft/PowerToys
```

### 3. Start

```bash
cd apps/mcp
node dist/index.js
# → Release Agent MCP server listening on http://localhost:3100/mcp
```

Or for development:

```bash
pnpm --filter @release-agent/mcp dev
```

### Health Check

```bash
curl http://localhost:3100/health
# → {"status":"ok","name":"release-agent-mcp"}
```

## Connecting MCP Clients

All clients connect to the same URL — no secrets needed on the client side.

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "release-agent-issues": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "release-agent-issues": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

### Cursor

Settings → MCP → Add server → choose **HTTP** transport → enter URL `http://localhost:3100/mcp`

### MCP Inspector (Testing)

```bash
npx @modelcontextprotocol/inspector --url http://localhost:3100/mcp
```

## Environment Variables (Server-Side Only)

| Variable | Required | Description |
|----------|----------|-------------|
| `RELEASE_AGENT_API_URL` | Yes | Base URL of the Release Agent API (e.g. `http://localhost:3001`) |
| `RELEASE_AGENT_API_TOKEN` | No | Bearer token for API auth (if API requires it) |
| `PORT` | No | HTTP port to listen on (default: `3100`) |
| `DEFAULT_REPO` | No | Default repo for queries (default: `microsoft/PowerToys`) |

## Tool Reference

### `search_similar_issues`

Search by natural-language description.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural-language description of the problem |
| `repo` | string | No | GitHub repo full name (default: `DEFAULT_REPO`) |
| `productLabel` | string | No | Filter to a product area label |
| `minSimilarity` | number (0-1) | No | Similarity threshold (default: 0.80) |
| `limit` | number (1-50) | No | Max results (default: 10) |

**Example prompts:**
- *"Find issues about keyboard shortcuts not working in PowerToys Run"*
- *"Search for crash reports related to Color Picker on Windows 11"*

### `find_issues_like`

Find issues semantically similar to an existing issue by its number.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `issueNumber` | number | Yes | The issue number to find similar issues for |
| `repo` | string | No | GitHub repo full name (default: `DEFAULT_REPO`) |
| `productLabel` | string | No | Filter to a product area label |
| `minSimilarity` | number (0-1) | No | Similarity threshold (default: 0.80) |
| `limit` | number (1-50) | No | Max results (default: 10) |

**Example prompts:**
- *"Find issues similar to #34567"*
- *"What other open issues are like issue 12345?"*
