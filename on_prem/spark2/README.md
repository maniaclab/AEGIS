# Sparks setup

## Host configuration (Ansible)

spark-2 is managed by Ansible from the private repo
[maniaclab/spark-ansible](https://github.com/maniaclab/spark-ansible). It covers vLLM
(`/srv/vllm`), Tailscale Serve forwards, the pinned OpenClaw version and gateway drop-in,
Node/uv, hardening, and the daily Hindsight backup timer. That repo's README lists what it
deliberately does **not** manage (`openclaw.json`, the gateway unit, the secret store) and
has the rebuild-from-scratch runbook.

The control node is WSL on Ilija's laptop, with the checkout at `~/spark-ansible` (keep it
in the WSL home, not under `/mnt/c`) and the vault password in `~/.vault_pass_spark-ansible`:

```bash
cd ~/spark-ansible
ansible-playbook playbooks/site.yml --check --diff -K   # always first
ansible-playbook playbooks/site.yml --diff -K           # apply
```

The `docker-compose.yaml` in this directory is the original shared spark1/spark2 file.
spark-2 now gets its compose file from the `vllm` role, so change vLLM settings there.

## Adding packages and plugins

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

To install Tailscale, run:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

## Secrets

To store a secret in secret store:

```bash
echo "somesecret" | openclaw secrets store set OPENCLAW_GATEWAY_TOKEN --kind secret
```

To list secrets:

```bash
openclaw secrets store list
```

