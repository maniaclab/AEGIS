# AF MCP servers

These MCP servers give AI assistants (Claude, ChatGPT, VS Code Copilot, OpenClaw, …) access to
the ATLAS Analysis Facility and the grid services around it. Each one runs in the AF
Kubernetes cluster and is reachable over HTTPS using the MCP **Streamable HTTP** transport.

| Server | What it gives the assistant | Endpoint | Docs |
| --- | --- | --- | --- |
| CRIC | ATLAS CRIC: sites, PanDA queues, DDM endpoints and their statuses | `https://cric.af.atlas-ml.org/mcp` | [CRIC](CRIC/README.md) |
| Elasticsearch | Search the UChicago AF Elasticsearch indices | `https://es.af.atlas-ml.org/mcp` | [Elasticsearch](Elasticsearch/README.md) |
| GGUS | Read, create and update GGUS helpdesk tickets | `https://ggus.af.atlas-ml.org/mcp` | [GGUS](GGUS/README.md) |
| Knowledge | The USATLAS Analysis Facility documentation | `https://knowledge.af.atlas-ml.org/mcp` | [Knowledge](Knowledge/README.md) |
| Executor | Run shell commands on AF login nodes over SSH | `https://executor.af.atlas-ml.org/mcp` | [Executor](Executor/README.md) |
| OWL | The ATLAS AI Librarian: curated, cited knowledge (early phase) | `https://owl.af.atlas-ml.org/mcp` | [OWL](OWL/README.md) |
| Rucio | ATLAS Rucio: datasets, replicas, rules, RSEs | `https://rucio.af.atlas-ml.org/site/atlas/` | [Rucio](Rucio/README.md) |

Each server's README lists its tools and has copy-paste setup for every client below.

---

## How authentication works

Every server except Rucio accepts either of two credentials:

| | Sign in with CERN (OAuth) | API key |
| --- | --- | --- |
| Who it is for | People using Claude, ChatGPT or VS Code interactively | Agents and scripts that run unattended, such as OpenClaw or cron jobs |
| What you do | Add the server, then log in once in the browser with your CERN account | Send `Authorization: Bearer <API key>` on every request |
| Identifies | You personally | A trusted service, not a person |
| Getting access | Be in the ATLAS e-group allowed to use the AF platform | Ask the AF MCP maintainers for a key |

OAuth goes through the AF-platform Keycloak (`keycloak-prod.tempest.uchicago.edu`, realm
`AF-platform`) and on to CERN SSO. Clients must use the pre-registered client ID **`af-mcp`**
with an **empty client secret**: the AF Keycloak does not let clients register themselves.

One API key works for all of these servers except Rucio, which has its own shared secret.
Treat either like a password: keep it in an environment variable or your client's secret
store, never in a file you commit.

When a request has no valid credential the server answers `401` with a `WWW-Authenticate`
header pointing at its OAuth metadata (`/.well-known/oauth-protected-resource/mcp`). This is
how OAuth-capable clients discover where to send you to log in.

---

## Connecting a client

The per-server READMEs have these filled in. Replace `<name>` and `<url>` with the values
from the table above.

### Claude Code

Sign in with CERN:

```bash
claude mcp add --transport http --scope user --client-id af-mcp --callback-port 8977 <name> <url>
```

Press Enter at the client-secret prompt. Then start `claude`, run `/mcp`, pick the server
and choose **Authenticate**; a browser window opens for the CERN login.
Keep `--callback-port 8977`: it is the only local callback address the AF Keycloak accepts.

With an API key instead:

```bash
claude mcp add --transport http --scope user <name> <url> --header "Authorization: Bearer $AF_MCP_API_KEY"
```

### Claude Desktop and claude.ai

Connectors are shared between Claude Desktop and claude.ai.

1. **Settings → Connectors → Add custom connector**.
2. Name: `<name>`. URL: `<url>`.
3. Open **Advanced settings**, set **OAuth Client ID** to `af-mcp` and leave
   **OAuth Client Secret** empty.
4. **Add**, then **Connect** and log in with CERN.

Custom connectors cannot send a static API key. To use a key in Claude Desktop, add the
server to its config file (**Settings → Developer → Edit Config**) through the `mcp-remote`
bridge, which needs Node.js:

```json
{
  "mcpServers": {
    "<name>": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "<url>", "--header", "Authorization: Bearer ${AF_MCP_API_KEY}"],
      "env": { "AF_MCP_API_KEY": "<API key>" }
    }
  }
}
```

