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

**Phase 0 complete** — the service, its container, its database and its manifests exist and
run; there is no knowledge in it yet. `owl_status` is the only tool. Everything else below
describes the target system, and the build order is in [TODO.md](TODO.md).

What works today: MCP over HTTP with Keycloak or service-key auth, identity resolution
(person vs service, trusted vs quarantined), Postgres with pgvector reachable from both
processes, and the worker's startup checks.

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

**Two processes, one image.** `owl-mcp` (2 replicas, stateless) serves MCP over HTTP.
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
db/               pool, migrations, queries
db/init/          extensions, run once at database initialization
tools/            MCP tool registrations
llm/              provider abstraction (planned)
pipeline/         parse, extract, novelty, contradict, commit (planned)
```

**Entity backbone from CRIC.** Sites, services and endpoints resolve against CRIC rather
than a namespace we invent, which gives free disambiguation and a join path into live
operational state.

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
| `owl_status` | Version, database reachability, claim count, configured models and blob backend, and how the caller is identified. The only tool that exists today. |

### Read

| Tool | Purpose |
| --- | --- |
| `search_knowledge` | Hybrid search (vector + lexical + structured filters: entity, time window, status). Returns claims with citations. |
| `get_claim` | One claim in full: provenance, edges, history, disputes. |
| `traverse_entity` | Walk the graph around an entity — what OWL knows about a system, and how the pieces relate. |
| `get_timeline` | How knowledge about a subject changed over time; what superseded what, and when. |
| `list_disputes` | Open contradictions, ranked by how often query traffic hits them. |
| `fetch_source` | Retrieve the original document, or just the cited span, behind a claim. |

### Write

| Tool | Purpose |
| --- | --- |
| `submit_knowledge` | Submit free text (typically a conversation turn). Runs extraction **synchronously** and returns the extracted claims with novelty/conflict verdicts for confirmation in the same turn. |
| `submit_document` | Submit a URL or file. Returns a job id; poll with `get_job`. |
| `confirm_claim` | Attest an existing claim — a second independent source is a confidence signal. |
| `dispute_claim` | Open a dispute against a claim with a counter-statement. |
| `resolve_dispute` | Record a verdict. Options are **A / B / both true under different conditions / neither, here is the truth**. |
| `retire_claim` | Close a claim's validity window, with reason and provenance. |
| `get_job` | Poll an async ingest job. |

Write tools never ack into a black box. `submit_knowledge` answers with
*"6 claims extracted, 2 new, 1 conflicts with something Marco asserted in June"* so the
submitter can correct it immediately. Submitting blind kills trust on day one.

---

## Ingest pipeline

Idempotent stages, each keyed by `content_hash + prompt_version + model_version`. That key
is what makes re-extraction affordable: improve a prompt, replay only what changed, diff
the new claims against the old before committing.

1. **Parse** — documents, slides, wiki, GitHub, mail into normalized text + structure.
2. **Extract** — constrained decoding against a JSON schema that *requires* span offsets.
3. **Novelty** — hybrid retrieval of near neighbours per candidate; drop exact duplicates,
   keep refinements.
4. **Contradict** — pull existing claims for the same entity and classify each pair as
   `duplicate | refinement | temporal_supersession | scope_qualification | true_conflict`.
   A cheap model triages; the strong model only sees the last two categories.
5. **Commit** — one transaction: rows, edges, provenance, audit entry.

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

---

## Deployment

Runs in the `af-platform` namespace alongside the other MCPs.

| Resource | Name |
| --- | --- |
| Ingress | `owl.af.atlas-ml.org` (cert-manager, nginx) |
| Deployment | `mcp-server-owl` — 2 replicas |
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

### Connecting

```json
"OWL_MCP_REMOTE": {
    "url": "https://owl.af.atlas-ml.org/mcp",
    "type": "http",
    "headers": {
        "Authorization": "Bearer <token>"
    }
}
```

---

## Local development

```bash
cd mcps/OWL
npm install                  # runs the build via `prepare`

docker compose up -d db      # Postgres 17 + pgvector on :5433, extensions created
cp .env.example .env         # then set API_KEY_1 to any string for local testing

npm start                    # owl-mcp   -> http://localhost:3400/mcp
npm run worker               # owl-worker, in another shell
npm run inspector            # interactive MCP test UI
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
| `API_KEY_1`, `API_KEY_2` | Shared service keys — read-only |
| `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_AUDIENCE` | Identity for attributed writes |
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
