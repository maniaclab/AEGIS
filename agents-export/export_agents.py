#!/usr/bin/env python3
"""Export OpenClaw agent definitions and curated memory into a git repo as plain files.

Reads the agent list from openclaw.json, copies an allowlist of human-readable files from
each agent's workspace, adds redacted agent config and cron jobs, refuses to continue if
anything looks like a secret, then force-pushes the result to an `export` branch and opens
(or refreshes) a pull request against main. Merging that PR is the review step.

With --owl-agents, each listed agent's MEMORY.md that changed in this export is then
submitted to OWL as `agent-memory`, where its claims land in quarantine for review. OWL
credentials come from the environment (see OWL_ENV); without them the step is skipped.

Usage:
    export_agents.py --repo ~/aegis-agents [--openclaw-home ~/.openclaw]
                     [--include-dreams] [--no-push] [--dry-run]
                     [--owl-agents networker,rodbot] [--owl-all]
"""

import argparse
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

MAX_FILE_BYTES = 1_000_000

# Files copied from a workspace, matched against the path relative to the workspace root.
INCLUDE = [
    "*.md",
    "*.json",
    "*.mjs", "*.js", "*.py", "*.sh",
    "memory/*.md", "memory/*.json",
    ".learnings/*.md",
    "skills/**",
    "config/*.json",
]
# Checked before INCLUDE; any match drops the file.
EXCLUDE = [
    "media/**", ".openclaw/**", ".git/**",
    "skills/**/.clawhub/**",
    "*.png", "*.jpg", "*.jpeg", "*.gif", "*.pdf", "*.sqlite", "*.db",
    ".env", "*.env", "*.key", "*.pem",
]
DREAMS = ["DREAMS.md", "memory/dreaming/**", "memory/.dreams/**"]
# Learned or operational state, dropped with --public: it names people, hosts and incidents.
PRIVATE = [
    "USER.md", "MEMORY.md", "memory/**", ".learnings/**",
    "*.json", "config/**", "notification.txt",
]

SECRET_KEY = re.compile(
    r"(token|secret|password|passphrase|api[-_]?key|authorization|cookie|credential|private[-_]?key)",
    re.I,
)
CRON_RUNTIME_KEYS = {
    "state", "status", "createdAtMs", "updatedAtMs", "configRevision", "deliverySuppressionReason",
}
PLACEHOLDER = re.compile(r"(Bearer\s+)?\$\{[A-Za-z0-9_]+\}")
SECRET_VALUE = {
    "anthropic-key": re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    "openai-key": re.compile(r"sk-(proj-)?[A-Za-z0-9_-]{32,}"),
    "slack-token": re.compile(r"xox[abposr]-[0-9A-Za-z-]{10,}"),
    "github-token": re.compile(r"(ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}"),
    "gitlab-token": re.compile(r"glpat-[A-Za-z0-9_-]{20,}"),
    "aws-key-id": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "private-key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "bearer": re.compile(r"Bearer\s+[A-Za-z0-9._~+/-]{24,}"),
}


def matches(rel, patterns):
    # fnmatch's "*" already crosses "/", so "skills/**" means "anything under skills/".
    return any(fnmatch.fnmatchcase(rel, p) for p in patterns)


