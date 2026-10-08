# OWL — the ATLAS AI Librarian

OWL is a curated knowledge service for ATLAS. People and connectors *give* it knowledge;
OWL extracts atomic **claims**, checks what it already knows, adjudicates contradictions,
records provenance and validity, and answers questions with citations.

It is exposed as an **MCP server**, so it is reachable from Claude, the AF chatbot, and any
agent that already talks to the other AF MCPs.

> **Why not plain RAG?** We tried. The corpus (TWiki, GitHub, Indico, slides, mail) is
> contradictory and stale, and no retriever fixes that at query time. OWL moves the work to
> **write time**: the hard part is maintaining a curated store, and answering is then easy.

Design rationale and the conversation it came from: [AGENT.md](AGENT.md).

---

## Status

**Phase 2 — the ingest pipeline.** Knowledge can be submitted over MCP: free text and
conversations with a confirmation step, whole documents through the worker's queue. OWL
extracts claims, anchors them to entities (CRIC for sites), checks them against what it
already knows, and commits them — active for a trusted writer, quarantined otherwise.
Contradiction handling is Phase 3. The build order is in [TODO.md](TODO.md).

What works today: MCP over HTTP with Keycloak or service-key auth, identity resolution
(person vs service, trusted vs quarantined), the read and write tools, the ingest queue,
the blob store, the seed loader, the eval harness, and the re-embed and re-extract
maintenance scripts.

---

## Connect

| | |
| --- | --- |
| Endpoint | `https://owl.af.atlas-ml.org/mcp` (Streamable HTTP) |
| Auth | CERN login via OAuth (client ID `af-mcp`, scope `owl-mcp`), or an AF MCP API key |

