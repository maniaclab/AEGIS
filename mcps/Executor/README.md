# Executor MCP

Lets an assistant run shell commands on Analysis Facility login nodes, for example to check
batch jobs, inspect files or run a diagnostic script. It connects over SSH as the shared
`assistant` account with a key held by the server, so commands run with that account's
permissions, not yours.

> **Powerful tool.** The assistant can run any command the `assistant` account can. Keep your
> client's tool-approval prompts on for this server, and only connect it where you want
> that.

| | |
| --- | --- |
| Endpoint | `https://executor.af.atlas-ml.org/mcp` (Streamable HTTP) |
| Auth | CERN login via OAuth (client ID `af-mcp`, scope `executor-mcp`), or an AF MCP API key |

## Tools

| Tool | What it does | Parameters |
| --- | --- | --- |
| `execute_shell_command` | Run one command over SSH and return its stdout and stderr | `shellCommand`; `loginNode`: hostname of the login node to run on |

Connecting times out after 30 s, and a command is abandoned after 120 s. There is no
interactive input or persistent shell: each call is a fresh SSH session.

## Connect

See [the shared connection guide](../README.md#connecting-a-client) for details and
troubleshooting.

### Claude Code

```bash
claude mcp add --transport http --scope user --client-id af-mcp --callback-port 8977 executor https://executor.af.atlas-ml.org/mcp
```

Leave the client secret empty, then `/mcp` → **executor** → **Authenticate**.

### Claude Desktop and claude.ai

**Settings → Connectors → Add custom connector**, URL
`https://executor.af.atlas-ml.org/mcp`, **Advanced settings → OAuth Client ID** `af-mcp`,
secret empty, then **Connect**.

### ChatGPT

With Developer mode on, create a **New Plugin** with server URL
`https://executor.af.atlas-ml.org/mcp` and authentication **OAuth**. Under **Advanced OAuth settings**:
registration method **User-Defined OAuth Client**, client ID `af-mcp`, secret empty, token
endpoint auth method **`none`**, scope `executor-mcp`. Details in the
[connection guide](../README.md#chatgpt-web-and-desktop-app).

### VS Code

In `.vscode/mcp.json` or your user configuration; enter client ID `af-mcp` when asked:

```json
{
  "servers": {
    "executor": { "type": "http", "url": "https://executor.af.atlas-ml.org/mcp" }
  }
}
```

### OpenClaw

With the API key in `~/.openclaw/.env` as `AF_MCP_API_KEY`:

```bash
openclaw mcp set executor '{"url":"https://executor.af.atlas-ml.org/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${AF_MCP_API_KEY}"}}'
openclaw mcp probe executor
```

The tool appears as `executor__execute_shell_command`. Consider allowing it only for the
agents that need it (`tools.allow` / `tools.deny` in the agent's config).

## Development

```bash
cd mcps/Executor
npm install                 # also builds
ASSISTANT_SSH_KEY="$(cat ~/.ssh/assistant_key)" API_KEY_1=dev npm start    # http://localhost:3000/mcp
npm run inspector
```

| Variable | Meaning |
| --- | --- |
| `ASSISTANT_SSH_KEY` | Private key for the `assistant` account (from the `af-ssh-key` secret) |
| `PORT` | Listen port (default `3000`) |

Plus the [common variables](../README.md#for-maintainers). Every command and its target host
are logged at `info`; command output only at `debug`. Deployment:
[executor_mcp.yaml](../../deploy/mcps/executor_mcp.yaml).
