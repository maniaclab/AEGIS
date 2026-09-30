# CRIC MCP

Lets an assistant look up ATLAS computing topology and status in
[CRIC](https://atlas-cric.cern.ch): sites, PanDA queues and DDM (storage) endpoints. All
tools are read-only. The server queries the CRIC JSON API with a grid x509 proxy that is
renewed in the cluster, so callers need no grid credentials of their own.

| | |
| --- | --- |
| Endpoint | `https://cric.af.atlas-ml.org/mcp` (Streamable HTTP) |
| Auth | CERN login via OAuth (client ID `af-mcp`, scope `cric-mcp`), or an AF MCP API key |

## Tools

All tools return CRIC's JSON as-is and all filters are optional; with none you get
everything, which can be large.

| Tool | What it does | Filters |
| --- | --- | --- |
| `list_rc_sites` | ATLAS resource-centre sites | `name` (e.g. `AGLT2`), `status` (`online`, `offline`), `state` (`ACTIVE`) |
| `list_panda_queues` | PanDA queues and their configuration | `name` (e.g. `AGLT2_TEST`), `state`, `status` |
| `list_queue_statuses` | Current PanDA queue statuses | `pandaqueue`, `state` (`ACTIVE`, `INACTIVE`, `DISABLED`, `DELETED`, `ANY`), `status` (`TEST`, `ONLINE`, `OFFLINE`) |
| `list_panda_queue_tags` | Tags attached to PanDA queues | `panda_queue` |
| `list_ddm_endpoint_statuses` | DDM endpoint (storage) statuses | `ddmendpoint` (e.g. `AGLT2_DATADISK`) |

## Connect

See [the shared connection guide](../README.md#connecting-a-client) for details and
troubleshooting.

### Claude Code

```bash
claude mcp add --transport http --scope user --client-id af-mcp --callback-port 8977 cric https://cric.af.atlas-ml.org/mcp
```

Leave the client secret empty, then `/mcp` → **cric** → **Authenticate**.

### Claude Desktop and claude.ai

**Settings → Connectors → Add custom connector**, URL
`https://cric.af.atlas-ml.org/mcp`, **Advanced settings → OAuth Client ID** `af-mcp`, secret
empty, then **Connect**.

### ChatGPT

With Developer mode on, create an app with server URL
`https://cric.af.atlas-ml.org/mcp`, authentication **OAuth**, client ID `af-mcp`, secret empty.

### VS Code

In `.vscode/mcp.json` or your user configuration; enter client ID `af-mcp` when asked:

```json
{
  "servers": {
    "cric": { "type": "http", "url": "https://cric.af.atlas-ml.org/mcp" }
  }
}
```

### OpenClaw

With the API key in `~/.openclaw/.env` as `AF_MCP_API_KEY`:

```bash
openclaw mcp set cric '{"url":"https://cric.af.atlas-ml.org/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${AF_MCP_API_KEY}"}}'
openclaw mcp probe cric
```

Tools appear as `cric__list_rc_sites`, `cric__list_panda_queues`, …

## Development

```bash
cd mcps/CRIC
npm install                 # also builds
X509_USER_PROXY=/tmp/x509up_u$(id -u) X509_CERT_DIR=/etc/grid-security/certificates API_KEY_1=dev npm start
npm run inspector
```

| Variable | Meaning |
| --- | --- |
| `X509_USER_PROXY` | Grid proxy used as the client certificate towards CRIC |
| `X509_CERT_DIR` | Directory of CA certificates (`*.pem`, `*.crt`) |
| `PORT` | Listen port (default `8000`) |

Plus the [common variables](../README.md#for-maintainers). In the container,
`scripts/start_cric_mcp.sh` waits until the proxy exists before starting; the proxy itself is
renewed by the cluster's x509 job. Deployment: [cric_mcp.yaml](../../deploy/mcps/cric_mcp.yaml).
Logs follow the [shared convention](../README.md#for-maintainers), with one line per CRIC API
call.