### ChatGPT (web and desktop app)

Requires a Plus, Pro, Business, Enterprise or Education plan; on workspace plans an admin
must allow custom MCP connectors. Set it up on chatgpt.com; the desktop app uses the same
account.

1. **Settings → Security and login**, turn on **Developer mode**.
2. Create a new app for a remote MCP server: name `<name>`, server URL `<url>`.
3. Authentication: **OAuth**. OAuth Client ID `af-mcp`, client secret empty.
4. Connect and log in with CERN.

ChatGPT supports OAuth only; it cannot send an API key.

### VS Code (GitHub Copilot agent mode)

Add the server to `.vscode/mcp.json` in a workspace, or to your user configuration with
**MCP: Open User Configuration**:

```json
{
  "servers": {
    "<name>": { "type": "http", "url": "<url>" }
  }
}
```

Start the server from the file or from the **MCP: List Servers** command. VS Code asks you to
log in; because dynamic registration is not available it then asks for a client ID: enter
`af-mcp` and leave the secret empty.

With an API key instead, let VS Code prompt for it once and store it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "af-mcp-api-key", "description": "AF MCP API key", "password": true }
  ],
  "servers": {
    "<name>": {
      "type": "http",
      "url": "<url>",
      "headers": { "Authorization": "Bearer ${input:af-mcp-api-key}" }
    }
  }
}
```

### OpenClaw

OpenClaw only supports OAuth through dynamic client registration, which the AF Keycloak does
not offer, so use an API key. Put it in `~/.openclaw/.env`:

```bash
AF_MCP_API_KEY=<API key>
```

and register the server, keeping the single quotes so your shell does not expand `${...}`:

```bash
openclaw mcp set <name> '{"url":"<url>","transport":"streamable-http","headers":{"Authorization":"Bearer ${AF_MCP_API_KEY}"}}'
openclaw mcp probe <name>
```

Set `transport` explicitly (OpenClaw otherwise assumes SSE) and do not set `auth: "oauth"`,
which makes OpenClaw ignore the `Authorization` header. Tools appear to agents as
`<name>__<tool>`, e.g. `ggus__get_ticket`; restrict them per agent with the agent's
`tools.allow` / `tools.deny` policy.

---

## Testing a server

```bash
curl -s https://ggus.af.atlas-ml.org/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $AF_MCP_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Or interactively with the MCP Inspector (`npx @modelcontextprotocol/inspector`): choose
transport **Streamable HTTP**, enter the URL, and add an `Authorization: Bearer …` header.

| Symptom | Likely cause |
| --- | --- |
| `401` with `error="invalid_token"` | Wrong or expired key/token, or a token issued for a different server |
| Keycloak says `Invalid parameter: redirect_uri` | The client is using a callback not registered on `af-mcp` (for Claude Code: missing `--callback-port 8977`) |
| Keycloak says `invalid_scope` | The server's scope is not attached to the `af-mcp` client |
| CERN login refused | Your account is not in the ATLAS e-group allowed to use the AF platform |

---

## For maintainers

All servers except Rucio share the same auth middleware (`authMiddleware.ts`) and logging
convention (`logger.ts`: one timestamped line per request, tool call and upstream call;
`LOG_LEVEL=debug` adds request bodies). OWL extends the middleware with identity resolution.

Common environment variables:

| Variable | Meaning |
| --- | --- |
| `API_KEY_1`, `API_KEY_2` | Accepted API keys, from the `mcp-keys` secret |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM` | Token issuer, from the `keycloak-config` ConfigMap |
| `KEYCLOAK_AUDIENCE` | Audience a token must carry; set per server in its deployment (e.g. `ggus-mcp`) |
| `MCP_RESOURCE_URL` | Public URL of `/mcp`; enables OAuth discovery |
| `MCP_OAUTH_SCOPE` | Keycloak scope advertised to clients; defaults to `KEYCLOAK_AUDIENCE` |
| `LOG_LEVEL` | `debug`, `info` (default), `warn` or `error` |
| `PORT` | Listen port |

Adding OAuth to a new server takes a Keycloak client scope named like its audience, with an
Audience mapper, attached to `af-mcp` (Optional) and to `af-platform-cli` (Default) if the AF
chatbot should reach it.

Images are built by [mcp_builder.yaml](../.github/workflows/mcp_builder.yaml) on every push
to `main`; manifests live in [deploy/mcps](../deploy/mcps).