Log in with CERN if you want to contribute knowledge: an API key, or any other service
credential, is read-only. See [the shared connection guide](../README.md#connecting-a-client)
for details and troubleshooting.

### Claude Code

```bash
claude mcp add --transport http --scope user --client-id af-mcp --callback-port 8977 owl https://owl.af.atlas-ml.org/mcp
```

Leave the client secret empty, then `/mcp` → **owl** → **Authenticate**.

### Claude Desktop and claude.ai

**Settings → Connectors → Add custom connector**, URL `https://owl.af.atlas-ml.org/mcp`,
**Advanced settings → OAuth Client ID** `af-mcp`, secret empty, then **Connect**.

### ChatGPT

With Developer mode on, create a **New Plugin** with server URL
`https://owl.af.atlas-ml.org/mcp` and authentication **OAuth**. Under **Advanced OAuth settings**:
registration method **User-Defined OAuth Client**, client ID `af-mcp`, secret empty, token
endpoint auth method **`none`**, scope `owl-mcp`. Details in the
[connection guide](../README.md#chatgpt-web-and-desktop-app).

### VS Code

In `.vscode/mcp.json` or your user configuration; enter client ID `af-mcp` when asked:

```json
{
  "servers": {
    "owl": { "type": "http", "url": "https://owl.af.atlas-ml.org/mcp" }
  }
}
```

### OpenClaw

With the API key in `~/.openclaw/.env` as `AF_MCP_API_KEY` (read-only access):

```bash
openclaw mcp set owl '{"url":"https://owl.af.atlas-ml.org/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${AF_MCP_API_KEY}"}}'
openclaw mcp probe owl
```

Tools appear as `owl__owl_status`, `owl__search_knowledge`, …

---

## Core idea: claims, not chunks

OWL does not store document chunks. It stores **claims** — atomic, self-contained
statements, each its own row, each with provenance and a validity window.

```text
"ATLAS DDM retries failed FTS transfers up to 3 times before marking the rule stuck."
  subject entity : rucio / ddm
  provenance     : doc 4f2a..., chars 8120-8290, extractor v3, submitted by ivukotic
  valid_from     : 2024-06-01     valid_to : (open)
  asserted_at    : 2026-09-17     status   : active
  confidence     : 0.82           ttl      : 180d
```

Two properties do the heavy lifting:

* **Bitemporality** — *when was this true* (`valid_from`/`valid_to`) is separate from
  *when did we learn it* (`asserted_at`/`retracted_at`). Nothing is ever deleted, only
  superseded. This is what makes obsolescence tractable.
* **Mandatory span provenance** — a claim without a byte range back into a stored document
  is unverifiable, and the extraction schema rejects it.

Entities (systems, services, sites, people, procedures) and typed edges between claims
(`supersedes`, `contradicts`, `refines`, `qualifies`, `resolves`) form a light graph over
the claim table.

---

## Architecture

```text
  MCP clients                 Connectors (later phase)          Bulk / CLI
  Claude, AF chatbot          TWiki - GitHub - Indico - GGUS    HTTP API
        |                              |                            |
        +--------------+---------------+----------------------------+
                       v
            +----------------------+
            |  owl-mcp  (Express)  |   read + write tools, Keycloak identity
            +----------+-----------+
                       |  enqueue / query
                       v
            +----------------------+        +------------------------+
            |  Postgres + pgvector |<-------|  owl-worker            |
            |  claims - entities   |        |  parse -> extract ->   |
            |  edges - disputes    |        |  novelty -> contradict |
            |  jobs - documents    |        |  -> commit; TTL sweeps |
            +----------+-----------+        +-----------+------------+
                       |                                |
                 blob store                        LLM providers
              (originals, by hash)            cheap: triage/extraction
                                              strong: adjudication
```

**One store.** Claims, edges and embeddings all live in Postgres. A supersession touches
several rows at once and must be transactional; a separate graph DB or vector DB would add
a second consistency domain for no gain at our scale. Graph traversal is a recursive CTE
over `claim_edges`; vector search is pgvector/HNSW; lexical search is Postgres full-text
search (Elasticsearch BM25 stays an option if FTS proves too weak).

**Two processes, one image.** `owl-mcp` (stateless, 1 replica today, can scale out) serves MCP over HTTP.
`owl-worker` (1 replica) drains the job queue and runs scheduled sweeps. Both are built
from the same TypeScript codebase; the entrypoint script selects the mode.

**Repository layout.** Unlike the other AF MCPs, OWL is too large for a single `index.ts`:

```text
index.ts          express wiring, transport, per-request server
worker.ts         the write-side process: migrations, queue, sweeps
config.ts         every environment variable, in one place
identity.ts       Keycloak claims -> a person or service identity
authMiddleware.ts bearer token -> req.owlIdentity
logger.ts         the shared AF MCP logging convention
db/               pool, migration runner, hybrid search, claim shaping, seed loader
db/migrations/    numbered SQL migrations, applied in order by the worker
db/init/          extensions, run once at database initialization
tools/            MCP tool registrations
llm/              embeddings today; the chat provider abstraction arrives in Phase 2
eval/             the gold-set runner (`npm run eval`)
pipeline/         parse, extract, novelty, contradict, commit (planned)
```

**CRIC as an entity anchor.** Where an entity is registered in CRIC (sites, PanDA queues,
DDM endpoints, …) OWL uses its CRIC identity, which gives free disambiguation and a join
path into live operational state. Much of the distributed system is not in CRIC (pilot
factories, Harvester, PanDA and Rucio internals, monitoring pipelines, facility services,
procedures, people), so OWL keeps its own entity namespace for everything else.

**Split model providers.** The high-volume path — extraction, novelty, pairwise triage —
runs on the local vLLM on the DGX Sparks (`nano-30b`), which are routable from AF pods.
Only adjudication, which is rare, uses a hosted strong model. The cost profile is inverted
from intuition, and getting it the other way round makes bootstrap unaffordable. Embeddings
are OpenAI `text-embedding-3-large` (3072-dim). Both sides sit behind one provider
interface, so either can be repointed by config.

Originals are kept in cluster S3, content-addressed by hash; local development falls back
to a plain directory so no credentials are needed to run OWL on a laptop.

---

## MCP tools

### Diagnostics

| Tool | Purpose |
| --- | --- |
| `owl_status` | Version, database reachability, schema version, claim count, configured models and blob backend, and how the caller is identified. |

### Read

| Tool | Purpose |
| --- | --- |
| `search_knowledge` | Hybrid search (vector + lexical + entity, fused by reciprocal rank) with filters: entity, point in time (`as_of`), history, unconfirmed. Returns claims with citations. |
| `get_claim` | One claim in full — citations, edges, open disputes — and its supersession chain. |
| `traverse_entity` | Everything about one system: its aliases, the claims about it, and claims reachable over edges up to n hops. |
| `get_timeline` | How knowledge about a subject changed over time; what superseded what, and when. |
| `list_disputes` | Unsettled contradictions, ranked by how often query traffic hit them in 30 days. |
| `fetch_source` | The sources behind a claim, with the exact cited spans. Full originals arrive with the blob store. |

Every claim comes back with `flags` and `warnings` — `superseded`, `disputed`,
`unconfirmed`, `retired`, `expired`, `not_yet_valid`, `stale` — and an empty list means
current, confirmed and fresh. Clients should relay the warnings: a superseded claim is
history, not an answer.

### Write

| Tool | Purpose |
| --- | --- |
| `submit_knowledge` | Submit free text or a conversation (only human turns count). Runs extraction **synchronously** and returns the claims with novelty verdicts — nothing is stored yet. |
| `confirm_submission` | Store a `submit_knowledge` preview: all claims, or chosen ones, optionally reworded; or reject it. Previews expire after 24 hours. |
| `submit_document` | Queue a markdown or plain-text document, inline or by https URL on an allowed host. Returns a job id; committed without a confirmation step. |
| `get_job` | State and outcome of a submission. |
| `list_quarantine` | Claims waiting for a trusted writer, filterable by source kind (e.g. `agent-memory`) and entity. |
| `confirm_claim` | Trusted writers: confirm quarantined claims, or attest active ones; many at once. |
| `retire_claim` | Close claims with a reason (trusted writers, or the owner). Nothing is deleted. |

Planned for Phase 3: `dispute_claim`, and `resolve_dispute` with the four outcomes
**A / B / both true under different conditions / neither, here is the truth**.

Who may submit: people (CERN login) always; services only when listed in
`OWL_SUBMIT_SERVICES`, and everything a service submits is quarantined. Agent memory
(`source_kind: agent-memory`) is quarantined whoever submits it.

Write tools never ack into a black box. `submit_knowledge` answers with
*"6 claims extracted, 2 new, 1 conflicts with something Marco asserted in June"* so the
submitter can correct it immediately. Submitting blind kills trust on day one.

---

## Ingest pipeline

Idempotent stages, each keyed by `content_hash + prompt_version + model_version` (and the
submitter). That key is what makes re-extraction affordable: improve a prompt, replay only
what changed, diff the new claims against the old before committing.

1. **Parse** — text and markdown pass through untouched; a conversation becomes a
   labelled transcript whose human turns are the only citable ranges. PDF, PPTX and HTML
   are still to come.
2. **Extract** — the document is shown with numbered lines and the model cites a line
   range per claim, under a JSON schema (guided decoding). Models do not copy quotes
   verbatim reliably, but they do copy line numbers, so every citation is the original
   text by construction. A second pass labels each claim — fact, instruction, preference,
   incident status — on the claim alone, and keeps only facts.
3. **Resolve entities** — known names and aliases, then trigram matches, then CRIC for
   site-like names, else a provisional entity. A value ("8.0", "6082") never becomes an
   entity; such a claim is stored without a subject.
4. **Novelty** — the nearest existing claims by embedding are shown to the model, which
   classifies each candidate as duplicate, refines, conflicts or new. A duplicate adds a
   citation to the existing claim instead of a new claim.
5. **Contradict** (Phase 3) — pull existing claims for the same entity and classify each pair as
   `duplicate | refinement | temporal_supersession | scope_qualification | true_conflict`.
   A cheap model triages; the strong model only sees the last two categories.
6. **Commit** — one transaction: rows, edges, provenance, audit entry.

Temporal supersessions auto-commit by closing the old claim's `valid_to`. Scope
qualifications and true conflicts open a **dispute**.

---

## Disputes

Most apparent contradictions in a collaboration this size are **scope mismatches**, not
factual disputes: different site, different release, different data period, one person
describing the analysis workflow and the other production. So resolution always offers
"both true under different conditions", which resolves by adding qualifiers to both claims
rather than retiring a true one.

* **Peers first.** Both authors are asked directly. Coordinators are the fallback after a
  timeout, not the primary route.
* **The disputed state is livable.** A disputed claim stays queryable; answers surface both
  versions with attribution. That is more useful to the asker than a confident wrong answer.
* **Timeout ladder.** Ping the authors, then route to the system's coordinator, then park
  as permanently disputed and let query traffic re-raise it if anyone actually cares.
* **Budget attention hard.** One digest per person per week, ranked by query hits. A
  contradiction nobody asks about does not deserve an email.
* **Resolutions are claims.** Stored with their own provenance and `resolves` edges, so
  when someone re-litigates the point in two years OWL can say it was already settled, by
  whom, and on what date.

---

## Identity and the write path

Writes are attributed or they are worthless. The MCP bearer token must resolve to a real
person via Keycloak (realm `AF-platform`), and the token's group claims carry through to
classification enforcement.

* Shared API keys authenticate **service** identities and are **read-only** by default.
  Keycloak service-account tokens (client-credentials, e.g. the AF chatbot's
  `af-platform-cli`) are treated the same way: they identify a client, not a person.
* A **trusted-writer list** (`OWL_TRUSTED_WRITERS`) holds the identities whose claims commit
  directly. At launch that is one person. Every other authenticated identity can read, and
  anything it submits lands in `quarantine` until a second source or a trusted writer
  confirms it. Widening the list is a config change.
* Every write is rate-limited per identity and recorded in an append-only audit log with
  the submitting token id.
* Extraction from a submitted conversation treats **only the human's statements** as
  assertions. An agent that can write to shared knowledge can poison it, including by
  accident — a hallucinated detail helpfully "saved" must be traceable and reversible.

---

## Evaluation

A frozen gold set of *question to expected-current-answer* pairs runs on every prompt or
model change, scoring **retrieval recall** and **answer correctness** separately so it is
clear which half regressed. Without it there is no way to tell whether a change helped.

The gold set and the seed claims are private — they come from agent memory — and live in
`owl/` of `maniaclab/aegis-agents`, never in this repository. Questions can also list
`must_flag` claims: if one of those is returned at all, it must carry an unsettled flag.
Answer correctness is reported as skipped until `compose_brief` exists.

---

## Deployment

Runs in the `aegis` namespace alongside the other MCPs.

| Resource | Name |
| --- | --- |
| Ingress | `owl.af.atlas-ml.org` (cert-manager, nginx) |
| Deployment | `mcp-server-owl` — 1 replica |
| Deployment | `owl-worker` — 1 replica |
| StatefulSet | `owl-postgres` — pgvector, PVC-backed, 50Gi |
| ConfigMap | `owl-config` — models, trusted writers, log level |
| Secrets | `owl-db`, `owl-s3`, `owl-mattermost` (all sealed), plus the existing `openai-key` and `mcp-keys` |
| Image | `harbor.af.uchicago.edu/maniaclab/mcp-server-owl` |

One image serves both roles; `OWL_MODE` (`mcp` or `worker`) selects which. The worker uses
a `Recreate` strategy so migrations and sweeps never have two owners, and it is the only
workload granted `owl-mattermost` — nothing that answers HTTP should be able to post to the
collaboration's channel.

### Secrets

`secrets/` is gitignored, so the fill-in templates there are local only — the keys each
sealed secret must carry are recorded here instead:

| Secret | Keys |
| --- | --- |
| `owl-db` | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL` |
| `owl-s3` | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` |
| `owl-mattermost` | `MATTERMOST_WEBHOOK_URL` |

The `POSTGRES_*` values and the credentials embedded in `DATABASE_URL` must agree. Nothing
validates that; a mismatch surfaces only as an authentication failure at worker startup.

Seal each into `deploy/base/` and uncomment its entry in the base kustomization:

```bash
kubeseal --format yaml < secrets/owl-db-secret.yaml > deploy/base/owl-db-sealed.yaml
```

Manifests: [owl_mcp.yaml](../../deploy/mcps/owl_mcp.yaml) and
[owl-postgres.yaml](../../deploy/base/owl-postgres.yaml).
Images are built by [mcp_builder.yaml](../../.github/workflows/mcp_builder.yaml)
on push to `main`.

---

## Local development

```bash
cd mcps/OWL
npm install                  # runs the build via `prepare`

docker compose up -d db      # Postgres 17 + pgvector on :5433, extensions created
cp .env.example .env         # then set API_KEY_1 to any string for local testing

npm start                    # owl-mcp   -> http://localhost:3400/mcp
npm run worker               # owl-worker, in another shell; migrates first
npm run inspector            # interactive MCP test UI
```

Load the seed claims and score retrieval, with a checkout of the private
`maniaclab/aegis-agents` next to this repository:

```bash
npm run migrate              # or just start the worker once
npm run seed -- --repo ../../../aegis-agents            # --dry-run validates quotes only
npm run eval -- --repo ../../../aegis-agents            # --verbose, --min-recall 0.9
```

The seed loader is idempotent: re-running updates claims in place and re-embeds only those
whose text changed. `--no-edges` loads superseded pairs as two active claims, which is the
input Phase 3 conflict detection has to handle on its own.

Extraction needs the cheap model; on the tailnet, set `OWL_CHEAP_BASE_URL` to
`http://spark1:8000/v1`. Maintenance:

```bash
npm run reextract                          # dry run: replay documents extracted with an older prompt, and diff
npm run reextract -- --all --commit        # replay everything, commit what is new (quarantined)
npm run reembed -- --dimensions 1536       # rebuild embeddings in a shadow column, then swap
```

Note that a variable already exported in your shell wins over `.env` — dotenv does not
override the environment. `OPENAI_API_KEY` is the one that catches people out.

Smoke test:

```bash
curl -s localhost:3400/healthz

curl -s -X POST localhost:3400/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $API_KEY_1" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"owl_status","arguments":{}}}'
```

### Endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `POST /mcp` | required | MCP Streamable HTTP transport |
| `GET /healthz` | none | Process liveness, for kubelet probes |
| `GET /readyz` | required | Database reachability detail, for debugging a deployment |

### Configuration

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `OWL_CHEAP_BASE_URL`, `OWL_MODEL_CHEAP` | vLLM endpoint and model for extraction, novelty and triage |
| `OWL_STRONG_BASE_URL`, `OWL_MODEL_STRONG` | Hosted endpoint and model for adjudication |
| `OPENAI_API_KEY` | Key for the hosted strong model and for embeddings |
| `OWL_EMBEDDING_MODEL` | Embedding model id (`text-embedding-3-large`, 3072-dim) |
| `OWL_EMBEDDING_DIMENSIONS` | Must match the `claims.embedding` column; the worker refuses to start otherwise |
| `OWL_EMBEDDING_BASE_URL` | OpenAI-compatible embeddings endpoint (default `https://api.openai.com/v1`) |
| `OWL_SEED_REPO` | Default `--repo` for `npm run seed` and `npm run eval` |
| `OWL_CHEAP_THINKING` | Let the cheap model reason before answering (default `true`) |
| `OWL_EXTRACTION_TIER` | `cheap` (default) or `strong`: which model extracts claims and judges novelty |
| `OWL_SUBMIT_SERVICES` | Service identities allowed to submit (always quarantined) |
| `OWL_RATE_LIMIT_PER_HOUR` | Submissions per identity per hour (default 30; trusted writers ×10) |
| `OWL_FETCH_ALLOWED_HOSTS` | Hosts `submit_document` may fetch from |
| `OWL_CRIC_MCP_URL` | CRIC MCP endpoint, for anchoring site entities |
| `API_KEY_1`, `API_KEY_2` | Shared service keys — read-only |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_AUDIENCE` | Identity for attributed writes; the audience is `owl-mcp` in production |
| `MCP_RESOURCE_URL`, `MCP_OAUTH_SCOPE` | Public `/mcp` URL and advertised scope, for OAuth discovery |
| `OWL_TRUSTED_WRITERS` | Identities whose claims commit without quarantine |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Original-document store |
| `BLOB_DIR` | Filesystem fallback for the blob store, for local dev |
| `MATTERMOST_WEBHOOK_URL` | Where dispute digests are posted |
| `LOG_LEVEL` | `debug \| info \| warn \| error` (default `info`) |

## Logging

Same convention as the other AF MCPs: one timestamped line per event
(`<ISO-8601 UTC> <LEVEL> <message>`), correlated request pairs, one line per tool call and
per upstream call. `LOG_LEVEL=debug` dumps request bodies — keep production at `info`,
since submitted knowledge may be sensitive.
