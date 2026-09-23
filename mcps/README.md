# General MCP instructions

## Using inspector to test an MCP

* globally install inspector

``` bash
npm install -g @modelcontextprotocol/inspector
```

* to run it do eg.:

```bash
npx @modelcontextprotocol/inspector
```

Use deployed MCP, add to your mcp.json or tell your agent to use:

```json
"ES_MCP_REMOTE": {
    "url": "https://es.af.atlas-ml.org/mcp",
    "type": "http",
    "headers": {
        "Authorization": "Bearer ASDF"
    }
},
```

Simplest test

``` bash
curl -X POST https://executor.af.atlas-ml.org/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer ASDF' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

``` bash
mcp-inspector.cmd # configure mcp server manually.
mcp-inspector --config .vscode/mcp.json --server ES_MCP_REMOTE
mcp-inspector --config .vscode/mcp.json --server EXEC_MCP_REMOTE 
mcp-inspector --config .vscode/mcp.json --server KNOWLEDGE_MCP 
```

## Using MCPs in Claude

In Claude **desktop**, go to "Settings > Developer > Edit Config".

That will open a json file for you to edit. Add your MCP server details like this:

```json
{
  "mcpServers": {
    "ES_MCP_REMOTE": {
      "command": "npx",
      "args": [
        "mcp-remote@latest",
        "https://es.af.atlas-ml.org/mcp",
        "--header",
        "Authorization: Bearer ASDF"
      ]
    }
  }
}
```
