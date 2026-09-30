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
| Endpoint | `https://rucio.af.atlas-ml.org/site/atlas/` (Streamable HTTP; note: not `/mcp`) |
| Auth | Rucio MCP shared secret as `Authorization: Bearer <secret>`. OAuth / CERN login is **not** supported |

The shared secret is separate from the AF MCP API key used by the other servers; ask the AF
MCP maintainers for it.

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

Because this server only takes a bearer secret, every client uses the header form. In the
examples the secret is in the environment variable `RUCIO_MCP_TOKEN`.
See [the shared connection guide](../README.md#connecting-a-client) for more on each client.

### Claude Code

```bash
claude mcp add --transport http --scope user rucio https://rucio.af.atlas-ml.org/site/atlas/ --header "Authorization: Bearer $RUCIO_MCP_TOKEN"
```

### Claude Desktop

Custom connectors (**Settings → Connectors**) cannot send a static secret, so add it to the
config file instead (**Settings → Developer → Edit Config**; needs Node.js). This does not
carry over to claude.ai.

```json
{
  "mcpServers": {
    "rucio": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://rucio.af.atlas-ml.org/site/atlas/", "--header", "Authorization: Bearer ${RUCIO_MCP_TOKEN}"],
      "env": { "RUCIO_MCP_TOKEN": "<shared secret>" }
    }
  }
}
```

### ChatGPT

Not supported: ChatGPT connectors only authenticate with OAuth.

### VS Code

```json
{
  "inputs": [
    { "type": "promptString", "id": "rucio-mcp-token", "description": "Rucio MCP shared secret", "password": true }
  ],
  "servers": {
    "rucio": {
      "type": "http",
      "url": "https://rucio.af.atlas-ml.org/site/atlas/",
      "headers": { "Authorization": "Bearer ${input:rucio-mcp-token}" }
    }
  }
}
```

### OpenClaw

With `RUCIO_MCP_TOKEN=<shared secret>` in `~/.openclaw/.env`:

```bash
openclaw mcp set rucio '{"url":"https://rucio.af.atlas-ml.org/site/atlas/","transport":"streamable-http","headers":{"Authorization":"Bearer ${RUCIO_MCP_TOKEN}"}}'
openclaw mcp probe rucio
```

Tools appear as `rucio__rucio_list_dids`, `rucio__rucio_list_replicas`, …

## Deployment

The image `pip install`s `rucio-mcp` and `rucio-clients`; there is no code of ours beyond
[scripts/start_rucio_mcp.sh](scripts/start_rucio_mcp.sh), which waits for the grid proxy and
then runs:

```bash
rucio-mcp serve --transport http --host 0.0.0.0 --port 8000 --site atlas \
  --auth-type x509_proxy --read-only --shared-secret "$RUCIO_MCP_TOKEN" --resource-url ...
```

| Setting | Source |
| --- | --- |
| `RUCIO_MCP_TOKEN` | Shared secret clients must send, from the `rucio-mcp-token` secret |
| `X509_USER_PROXY`, `X509_CERT_DIR` | Grid proxy and CA certificates, mounted into the pod |
| `RUCIO_CONFIG` | `rucio.cfg`, from the `rucio-config` ConfigMap |

`GET /healthz` answers `ok` without auth. The image is not pinned to a `rucio-mcp` version,
so a rebuild picks up upstream changes, including to the tool list. Deployment:
[rucio_mcp.yaml](../../deploy/mcps/rucio_mcp.yaml).

Per-user identity (each caller acting as their own Rucio account) would need one of
rucio-mcp's multi-user modes, its credential-broker or OIDC mode, instead of the shared
secret.
