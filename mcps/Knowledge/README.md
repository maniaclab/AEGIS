# Knowledge MCP

Gives an assistant the USATLAS Analysis Facility documentation, so it can answer "how do I …
on the AF" questions from the real docs instead of guessing. The documents are the Markdown
pages of [usatlas/af-docs](https://github.com/usatlas/af-docs), baked into the image at build
time; rebuild the image to pick up doc changes. Read-only.

| | |
| --- | --- |
| Endpoint | `https://knowledge.af.atlas-ml.org/mcp` (Streamable HTTP) |
| Auth | CERN login via OAuth (client ID `af-mcp`, scope `knowledge-mcp`), or an AF MCP API key |

## Tools and resources

| Tool | What it does | Parameters |
| --- | --- | --- |
| `list_resources` | List every document as a `knowledge://` URI | none |
| `get_resource` | Return one document's Markdown | `uri`, e.g. `knowledge://jupyter/conda.md` |

Every document is also exposed as an MCP **resource** with the same `knowledge://<path>`
URI, for clients that let you attach resources directly (Claude Code: type `@` and pick one).

## Connect

See [the shared connection guide](../README.md#connecting-a-client) for details and
troubleshooting.

### Claude Code

```bash
claude mcp add --transport http --scope user --client-id af-mcp --callback-port 8977 knowledge https://knowledge.af.atlas-ml.org/mcp
```

Leave the client secret empty, then `/mcp` → **knowledge** → **Authenticate**.

### Claude Desktop and claude.ai

**Settings → Connectors → Add custom connector**, URL
`https://knowledge.af.atlas-ml.org/mcp`, **Advanced settings → OAuth Client ID** `af-mcp`,
secret empty, then **Connect**.

### ChatGPT

With Developer mode on, create a **New Plugin** with server URL
`https://knowledge.af.atlas-ml.org/mcp` and authentication **OAuth**. Under **Advanced OAuth settings**:
registration method **User-Defined OAuth Client**, client ID `af-mcp`, secret empty, token
endpoint auth method **`none`**, scope `knowledge-mcp`. Details in the
[connection guide](../README.md#chatgpt-web-and-desktop-app).

### VS Code

In `.vscode/mcp.json` or your user configuration; enter client ID `af-mcp` when asked:

```json
{
  "servers": {
    "knowledge": { "type": "http", "url": "https://knowledge.af.atlas-ml.org/mcp" }
  }
}
```

### OpenClaw

With the API key in `~/.openclaw/.env` as `AF_MCP_API_KEY`:

```bash
openclaw mcp set knowledge '{"url":"https://knowledge.af.atlas-ml.org/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${AF_MCP_API_KEY}"}}'
openclaw mcp probe knowledge
```

Tools appear as `knowledge__list_resources` and `knowledge__get_resource`.

## Development

```bash
cd mcps/Knowledge
npm install                 # also builds
ADC_DIR=/path/to/af-docs/docs API_KEY_1=dev npm start    # http://localhost:3001/mcp
npm run inspector
```

| Variable | Meaning |
| --- | --- |
| `ADC_DIR` | Directory scanned recursively for `*.md` files (image: `/app/AnalysisFacilities`) |
| `PORT` | Listen port (default `3001`) |

Plus the [common variables](../README.md#for-maintainers). The Dockerfile fetches af-docs from
`main`; build with `--build-arg AF_DOCS_REF=<sha>` to pin a version. Deployment:
[knowledge_mcp.yaml](../../deploy/mcps/knowledge_mcp.yaml).
