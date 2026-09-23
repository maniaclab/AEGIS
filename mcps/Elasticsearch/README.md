# Deployment of the official ES MCP to expose UC ES data

*Transport Type:* Streamable HTTP
*URL:* <http://localhost:3200/mcp>

inspect
    npx run inspector

start
    npx run start

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

## TODO

update to new way to add tools (registerTool) like done in Executor.
