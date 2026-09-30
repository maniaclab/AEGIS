# Rucio MCP

Lets an assistant explore ATLAS data management in [Rucio](https://rucio.cern.ch): find
datasets and containers, list their files and replicas, inspect replication rules, storage
elements (RSEs), transfers, quotas and subscriptions. It runs the upstream
[rucio-mcp](https://github.com/kratsg/rucio-mcp) package in **read-only** mode: tools that
would change Rucio are present but return an error.

All callers share one Rucio identity, the grid proxy of the account the server runs with, so
results reflect that account's view of Rucio, not yours.

| | |
| --- | --- |
| Endpoint | `https://rucio.af.atlas-ml.org/mcp` (Streamable HTTP) |
| Auth | CERN login via OAuth (client ID `af-mcp`, scope `rucio-mcp`), or an AF MCP API key |

Clients set up earlier with the Rucio shared secret on `/site/atlas/` keep working; new
setups should use `/mcp` and one of the credentials above.

## Tools

Most list tools accept `limit` and `offset`. DIDs are written `scope:name`.

| Area | Tools |
| --- | --- |
| Connectivity | `rucio_ping`, `rucio_whoami`, `rucio_voms_proxy_info` (proxy identity and expiry) |
| Datasets and files (DIDs) | `rucio_list_dids` (`did_pattern`, `did_type`, `recursive`), `rucio_get_did`, `rucio_list_content`, `rucio_list_files`, `rucio_get_metadata`, `rucio_list_parent_dids` |
| Replicas | `rucio_list_replicas` (`dids`, `protocols`, `rse_expression`, …), `rucio_list_dataset_replicas`, `rucio_list_container_replicas` |
| Replication rules | `rucio_list_did_rules`, `rucio_list_replication_rules` (`scope`, `account`), `rucio_get_replication_rule` (`rule_id`), `rucio_list_rule_history` |
| Storage elements | `rucio_list_rses` (`rse_expression`), `rucio_get_rse`, `rucio_list_rse_attributes`, `rucio_get_rse_usage`, `rucio_get_rse_limits`, `rucio_get_rse_protocols`, `rucio_get_distance` (`source`, `destination`), `rucio_list_transfer_limits` |
| Transfers | `rucio_list_requests`, `rucio_list_requests_history` (`src_rse`, `dst_rse`, `request_states`) |
| Accounts and quotas | `rucio_list_accounts`, `rucio_get_account`, `rucio_get_local_account_usage`, `rucio_get_local_account_limits`, `rucio_list_account_rules` |
| Subscriptions | `rucio_list_subscriptions`, `rucio_list_subscription_rules` |
| Locks | `rucio_get_dataset_locks` (`did`), `rucio_get_dataset_locks_by_rse` (`rse`) |
| Scopes | `rucio_list_scopes`, `rucio_list_scopes_for_account` |
| Disabled (read-only mode) | `rucio_add_rule`, `rucio_delete_rule`, `rucio_update_rule`, `rucio_reduce_rule`, `rucio_move_rule`, `rucio_approve_rule`, `rucio_deny_rule` |

It also provides one resource, `rucio://nomenclature`: the ATLAS dataset naming conventions,
useful for building DID patterns.

## Connect

See [the shared connection guide](../README.md#connecting-a-client) for details and
troubleshooting.

### Claude Code

```bash
claude mcp add --transport http --scope user --client-id af-mcp --callback-port 8977 rucio https://rucio.af.atlas-ml.org/mcp
```

Leave the client secret empty, then `/mcp` → **rucio** → **Authenticate**.

### Claude Desktop and claude.ai

**Settings → Connectors → Add custom connector**, URL `https://rucio.af.atlas-ml.org/mcp`,
**Advanced settings → OAuth Client ID** `af-mcp`, secret empty, then **Connect**.

### ChatGPT

With Developer mode on, create a **New Plugin** with server URL
`https://rucio.af.atlas-ml.org/mcp` and authentication **OAuth**. Under **Advanced OAuth settings**:
registration method **User-Defined OAuth Client**, client ID `af-mcp`, secret empty, token
endpoint auth method **`none`**, scope `rucio-mcp`. Details in the
[connection guide](../README.md#chatgpt-web-and-desktop-app).

### VS Code

In `.vscode/mcp.json` or your user configuration; enter client ID `af-mcp` when asked:

```json
{
  "servers": {
    "rucio": { "type": "http", "url": "https://rucio.af.atlas-ml.org/mcp" }
  }
}
```

### OpenClaw

With the API key in `~/.openclaw/.env` as `AF_MCP_API_KEY`:

```bash
openclaw mcp set rucio '{"url":"https://rucio.af.atlas-ml.org/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${AF_MCP_API_KEY}"}}'
openclaw mcp probe rucio
```

Tools appear as `rucio__rucio_list_dids`, `rucio__rucio_list_replicas`, …

## Deployment

The pod runs two containers:

| Container | Image | Role |
| --- | --- | --- |
| `rucio-auth-proxy` | `mcp-server-rucio-proxy`, from [proxy/](proxy) | Public port 8000. Checks credentials with the same middleware as the other AF MCPs, serves the OAuth metadata, and forwards `/mcp` (and `/site/atlas/`) to rucio-mcp with the shared secret swapped in |
| `mcp-server-rucio` | `mcp-server-rucio`, this directory | Upstream `rucio-mcp` on `127.0.0.1:8001`, reachable only from inside the pod |

[scripts/start_rucio_mcp.sh](scripts/start_rucio_mcp.sh) waits for the grid proxy and then runs:

```bash
rucio-mcp serve --transport http --host 127.0.0.1 --port 8001 --site atlas \
  --auth-type x509_proxy --read-only --shared-secret "$RUCIO_MCP_TOKEN" --resource-url ...
```

| Setting | Container | Meaning |
| --- | --- | --- |
| `RUCIO_MCP_TOKEN` | both | Secret between proxy and rucio-mcp, still also accepted from clients; from the `rucio-mcp-token` secret |
| `UPSTREAM_URL` | proxy | Where to forward: `http://127.0.0.1:8001/site/atlas/` |
| `KEYCLOAK_AUDIENCE`, `MCP_RESOURCE_URL` | proxy | `rucio-mcp` and `https://rucio.af.atlas-ml.org/mcp`, plus the [common variables](../README.md#for-maintainers) |
| `X509_USER_PROXY`, `X509_CERT_DIR`, `RUCIO_CONFIG` | rucio-mcp | Grid proxy, CA certificates and `rucio.cfg`, mounted into the pod |

The proxy logs one line per request and per forwarded call. The rucio-mcp image is not
pinned to a package version, so a rebuild picks up upstream changes, including to the tool
list. Deployment: [rucio_mcp.yaml](../../deploy/mcps/rucio_mcp.yaml).

Per-user identity (each caller acting as their own Rucio account) would need one of
rucio-mcp's multi-user modes, its credential-broker or OIDC mode, instead of the shared
secret behind the proxy.
