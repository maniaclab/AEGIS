# GGUS MCP

## Logging

Every request is logged to stdout as a single timestamped line
(`<ISO-8601 UTC> <LEVEL> <message>`), so container logs can be grepped or shipped as-is.

Each incoming HTTP request produces a correlated pair of lines, plus a line per
tool invocation and per outbound GGUS API call:

```
2026-08-18T12:28:08.027Z INFO  req#7 --> POST /mcp ip=::1 mcp=tools/call tool=get_ticket
2026-08-18T12:28:08.031Z INFO  ggus GET /api/v1/tickets/12345?expand=true 200 3.1ms
2026-08-18T12:28:08.037Z INFO  tool get_ticket ok 6.2ms args={"id":12345}
2026-08-18T12:28:08.042Z INFO  req#7 <-- 200 15.0ms
```

Rejected requests (`401`/`403`) and client disconnects are logged as `WARN`;
failed tool calls and `5xx` responses as `ERROR`.

`LOG_LEVEL` (`debug` | `info` | `warn` | `error`, default `info`) controls verbosity.
At `debug`, full request bodies and successful authentications are logged too — note
that request bodies may contain ticket contents, so keep production at `info`.
