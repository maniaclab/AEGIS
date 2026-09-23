# Sparks setup

## adding packages and plugings

### for traces diagnostics do

```bash
openclaw plugins install @openclaw/diagnostics-otel
```

## vLLM and OpenWebUI

```bash
docker compose --profile spark1 up -d
docker compose --profile spark2 up -d
```

to test:

### List available models

```bash
curl http://localhost:8000/v1/models
```

### Send a chat completion request

**Spark 1 (nano-30b):**

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nano-30b",
    "messages": [{"role": "user", "content": "Hello, what model are you?"}],
    "max_tokens": 640
  }'
```

**Spark 2 (qwen3.6-35b):**

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.6-35b",
    "messages": [{"role": "user", "content": "Hello, what model are you?"}],
    "max_tokens": 640
  }' 
```

## Crons

Spark2 runs a single cronjob:
0 2 * * * openclaw backup create --output ~/Backups

It just runs regular openclaw local backup (a backup archive for config, credentials, sessions, and workspaces)

## Remote access

to install tailgate run:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```