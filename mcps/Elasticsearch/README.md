# Elasticsearch MCP

Lets an assistant explore and query the UChicago Analysis Facility Elasticsearch cluster:
find indices, inspect their field mappings and run searches and aggregations in the
Elasticsearch Query DSL. All tools are read-only. It is based on the official Elastic MCP
server and uses one cluster credential held by the server.

| | |
| --- | --- |
| Endpoint | `https://es.af.atlas-ml.org/mcp` (Streamable HTTP) |
| Auth | CERN login via OAuth (client ID `af-mcp`, scope `es-mcp`), or an AF MCP API key |

## Tools

| Tool | What it does | Parameters |
| --- | --- | --- |
| `list_indices` | Indices matching a pattern, with health, status and document count | `indexPattern` (e.g. `atlas_*`) |
| `get_mappings` | Field mappings of an index; use it before writing a query | `index` |
| `search` | Run a search | `index`, `queryBody`: a Query DSL object, e.g. `{"query": {...}, "size": 10, "aggs": {...}}` |

`search` returns Elasticsearch's full response, so ask for a small `size` or use
aggregations on large indices.

## Connect

See [the shared connection guide](../README.md#connecting-a-client) for details and
troubleshooting.

### Claude Code

```bash
claude mcp add --transport http --scope user --client-id af-mcp --callback-port 8977 elasticsearch https://es.af.atlas-ml.org/mcp
```

Leave the client secret empty, then `/mcp` → **elasticsearch** → **Authenticate**.

### Claude Desktop and claude.ai

**Settings → Connectors → Add custom connector**, URL
`https://es.af.atlas-ml.org/mcp`, **Advanced settings → OAuth Client ID** `af-mcp`, secret
empty, then **Connect**.

### ChatGPT

With Developer mode on, create a **New Plugin** with server URL
`https://es.af.atlas-ml.org/mcp` and authentication **OAuth**. Under **Advanced OAuth settings**:
registration method **User-Defined OAuth Client**, client ID `af-mcp`, secret empty, token
endpoint auth method **`none`**, scope `es-mcp`. Details in the
[connection guide](../README.md#chatgpt-web-and-desktop-app).

### VS Code

In `.vscode/mcp.json` or your user configuration; enter client ID `af-mcp` when asked:

```json
{
  "servers": {
    "elasticsearch": { "type": "http", "url": "https://es.af.atlas-ml.org/mcp" }
  }
}
```

### OpenClaw

With the API key in `~/.openclaw/.env` as `AF_MCP_API_KEY`:

```bash
openclaw mcp set elastic '{"url":"https://es.af.atlas-ml.org/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${AF_MCP_API_KEY}"}}'
openclaw mcp probe elastic
```

Tools appear as `elastic__search`, `elastic__list_indices`, …

## Development

```bash
cd mcps/Elasticsearch
npm install                 # also builds
ES_URL=https://... ES_API_KEY=... API_KEY_1=dev npm start    # http://localhost:3000/mcp
npm run inspector
```

| Variable | Meaning |
| --- | --- |
| `ES_URL` | Elasticsearch URL |
| `ES_API_KEY`, or `ES_USERNAME` + `ES_PASSWORD` | Cluster credential (from the `es-secret` secret) |
| `ES_CA_CERT` | Path to a CA certificate for the cluster, if not publicly trusted |
| `ES_PATH_PREFIX` | Prefix added to every request path, for a cluster behind a path-based proxy |
| `PORT` | Listen port (default `3000`) |

Plus the [common variables](../README.md#for-maintainers). The server has no CORS handling,
so browser-based MCP clients cannot reach it; Claude, ChatGPT, VS Code and OpenClaw are not
affected. Deployment: [es_mcp.yaml](../../deploy/mcps/es_mcp.yaml).