def redact(obj):
    """Replace literal string values under secret-looking keys. SecretRef objects and
    ${VAR} placeholders are kept, since they name a secret without containing it."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if SECRET_KEY.search(k) and isinstance(v, str) and not PLACEHOLDER.fullmatch(v):
                out[k] = "<redacted>"
            else:
                out[k] = redact(v)
        return out
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    return obj


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def copy_workspace(ws, dest, include_dreams, public):
    excluded = EXCLUDE + ([] if include_dreams else DREAMS) + (PRIVATE if public else [])
    copied = skipped_large = 0
    for src in sorted(ws.rglob("*")):
        if not src.is_file() or src.is_symlink():
            continue
        rel = src.relative_to(ws).as_posix()
        if matches(rel, excluded) or not matches(rel, INCLUDE):
            continue
        if src.stat().st_size > MAX_FILE_BYTES:
            skipped_large += 1
            print(f"  skip (>{MAX_FILE_BYTES} bytes): {rel}", file=sys.stderr)
            continue
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        if src.suffix == ".json":
            # Config-like JSON (e.g. config/mcporter.json) may embed credentials.
            try:
                write_json(out, redact(json.loads(src.read_text(encoding="utf-8"))))
                copied += 1
                continue
            except (ValueError, UnicodeDecodeError):
                pass
        shutil.copy2(src, out)
        copied += 1
    return copied, skipped_large


def export_cron(openclaw_bin, agents_dir):
    try:
        res = subprocess.run(
            [openclaw_bin, "cron", "list", "--all", "--json"],
            capture_output=True, text=True, timeout=120, check=True,
        )
        # The CLI may print a banner before the JSON.
        text = res.stdout
        data = json.loads(text[min(i for i in (text.find("["), text.find("{")) if i >= 0):])
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        print(f"warning: cron export skipped: {e}", file=sys.stderr)
        return
    jobs = data.get("jobs", data) if isinstance(data, dict) else data
    by_agent = {}
    for job in jobs:
        # Drop run state (lastRunAtMs, nextRunAtMs, status, …) so the diff only shows real job changes.
        job = {k: v for k, v in job.items()
               if k not in CRON_RUNTIME_KEYS and not k.startswith(("last", "next"))}
        by_agent.setdefault(job.get("agentId") or "_global", []).append(redact(job))
    for agent_id, agent_jobs in by_agent.items():
        agent_jobs.sort(key=lambda j: (j.get("name") or "", j.get("id") or ""))
        write_json(agents_dir / agent_id / "cron.json", agent_jobs)


def scan_for_secrets(root):
    hits = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or ".git" in path.relative_to(root).parts:
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(lines, 1):
            for name, rx in SECRET_VALUE.items():
                if rx.search(line):
                    hits.append(f"{path.relative_to(root)}:{n}: {name}")
    if shutil.which("gitleaks"):
        res = subprocess.run(
            ["gitleaks", "dir", str(root), "--no-banner", "--redact", "--exit-code", "3"],
            capture_output=True, text=True,
        )
        if res.returncode == 3:
            hits.append("gitleaks:\n" + res.stdout + res.stderr)
    return hits


def git(repo, *args, check=True):
    return subprocess.run(["git", "-C", str(repo), *args], check=check, capture_output=True, text=True)


def publish(repo, paths):
    git(repo, "add", "-A", "--", *map(str, paths))
    if git(repo, "diff", "--cached", "--quiet", check=False).returncode == 0:
        print("no changes since main")
        return
    git(repo, "commit", "-m", "export: OpenClaw agent state")
    git(repo, "push", "--force", "origin", "export")
    no_pr = "pushed branch 'export'; open a PR against main to review it"
    if not shutil.which("gh") or subprocess.run(
            ["gh", "auth", "status"], cwd=repo, capture_output=True).returncode != 0:
        print(no_pr + " (gh missing or not logged in)")
        return
    existing = subprocess.run(
        ["gh", "pr", "list", "--head", "export", "--state", "open", "--json", "number", "--jq", "length"],
        cwd=repo, capture_output=True, text=True,
    ).stdout.strip()
    if existing in ("", "0"):
        res = subprocess.run(
            ["gh", "pr", "create", "--base", "main", "--head", "export",
             "--title", "OpenClaw agent state export",
             "--body", "Automated export of OpenClaw agent definitions and curated memory. "
                       "Review what the agents learned, then merge."],
            cwd=repo,
        )
        if res.returncode != 0:
            print(no_pr + " (gh pr create failed)", file=sys.stderr)
    else:
        print("updated the open export PR")


# Keycloak client-credentials login for OWL: a service-account client (owl-exporter) with
# the owl-mcp client scope. Its submissions are always quarantined.
OWL_ENV = ("OWL_MCP_URL", "OWL_TOKEN_URL", "OWL_CLIENT_ID", "OWL_CLIENT_SECRET")


def owl_token(env):
    data = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": env["OWL_CLIENT_ID"],
        "client_secret": env["OWL_CLIENT_SECRET"],
    }).encode()
    with urllib.request.urlopen(urllib.request.Request(env["OWL_TOKEN_URL"], data=data), timeout=30) as r:
        return json.load(r)["access_token"]


def owl_call(url, token, tool, arguments):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": arguments}}).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {token}",
    })
    with urllib.request.urlopen(req, timeout=120) as r:
        reply = json.load(r)
    if "error" in reply:
        raise RuntimeError(reply["error"])
    text = reply["result"]["content"][0]["text"]
    if text.startswith("Error:") or reply["result"].get("isError"):
        raise RuntimeError(text[:300])
    try:
        return json.loads(text)
    except ValueError:
        raise RuntimeError(f"unexpected reply: {text[:300]}") from None


def origin_slug(repo):
    url = git(repo, "config", "--get", "remote.origin.url", check=False).stdout.strip()
    return re.sub(r"^(git@|https://)", "", url).replace("github.com:", "github.com/").removesuffix(".git") or repo.name


def submit_to_owl(repo, agents_dir, agents, everything, env, token=None):
    """Submit changed (or, with everything, all) MEMORY.md files of the given agents.

    The export branch was rebuilt from origin/main, so origin/main..HEAD is exactly what
    this export changed. Resubmitting unchanged content is harmless: OWL returns the
    existing job for the same bytes.
    """
    rel = agents_dir.relative_to(repo).as_posix()
    wanted = {f"{rel}/{a}/workspace/MEMORY.md" for a in agents}
    if everything:
        paths = sorted(p for p in wanted if (repo / p).is_file())
    else:
        changed = git(repo, "diff", "--name-only", "origin/main", "HEAD", "--", *sorted(wanted), check=False)
        paths = sorted(changed.stdout.split())
    if not paths:
        print("owl: no agent memory changed")
        return
    commit = git(repo, "rev-parse", "HEAD").stdout.strip()
    slug = origin_slug(repo)
    token = token or owl_token(env)
    for path in paths:
        agent = path.split("/")[-3]
        try:
            job = owl_call(env["OWL_MCP_URL"], token, "submit_document", {
                "content": (repo / path).read_text(encoding="utf-8"),
                "title": f"{agent} MEMORY.md",
                "uri": f"git:{slug}@{commit}:{path}",
                "media_type": "text/markdown",
                "source_kind": "agent-memory",
            })
            print(f"owl: {agent}: job {job['job_id']} {job['state']}" + (" (already submitted)" if job.get("note") else ""))
        except Exception as e:  # noqa: BLE001 — one agent failing must not stop the others
            print(f"owl: {agent}: submit failed: {e}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, type=Path, help="local clone of the export repo")
    ap.add_argument("--openclaw-home", type=Path, default=Path.home() / ".openclaw")
    ap.add_argument("--openclaw-bin", default="openclaw")
    ap.add_argument("--include-dreams", action="store_true", help="also export DREAMS.md and memory/dreaming")
    ap.add_argument("--public", action="store_true",
                    help="definitions only (persona, skills, config, cron); no memory or workspace data")
    ap.add_argument("--subdir", default="", help="export under this directory of the repo, e.g. 'agents'")
    ap.add_argument("--no-push", action="store_true", help="commit nothing; leave the export in the working tree")
    ap.add_argument("--dry-run", action="store_true", help="write the export to --repo but skip git entirely")
    ap.add_argument("--owl-agents", default="",
                    help="comma-separated agent ids whose changed MEMORY.md is submitted to OWL after the push")
    ap.add_argument("--owl-all", action="store_true",
                    help="submit those agents' MEMORY.md even if unchanged (initial backfill)")
    args = ap.parse_args()

    repo = args.repo.expanduser().resolve()
    home = args.openclaw_home.expanduser()
    config = json.loads((home / "openclaw.json").read_text(encoding="utf-8"))
    agents_cfg = config.get("agents", {})
    defaults = agents_cfg.get("defaults", {})

    if not args.dry_run:
        git(repo, "fetch", "origin")
        # Rebuild from main every run so the PR always shows main -> current agent state.
        git(repo, "checkout", "-B", "export", "origin/main")

    base = repo / args.subdir
    agents_dir, shared_dir = (base / "agents", base / "shared") if not args.subdir else (base, base / "_shared")
    for d in (agents_dir, shared_dir):
        shutil.rmtree(d, ignore_errors=True)

    for agent_id, entry in sorted(agents_cfg.get("entries", {}).items()):
        ws = Path(entry.get("workspace") or defaults.get("workspace", ""))
        dest = agents_dir / agent_id
        write_json(dest / "agent.json", redact(entry))
        # Skills the agent wrote itself via skill-workshop live in its agentDir, not the workspace.
        # Only this subdirectory is copied: agentDir also holds auth profiles.
        agent_dir = Path(entry.get("agentDir") or home / "agents" / agent_id / "agent")
        if (agent_dir / "workshop-skills").is_dir():
            shutil.copytree(agent_dir / "workshop-skills", dest / "workshop-skills",
                            ignore=shutil.ignore_patterns(".*", "node_modules"))
        if not ws.is_dir():
            print(f"{agent_id}: workspace {ws} not found", file=sys.stderr)
            continue
        copied, large = copy_workspace(ws, dest / "workspace", args.include_dreams, args.public)
        print(f"{agent_id}: {copied} files" + (f", {large} too large" if large else ""))

    write_json(shared_dir / "agent-defaults.json", redact(defaults))
    if "mcp" in config:
        write_json(shared_dir / "mcp.json", redact(config["mcp"]))
    if (home / "skills").is_dir():
        shutil.copytree(home / "skills", shared_dir / "skills",
                        ignore=shutil.ignore_patterns(".clawhub", ".git", "node_modules"))
    # Skill-workshop drafts (applied or still pending review); applied ones are also in
    # agents/<id>/workshop-skills.
    proposals = home / "skill-workshop" / "proposals"
    if proposals.is_dir() and not args.public:
        for src in sorted(proposals.rglob("PROPOSAL.md")):
            out = shared_dir / "skill-proposals" / src.relative_to(proposals)
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, out)
    export_cron(args.openclaw_bin, agents_dir)

    hits = scan_for_secrets(agents_dir) + (scan_for_secrets(shared_dir) if not args.subdir else [])
    if hits:
        print("refusing to publish: possible secrets found (values not shown):", file=sys.stderr)
        print("\n".join(hits), file=sys.stderr)
        sys.exit(2)

    if args.dry_run or args.no_push:
        print(f"export written to {repo} (not committed)")
        return
    publish(repo, [agents_dir, shared_dir])

    owl_agents = [a.strip() for a in args.owl_agents.split(",") if a.strip()]
    if owl_agents:
        env = {k: os.environ.get(k, "") for k in OWL_ENV}
        missing = [k for k, v in env.items() if not v]
        if missing:
            print(f"owl: skipped, not configured ({', '.join(missing)} unset)", file=sys.stderr)
            return
        try:
            submit_to_owl(repo, agents_dir, owl_agents, args.owl_all, env)
        except Exception as e:  # noqa: BLE001 — the git export already succeeded; OWL is best effort
            print(f"owl: submission failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
