# GGUS MCP

Lets an assistant work with the [GGUS](https://helpdesk.ggus.eu) grid helpdesk: search and
read tickets and their comments, open new tickets, comment on them and change their state.
It talks to the GGUS (Zammad) REST API with a single GGUS account's token, so everything it
creates or changes is recorded in GGUS as that account, whoever is asking.

| | |
| --- | --- |
| Endpoint | `https://ggus.af.atlas-ml.org/mcp` (Streamable HTTP) |
| Auth | CERN login via OAuth (client ID `af-mcp`, scope `ggus-mcp`), or an AF MCP API key |

## Tools

| Tool | What it does | Parameters | Changes GGUS |
| --- | --- | --- | --- |
| `list_my_tickets` | Tickets created by the GGUS account the server uses | `state`, `per_page` (1–100, default 25) | no |
| `list_tickets` | Search all tickets | `state`, `group`, `area`, `wlcg_sites`, `vo_support`, `per_page` | no |
| `get_ticket` | Full ticket, including GGUS-specific fields | `id` (the internal Zammad id, not the ticket number) | no |
| `get_ticket_articles` | All comments, notes and emails on a ticket | `ticket_id` | no |
| `create_ticket` | Open a new ticket | `title`, `group`, `body`, `wlcg_sites`, `vo_support`, `area` | **yes** |
| `add_comment` | Add a follow-up to a ticket | `ticket_id`, `body`, `internal` (hide from requester) | **yes** |
| `update_ticket_state` | Change a ticket's state, e.g. `solved`, `closed` | `id`, `state` | **yes** |

Search results return a summary per ticket: id, number, title, state, priority, area, WLCG
sites and last update. Use `get_ticket` for the rest.

## Connect

See [the shared connection guide](../README.md#connecting-a-client) for details and
troubleshooting.

### Claude Code

```bash
claude mcp add --transport http --scope user --client-id af-mcp --callback-port 8977 ggus https://ggus.af.atlas-ml.org/mcp
```

Leave the client secret empty, then `/mcp` → **ggus** → **Authenticate**.

### Claude Desktop and claude.ai

**Settings → Connectors → Add custom connector**, URL
`https://ggus.af.atlas-ml.org/mcp`, **Advanced settings → OAuth Client ID** `af-mcp`, secret
empty, then **Connect**.

### ChatGPT

With Developer mode on, create an app with server URL
`https://ggus.af.atlas-ml.org/mcp`, authentication **OAuth**, client ID `af-mcp`, secret empty.

### VS Code

In `.vscode/mcp.json` or your user configuration; enter client ID `af-mcp` when asked:

```json
{
  "servers": {
    "ggus": { "type": "http", "url": "https://ggus.af.atlas-ml.org/mcp" }
  }
}
```

### OpenClaw

With the API key in `~/.openclaw/.env` as `AF_MCP_API_KEY`:

```bash
openclaw mcp set ggus '{"url":"https://ggus.af.atlas-ml.org/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${AF_MCP_API_KEY}"}}'
openclaw mcp probe ggus
```

Tools appear as `ggus__list_tickets`, `ggus__get_ticket`, …

## Development

```bash
cd mcps/GGUS
npm install                 # also builds
GGUS_TOKEN=... API_KEY_1=dev npm start      # http://localhost:8000/mcp
npm run inspector           # MCP Inspector against the local build
```

| Variable | Meaning |
| --- | --- |
| `GGUS_TOKEN` | GGUS API token of the account the server acts as (from the `ggus-token` secret) |
| `PORT` | Listen port (default `8000`) |

Plus the [common variables](../README.md#for-maintainers) for auth and logging. Deployment:
[ggus_mcp.yaml](../../deploy/mcps/ggus_mcp.yaml).

### Logging

One timestamped line per event (`<ISO-8601 UTC> <LEVEL> <message>`): a correlated pair per
HTTP request, one per tool call and one per GGUS API call:

```text
2026-08-18T12:28:08.027Z INFO  req#7 --> POST /mcp ip=::1 mcp=tools/call tool=get_ticket
2026-08-18T12:28:08.031Z INFO  ggus GET /api/v1/tickets/12345?expand=true 200 3.1ms
2026-08-18T12:28:08.037Z INFO  tool get_ticket ok 6.2ms args={"id":12345}
2026-08-18T12:28:08.042Z INFO  req#7 <-- 200 15.0ms
```

Rejected requests and client disconnects log as `WARN`, failed tool calls and `5xx` as
`ERROR`. `LOG_LEVEL=debug` also logs request bodies, which may contain ticket contents, so
keep production at `info`.
