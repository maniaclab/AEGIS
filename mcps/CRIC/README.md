# CRIC MCP

Exposes important ATLAS CRIC json resources. 
It includes code to renew x509 proxy.

*Transport Type:* Streamable HTTP
*URL:* <http://localhost:3200/mcp>

Use mcp inspector:
``` bash
npx @modelcontextprotocol/inspector
```
Use deployed MCP, add to your mcp.json or tell your agent to use:

```json
"CRIC_MCP_REMOTE": {
            "url": "https://cric.af.atlas-ml.org/mcp",
            "type": "http",
            "headers": {
                "Authorization": "Bearer ASDF"
            }
        },
```
