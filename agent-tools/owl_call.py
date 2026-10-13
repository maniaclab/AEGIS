#!/usr/bin/env python3
"""Call an OWL tool as a Keycloak service account, for agents that cannot do OAuth.

OpenClaw's MCP client cannot fetch client-credentials tokens, so an agent that should
submit knowledge runs this instead. The secret stays in an env file on the host; the
agent only ever sees tool results.

    owl_call.py owl_status
    owl_call.py submit_knowledge '{"text": "...", "title": "...", "source": "..."}'
    echo '{"handle": "...", "reject": [2]}' | owl_call.py confirm_submission

Arguments are a JSON object, given as the second argument or on stdin. Credentials come
from OWL_ENV_FILE (default ~/.config/owl-apprentice/owl.env) with OWL_MCP_URL,
OWL_TOKEN_URL, OWL_CLIENT_ID and OWL_CLIENT_SECRET. Exits 1 on any error.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ENV_KEYS = ("OWL_MCP_URL", "OWL_TOKEN_URL", "OWL_CLIENT_ID", "OWL_CLIENT_SECRET")
DEFAULT_ENV_FILE = "~/.config/owl-apprentice/owl.env"


def load_env():
    path = Path(os.environ.get("OWL_ENV_FILE", DEFAULT_ENV_FILE)).expanduser()
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip("'\"")
    missing = [k for k in ENV_KEYS if not env.get(k)]
    if missing:
        raise RuntimeError(f"{path}: missing {', '.join(missing)}")
    return env


def post(req, timeout):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} from {req.full_url}: {e.read()[:300].decode(errors='replace')}") from None


def token(env):
    data = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": env["OWL_CLIENT_ID"],
        "client_secret": env["OWL_CLIENT_SECRET"],
    }).encode()
    return post(urllib.request.Request(env["OWL_TOKEN_URL"], data=data), 30)["access_token"]


def call(env, tool, arguments):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": arguments}}).encode()
    reply = post(urllib.request.Request(env["OWL_MCP_URL"], data=body, headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token(env)}",
    }), 300)
    if "error" in reply:
        raise RuntimeError(json.dumps(reply["error"]))
    text = reply["result"]["content"][0]["text"]
    if text.startswith("Error:") or reply["result"].get("isError"):
        raise RuntimeError(text[:1000])
    return text


def main():
    if len(sys.argv) not in (2, 3) or sys.argv[1] in ("-h", "--help"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    tool = sys.argv[1]
    raw = sys.argv[2] if len(sys.argv) == 3 else ("" if sys.stdin.isatty() else sys.stdin.read())
    try:
        arguments = json.loads(raw) if raw.strip() else {}
        if not isinstance(arguments, dict):
            raise RuntimeError("arguments must be a JSON object")
        print(call(load_env(), tool, arguments))
    except Exception as e:  # noqa: BLE001 — one line on stderr is all the agent needs
        print(f"owl_call: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
