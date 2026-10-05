# OpenClaw agent export

Copies each OpenClaw agent's definition and curated memory out of `~/.openclaw` into a git
repo as plain files, so they can be read, diffed, reviewed and loaded into other runtimes.
This complements OpenClaw's own backups, which store database rows (git backup) or encrypted
archives, and restore only into OpenClaw.

## What is exported

The agent list comes from `agents.entries` in `openclaw.json`. Per agent, under
`agents/<id>/`:

| Path | Contents |
| --- | --- |
| `agent.json` | The agent's config entry (model, tools, subagents), with secrets redacted |
| `cron.json` | Its cron jobs and heartbeats from `openclaw cron list --all --json`, without run state |
| `workspace/` | `*.md` (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, …), `memory/*.md`, `.learnings/`, `skills/`, small scripts and JSON |
| `workshop-skills/` | Skills the agent wrote itself and that were applied through skill-workshop, from `<agentDir>/workshop-skills` (nothing else from `agentDir`, which holds auth profiles) |

Shared across agents, under `shared/`: `agent-defaults.json`, `mcp.json`, `skills/` (from
`~/.openclaw/skills`) and `skill-proposals/` (every skill-workshop `PROPOSAL.md`, applied or
pending; omitted with `--public`). Plugin-bundled skills (`~/.openclaw/plugin-skills`) are not
exported, since reinstalling the plugin restores them.

Never exported: dreaming output (`DREAMS.md`, `memory/dreaming/`, `memory/.dreams/`, unless
`--include-dreams`), `media/`, images, databases, `.env` and key files, and anything over 1 MB.

## Safety

- JSON values under keys such as `token`, `apiKey`, `Authorization` or `password` become
  `<redacted>`. SecretRefs and `${VAR}` placeholders are kept, since they contain no secret.
- Before committing, every exported file is scanned for API keys, Slack/GitHub/GitLab tokens,
  AWS key IDs, private keys and bearer tokens, and with `gitleaks` too when it is installed.
  Any hit aborts the run and prints only the file, line and kind of secret.
- Memory files name people, hosts and incidents, so export to a **private** repo. `--public`
  limits the export to definitions (persona, skills, config, cron) for a public repo.

## Review flow

Each run rebuilds the export from `origin/main`, force-pushes it to the `export` branch and
opens a pull request, or updates the one already open. Merging the PR accepts what the agents
learned. Deleting a line before merging corrects them, but only in the export: fix the agent's
own workspace too, or the next run brings the line back.

## Run it

On the OpenClaw gateway host:

```bash
git clone git@github.com:maniaclab/aegis-agents.git ~/aegis-agents
python3 export_agents.py --repo ~/aegis-agents --dry-run   # writes files, no git
python3 export_agents.py --repo ~/aegis-agents             # commit, push, open PR
```

To run it daily, install the units in this directory:

```bash
mkdir -p ~/.config/systemd/user
cp openclaw-export.service openclaw-export.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now openclaw-export.timer
```

The host needs `git` with push access to the repo (a deploy key with write access works), and
`gh` logged in to open the PR. Without `gh` the branch is still pushed.
