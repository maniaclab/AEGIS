# Agent tools

Small helpers that OpenClaw agents run through their exec tool.

## owl_call.py — submit knowledge to OWL

OpenClaw's MCP client can't fetch Keycloak client-credentials tokens, so an agent that should
*add* knowledge to [OWL](../mcps/OWL/README.md) calls it through this script instead. Reads
can stay on the agent's normal OWL MCP connection (API key, read-only).

`owl_call.py` logs in as a Keycloak service-account client and calls one OWL tool. The
client secret stays in an env file on the host and the agent never sees it. The client's
identity, `svc:kc:<client id>`, must be on `OWL_SUBMIT_SERVICES` in
[owl-config.yaml](../deploy/base/owl-config.yaml). Everything it submits is quarantined
until a trusted writer confirms it.

### Setup on spark-2 (agent `apprentice`)

The Keycloak client is `owl-apprentice` in realm `AF-platform`. It needs client
authentication on, service accounts on, all other flows off, and the `owl-mcp` client scope
as a Default scope.

```bash
install -D -m 755 agent-tools/owl_call.py ~/.local/bin/owl-call

mkdir -p ~/.config/owl-apprentice && chmod 700 ~/.config/owl-apprentice
cat > ~/.config/owl-apprentice/owl.env <<'ENV'
OWL_MCP_URL=https://owl.af.atlas-ml.org/mcp
OWL_TOKEN_URL=https://keycloak-prod.tempest.uchicago.edu/realms/AF-platform/protocol/openid-connect/token
OWL_CLIENT_ID=owl-apprentice
OWL_CLIENT_SECRET=...
ENV
chmod 600 ~/.config/owl-apprentice/owl.env

owl-call owl_status   # expect svc:kc:owl-apprentice, can_submit: true, trusted: false
```

Never put the secret in the agent's workspace. Workspaces are exported to the
`aegis-agents` repo, and `MEMORY.md` is submitted to OWL.

For another agent, give it its own Keycloak client and env file and set
`OWL_ENV_FILE=/path/to/owl.env`.

### Telling the agent

Add something like this to the agent's `TOOLS.md`:

````markdown
## Adding knowledge to OWL

Search OWL with its MCP tools. To *add* knowledge, run `owl-call` (arguments are one JSON
object, as an argument or on stdin):

1. `owl-call submit_knowledge '{"text": "...", "title": "...", "source": "<URL or thread>"}'`
   OWL returns the claims it extracted and a `handle`. Nothing is stored yet.
2. Check the claims. Then `owl-call confirm_submission '{"handle": "..."}'`, optionally with
   `"reject": [idx, ...]` or `"edits": [{"idx": 0, "text": "..."}]`, or `"reject_all": true`.

For a whole document, use `owl-call submit_document '{"content": "...", "title": "..."}'` and
then poll `owl-call get_job '{"job_id": "..."}'`.

What you add is quarantined until a person confirms it. Submit only facts you verified.
Write each fact so it makes sense on its own, and always give a `source`.
````
