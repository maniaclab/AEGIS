# AEGIS

**AI Experimental Grid Infrastructure Sentinel** — AI-assisted monitoring and operation of the
distributed computing systems used by ATLAS, and potentially other LHC experiments.

AEGIS gives AI assistants and autonomous agents the same access to the ATLAS computing
infrastructure that an experienced operator has: topology and status from CRIC, data
management from Rucio, the GGUS helpdesk, facility monitoring in Elasticsearch, the Analysis
Facility documentation, a shell on the login nodes, and a curated knowledge base (OWL). All
of it is exposed through the [Model Context Protocol](https://modelcontextprotocol.io) with
CERN single sign-on, so the same tools work from Claude, ChatGPT, VS Code, OpenClaw, or a
scheduled agent running overnight.

The project is run by the [MANIAC Lab](https://github.com/maniaclab) at the University of
Chicago and deployed on the UChicago Analysis Facility Kubernetes cluster. It began as part
of the AF platform ([maniaclab/af-platform](https://github.com/maniaclab/af-platform)) and was
split out in 2026 so that the distributed-operations tooling can be developed and used
across ATLAS independently of any single site's platform. It supplies tools to, but does not
depend on, the lab's [Shannon](https://github.com/maniaclab/shannon) governance framework.

> **Status (October 2026).** Six MCP servers are in production. OWL, the knowledge service,
> has its scaffold deployed but holds no knowledge yet. Nine operations agents run on the
> lab's OpenClaw gateway and report daily into ATLAS Mattermost and lab Slack; see
> [Agents](#agents). The older copies of the MCP servers in `maniaclab/af-platform` are
> superseded by this repo.

---

## Contents

- [What AEGIS provides](#what-aegis-provides)
- [Quick start: connect an assistant](#quick-start-connect-an-assistant)
- [Agents](#agents)
- [OWL — the ATLAS AI Librarian](#owl--the-atlas-ai-librarian)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [For contributors](#for-contributors)
- [Roadmap](#roadmap)
- [License](#license)

---

## What AEGIS provides

### MCP servers

Each server runs in the `aegis` namespace on the AF UC cluster and is reachable over HTTPS
using the MCP Streamable HTTP transport. One CERN login, or one API key, works for all of
them. Per-server READMEs list every tool and have copy-paste setup for each client.

| Server | What it gives the assistant | Changes anything? | Endpoint |
| --- | --- | --- | --- |
| [CRIC](mcps/CRIC/README.md) | ATLAS computing topology: sites, PanDA queues, DDM endpoints and their statuses | no | `https://cric.af.atlas-ml.org/mcp` |
| [Rucio](mcps/Rucio/README.md) | ATLAS data management: datasets, replicas, rules, RSEs, transfers, quotas | no (read-only mode enforced) | `https://rucio.af.atlas-ml.org/mcp` |
| [GGUS](mcps/GGUS/README.md) | Grid helpdesk: search and read tickets; open tickets, comment, change state | **yes** — as the shared GGUS account | `https://ggus.af.atlas-ml.org/mcp` |
| [Elasticsearch](mcps/Elasticsearch/README.md) | Search the UChicago AF monitoring indices with the Query DSL | no | `https://es.af.atlas-ml.org/mcp` |
| [Knowledge](mcps/Knowledge/README.md) | The US ATLAS Analysis Facility documentation ([usatlas/af-docs](https://github.com/usatlas/af-docs)) | no | `https://knowledge.af.atlas-ml.org/mcp` |
| [Executor](mcps/Executor/README.md) | Run shell commands on AF login nodes over SSH as the shared `assistant` account | **yes** — powerful; keep tool approval on | `https://executor.af.atlas-ml.org/mcp` |
| [OWL](mcps/OWL/README.md) | Curated, cited ATLAS knowledge: claims with provenance, validity windows and dispute tracking | planned (writes attributed to a CERN identity) | `https://owl.af.atlas-ml.org/mcp` |

The write-capable servers act as **one shared service identity** towards the upstream
system (a GGUS account, the `assistant` Unix account), whoever is asking. This is deliberate
for now: it keeps the blast radius of any single assistant small and auditable, and it means
nobody needs their own grid or helpdesk credentials to use the tools. OWL is the exception
and the direction of travel: its writes must resolve to a real person through CERN SSO.

### Supporting pieces

- **[Agent export](agents-export/README.md)** — a script and systemd timer that copies every
  OpenClaw agent's definition, cron schedule and curated memory out of the gateway host into
  the [maniaclab/aegis-agents](https://github.com/maniaclab/aegis-agents) repo as plain files,
  through a pull request. Merging the PR is how the team reviews what the agents have learned.
- **[On-prem inference](on_prem/spark2/README.md)** — docker-compose for vLLM and OpenWebUI
  on the lab's DGX Spark nodes (`nano-30b` on Spark 1, `qwen3.6-35b` on Spark 2). These serve
  the high-volume, low-cost model path for OWL extraction and for agents that should not
  send operational data to a hosted provider.
- **[Deployment](deploy/README.md)** — kustomize manifests, sealed secrets, RBAC, and a
  network policy that admits only the ingress controller and other `aegis` pods.

---

## Quick start: connect an assistant

Full instructions for every client, and troubleshooting, are in the
[shared connection guide](mcps/README.md). The short version:

**Who can connect.** Anyone in the ATLAS e-group allowed to use the AF platform can sign in
with their CERN account. Unattended agents and scripts use an API key from the AF MCP
maintainers instead; one key works for all servers.

**Claude Code**, signing in with CERN (the client secret is empty; keep the callback port):

```bash
claude mcp add --transport http --scope user --client-id af-mcp --callback-port 8977 cric https://cric.af.atlas-ml.org/mcp
```

then `/mcp` → **cric** → **Authenticate**.

**Claude Desktop / claude.ai**: Settings → Connectors → Add custom connector, URL as above,
Advanced settings → OAuth Client ID `af-mcp`, secret empty.

**ChatGPT, VS Code, OpenClaw**: see the [guide](mcps/README.md#connecting-a-client). OpenClaw
cannot do this OAuth flow and must use an API key.

**Try it without a client:**

```bash
curl -s https://cric.af.atlas-ml.org/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $AF_MCP_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Agents

The MCP servers are the hands; the agents are what uses them unattended. AEGIS agents run on
the OpenClaw runtime on the lab's DGX Spark 2 node, call the AEGIS MCPs with a service API
key, and are scheduled with OpenClaw cron jobs. Their primary model is Claude Sonnet with the
local vLLM (`qwen3.6-35b`) as fallback. Each agent's persona, instructions and skills are
reviewed files; what it learns in operation goes into a daily `memory/<date>.md` and is
promoted to its `MEMORY.md` only after human review, through the
[export PR flow](agents-export/README.md) into the private
[maniaclab/aegis-agents](https://github.com/maniaclab/aegis-agents) repo.

<!-- TODO(ivukotic): table built from aegis-agents cron.json / MEMORY.md on 2026-10-04.
     Channel names in brackets are inferred from agent memory, not from config — confirm. -->

| Agent | What it does | Scheduled reports | Posts to |
| --- | --- | --- | --- |
| **Conditioner** | Monitors AF infrastructure health (Elasticsearch-driven) | Daily conditions report, 07:00 Chicago | Mattermost `atlas-conditions` |
| **Net** (networker) | HEP network and FTS transfer monitoring | FTS issues 07:30 Chicago; index health 07:00 Zurich | Mattermost (channel ID `374965…`) |
| **RodBot** | PanDA and FTS morning reports for ATLAS operations, including a PIC-specific pair | PanDA 08:00 and FTS 08:30 Berlin, weekdays; PIC reports 07:17 / 07:37 Paris daily | Mattermost `#rodbot` and a PIC channel |
| **Score Bot** | HEPspec / benchmark data | Weekly HEPspec report Monday; weekly anomaly check Monday 06:00 UTC | Mattermost (CERN), `scorebot` account |
| **condor** (htcondor) | AF HTCondor pool state, hold diagnostics; does not talk to end users | Cluster state daily 09:00 Chicago | Slack `C0228EBJL07` (maniaclab) |
| **Kube** (kubernetes) | River-dev Kubernetes cluster health | Daily health check 09:15 Chicago | Slack `C0BRSFLF6DS` (maniaclab) |
| **AF Orchestrator** (main) | Delegates to `htcondor` and `kubernetes`; email-draft approvals | Memories sync (currently disabled) | Slack `#ai-communications` |
| **Ace** (operator) | ATLAS computing orchestrator; delegates to `networker`, `rodbot`, `conditioner`, `ddmbot` | none scheduled | — |
| **DDM Helper** (ddmbot) | Assistant for Distributed Data Management, being defined with the DDM experts | none scheduled | Mattermost DDM channel |

Every agent also runs a 30-minute heartbeat. Reports for the ATLAS collaboration go to the
CERN Mattermost; reports about UChicago infrastructure go to the lab's Slack. OWL's weekly
dispute digest will join the Mattermost side once Phase 3 lands.

Agents reach the MCPs through a shared `mcp.json`: CRIC, Elasticsearch, Executor, Knowledge,
Rucio and GGUS, plus Internet2's Periscope. GGUS is restricted to its four read tools for
agents (`include` / `exclude` in the MCP config), so no agent can open or change a ticket; the
Executor is the one write-capable tool agents hold. Per-agent `tools.deny` lists narrow this
further.

---

## OWL — the ATLAS AI Librarian

OWL is the piece of AEGIS that is new rather than a wrapper around an existing service, so
it gets its own section.

ATLAS documents itself in TWiki, GitHub, Indico slides, mailing lists and chat, and the
result is contradictory and stale. A plain RAG index over that corpus does not fix it: no
retriever can decide at query time which of two conflicting pages is current. OWL moves the
work to **write time**. People and connectors *give* it knowledge; it extracts atomic
**claims**, each with span-level provenance into the source document and a validity window;
checks each against what it already knows; auto-resolves temporal supersessions; opens a
**dispute** for true conflicts and asks the two authors; and answers questions with citations.
Nothing is deleted, only superseded, so "what was true in 2024" and "what do we believe now"
are both answerable.

| | |
| --- | --- |
| Today | Phase 0: service, worker, Postgres + pgvector and manifests deployed; `owl_status` is the only tool |
| Next | Phase 1 read path (`search_knowledge`, `traverse_entity`, `get_timeline`, …), then ingest, then disputes |
| Models | Extraction and triage on local vLLM (Spark); adjudication on a hosted strong model; OpenAI embeddings |
| Writes | CERN identity required; one trusted writer at launch, everyone else quarantined until confirmed |
| Design | [README](mcps/OWL/README.md) · [build plan](mcps/OWL/TODO.md) · [design conversation](mcps/OWL/AGENT.md) |

---

## Architecture

```text
   People                                  Agents
   Claude · ChatGPT · VS Code · AF chatbot  OpenClaw crons on DGX Sparks
          │  CERN SSO (Keycloak af-mcp)            │  API key
          └──────────────────┬─────────────────────┘
                             ▼
              nginx ingress · *.af.atlas-ml.org
                             │
   ┌──────────┬──────────┬───┴──────┬───────────┬──────────┬──────────┐
   │  CRIC    │  Rucio   │  GGUS    │  Elastic- │ Knowledge│ Executor │   OWL (mcp + worker)
   │          │ (proxy + │          │  search   │          │          │   Postgres + pgvector
   │          │ upstream)│          │           │          │          │   blob store · vLLM
   └────┬─────┴────┬─────┴────┬─────┴─────┬─────┴────┬─────┴────┬─────┘
        ▼          ▼          ▼           ▼          ▼          ▼
   atlas-cric   Rucio      GGUS       AF ES      af-docs    AF login
   (x509)       (x509)    (Zammad)   cluster    (in image)   nodes (SSH)
```

**Authentication.** Every server accepts a CERN SSO token (via the AF-platform Keycloak,
realm `AF-platform`, pre-registered client `af-mcp`, one scope per server) or a shared API
key. Tokens identify a person; keys identify a service. All servers share one auth
middleware and one logging convention; Rucio wraps the upstream `rucio-mcp` package in an
auth proxy so it behaves like the others.

**Isolation.** Each server has its own ServiceAccount with `get` on only the secrets it
consumes. A NetworkPolicy admits ingress only from the nginx ingress controller and from
pods inside `aegis`. OWL's worker is the only workload that can post to the collaboration's
chat; nothing that answers HTTP can.

**Build and deploy.** Every push to `main` builds and pushes all MCP images to
`harbor.af.uchicago.edu/maniaclab/mcp-server-*`, tagged `latest` and with the date
([mcp_builder.yaml](.github/workflows/mcp_builder.yaml)). Manifests in [deploy/](deploy/)
pin the date tag; deployments run 2 replicas with a PodDisruptionBudget of 1.

---

## Repository layout

```text
mcps/              one directory per MCP server (TypeScript, express, StreamableHTTP)
  README.md        shared connection guide for every client, auth, troubleshooting
  CRIC/ Elasticsearch/ GGUS/ Knowledge/ Executor/ Rucio/ OWL/
deploy/            kustomize: base (namespace, RBAC, sealed secrets, OWL Postgres) + mcps/
agents-export/     export OpenClaw agents to the aegis-agents repo for review
on_prem/spark2/    vLLM + OpenWebUI compose for the DGX Sparks
.github/           image build workflow, CODEOWNERS
AGENTS.md          rules for AI coding assistants working in this repo
TODO.md            repo-level migration and cleanup list
```

---

## For contributors

**Adding an MCP server.** Copy `mcps/GGUS` as the template (it is the simplest server with
write tools): keep `authMiddleware.ts` and `logger.ts` unchanged so auth and logs stay
uniform; add a build step to `mcp_builder.yaml`; add a Deployment, Service, Ingress and PDB
under `deploy/mcps/` with the label `role: mcp-server` so the network policy covers it; add a
ServiceAccount and Role in `deploy/base/rbac.yaml`; and create a Keycloak client scope named
after the server's audience, attached to `af-mcp`. Then write the server's README in the same
shape as its siblings: what it does, tools table, connect, maintainers.

**Secrets.** Never commit plaintext. Seal with `kubeseal --format yaml` into `deploy/base/`.
The keys each sealed secret must carry are documented in the relevant README because the
unsealed templates are gitignored.

**Local development.** Each server runs with `npm install && npm start` and an `API_KEY_1`
in the environment; OWL additionally needs the compose Postgres. `npm run inspector` opens
the MCP Inspector against the local server.

**Owners.** See [CODEOWNERS](.github/CODEOWNERS). Pull requests that touch Executor, GGUS
write tools, RBAC or the network policy need a second reviewer.

**AI assistants** working in this repo follow [AGENTS.md](AGENTS.md).

---

## Roadmap

In rough order; the live list is [TODO.md](TODO.md) and [mcps/OWL/TODO.md](mcps/OWL/TODO.md).

1. Finish the split from `af-platform`: move the Flux deployment to this repo, settle the
   namespace, and bring the agents' definitions and schedules under AEGIS review.
2. OWL Phase 1–3: read path, ingest pipeline, disputes and the Mattermost digest.
3. Decide the Executor's future: point it at an OpenClaw node at CERN, or retire it in
   favour of narrower, purpose-built tools.
4. Per-user identity on write-capable servers (GGUS first), so actions are attributed to the
   person asking rather than a shared account.
5. OWL Phase 4+: TWiki, GitHub, Indico and GGUS connectors; TTL-driven re-verification.

---

## License

[MIT](LICENSE) © 2026 MANIAC Lab, University of Chicago.
