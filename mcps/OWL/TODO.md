# OWL — build plan

Design: [README.md](README.md). Rationale: [AGENT.md](AGENT.md).

Ordering principle from the design discussion: the system starts **write-heavy**
(bootstrap — people push knowledge, the bottleneck is humans adjudicating conflicts) and
later flips to **read-heavy** (steady state — connectors are the main write path, the risk
is silent rot). The phases below follow that flip. Phases 0–3 are the bootstrap system;
4–6 are steady state.

Everything is built so the *schema* supports both phases from day one — validity windows,
TTL, disputed status, owner attribution. Retrofitting bitemporality onto a live store is
miserable.

---

## Decisions — settled 2026-09-17

1. **Postgres hosting** — plain `StatefulSet` with `pgvector/pgvector:pg17` and a PVC,
   in `af-platform`. No operator dependency.
2. **Models** — the Sparks *are* routable from AF pods, so the split is:
   cheap/high-volume path (extraction, novelty, pair triage) on local vLLM
   (`nano-30b` on Spark 1); adjudication on a hosted strong model via the existing
   `openai-key`. Both behind the provider abstraction, so either side can be repointed by
   config. vLLM guided decoding covers the extraction JSON schema.
3. **Embeddings** — OpenAI `text-embedding-3-large`, 3072-dim. The dimension is baked into
   the column type, so the re-embed migration path gets built in Phase 2 rather than when
   it is urgent.
4. **Blob store for originals** — cluster S3, wired as the `owl-s3` secret. Endpoint,
   bucket and credentials still needed; `BLOB_DIR` covers local development.
5. **Dispute notification channel** — Mattermost, via incoming webhook, wired as the
   `owl-mattermost` secret and granted to the worker only. Channel still to be chosen.
6. **Hostname** — `owl.af.atlas-ml.org`; you create the DNS record.
7. **Who may write at launch** — you only. Your Keycloak identity is the sole trusted
   writer; every other authenticated identity can read, and anything it submits lands in
   `quarantine`. Shared API keys stay read-only. Widening the list later is a config
   change, not a code change.

---

## Phase 0 — scaffold and deploy an empty service ✅

Goal: `https://owl.af.atlas-ml.org/mcp` answers `tools/list` with one trivial tool, in the
cluster, from CI. Get the whole pipe working before there is anything interesting in it.

* [x] Boilerplate from `mcps/GGUS` — `package.json`, `tsconfig.json`, `Dockerfile`,
      `.dockerignore`, `logger.ts`, `scripts/start_owl_mcp.sh`. Same express +
      `StreamableHTTPServerTransport` + `requestLogger` + `runTool` shape as its siblings.
* [x] Split out of one file: `index.ts`, `worker.ts`, `config.ts`, `identity.ts`,
      `authMiddleware.ts`, `logger.ts`, `db/pool.ts`, `tools/status.ts`. `llm/` and
      `pipeline/` arrive with Phases 2–3; `tools/read.ts` and `tools/write.ts` with 1–2.
* [x] **Auth deviates from the other MCPs on purpose.** `requireApiKey` returned a boolean;
      `requireIdentity` resolves a caller to an `Identity` and attaches it to the request.
      Service keys are read-only (they identify a service, not a person); Keycloak tokens
      give a person, and `OWL_TRUSTED_WRITERS` decides whether their claims commit or
      quarantine. Writes need attribution, so this had to change before any write exists.
* [x] Two roles from one image, selected by `OWL_MODE`; the entrypoint `exec`s node so
      SIGTERM reaches it and the pg pool closes cleanly.
* [x] `docker-compose.yaml` with `pgvector/pgvector:pg17` on 5433, and
      `db/init/01-extensions.sql` creating `vector`, `pg_trgm`, `uuid-ossp`.
* [x] `.env.example` covering every variable the README documents.
* [x] `owl_status` tool — version, db reachability, claim count, models, blob backend, and
      how the caller was identified. Reports `schema_migrated: false` rather than erroring
      before Phase 1 migrations exist.
* [x] `/healthz` (unauthenticated, for probes) and `/readyz` (authenticated db detail).
* [x] `deploy/base/owl-postgres.yaml` — StatefulSet, 50Gi PVC, ClusterIP service,
      extensions from a ConfigMap-mounted init SQL, `pg_isready` probes.
* [x] `deploy/base/owl-config.yaml` — non-secret config as a ConfigMap (models, trusted
      writers, log level). Was not in the original plan; the alternative was baking model
      names into the Deployment.
* [x] `deploy/mcps/owl_mcp.yaml` — Service, Ingress, `mcp-server-owl` (2 replicas, probes,
      PDB) and `owl-worker` (1 replica, `Recreate` so migrations and sweeps never have two
      owners). Both carry `role: mcp-server`, so the existing network policy covers them.
* [x] RBAC — ServiceAccounts `mcp-server-owl`, `owl-worker`, `owl-postgres`, each with
      `get` on only what it consumes. Only the worker gets `owl-mattermost`: nothing that
      answers HTTP should be able to post to the collaboration's channel.
* [x] Registered in both kustomizations (`kustomize build deploy/` passes; the sealed-secret
      entries are commented until the secrets exist).
* [x] OWL build step in `.github/workflows/mcp_builder.yaml`, tagged `latest` + date.
* [x] Secret templates in `secrets/` — `owl-db-secret.yaml`, `owl-s3-secret.yaml`,
      `owl-mattermost-secret.yaml`, each with its `kubeseal` invocation in a comment.
* [x] vLLM reachability check at worker startup: logs `ERROR` if the endpoint is dead and
      `WARN` if it answers but does not serve the configured model.
* [ ] Blob store abstraction (S3 + `BLOB_DIR`). Only the configuration and backend
      detection exist; the read/write implementation lands in Phase 2 with the first
      parser, which is the first thing that actually stores an original.

### Verified locally

`npm install` builds clean; `kustomize build deploy/` and a client-side `kubectl` dry-run
both pass. Against the compose database: extensions created, `/healthz` ok, `/mcp`
returning 401 unauthenticated and 403 on a bad key, `tools/list` and
`tools/call owl_status` both answering, worker connecting and reporting
`claims=(schema not migrated)`. Same checks pass inside the built image (319 MB), including
the `DATABASE_URL` and `OWL_MODE` guards.

### Needs you before this is live

* [ ] S3 endpoint, bucket and credentials → fill and seal `secrets/owl-s3-secret.yaml`.
* [ ] Mattermost channel webhook → fill and seal `secrets/owl-mattermost-secret.yaml`.
* [ ] Pick the Postgres password → fill and seal `secrets/owl-db-secret.yaml`. Keep the
      `POSTGRES_*` values and the credentials inside `DATABASE_URL` in agreement; nothing
      validates that, and a mismatch surfaces only as an auth failure at worker startup.
* [ ] Uncomment the three sealed-secret entries in `deploy/base/kustomization.yaml`.
* [ ] Replace `OWL_CHEAP_BASE_URL: http://CHANGEME-spark1:8000/v1` in
      `deploy/base/owl-config.yaml` with the Spark's address as reachable from
      `af-platform` pods.
* [ ] Create the `owl.af.atlas-ml.org` DNS record.
* [ ] Confirm the cluster's storage class for the PVC, or leave it on the default.
* [ ] A Keycloak client for `owl-mcp` (the audience the manifests expect), and your `sub`
      or username in `OWL_TRUSTED_WRITERS` if `ivukotic` is not what the token carries.
* [ ] Mirror the manifests into `maniaclab/flux_app` (`/af/af-platform`).
* [ ] Verify in the cluster: `curl -X POST https://owl.af.atlas-ml.org/mcp
      -H 'Authorization: Bearer ...' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`

## Phase 1 — the store and the read path

Goal: claims can be inserted by hand (SQL or a seed script) and retrieved well through MCP.
No LLM in the loop yet — this phase is about getting retrieval and the schema right while
they are still cheap to change.

* [ ] Migrations with `node-pg-migrate`, run by the worker at startup under a Postgres
      advisory lock (single writer, no separate Job to keep in sync).
* [ ] Schema:
      - `documents` — content hash (PK), uri, title, source_kind, fetched_at,
        parser_version, blob_ref
      - `claims` — id, text, canonical_text, subject_entity_id, predicate,
        `valid_from`/`valid_to`, `asserted_at`/`retracted_at`,
        status (`active|quarantined|disputed|superseded|retired`), confidence, ttl_days,
        owner_identity, classification, embedding `vector(N)`, tsv `tsvector`
      - `claim_provenance` — claim_id, document_id, span_start, span_end,
        extractor_version, submitted_by (many-to-many: the same claim attested by several
        sources is a confidence signal)
      - `claim_edges` — from_claim, to_claim, type
        (`supersedes|contradicts|refines|qualifies|resolves`), created_by, created_at
      - `entities` + `entity_aliases` — with a `cric_ref` column for the CRIC backbone
      - `disputes` — claim_a, claim_b, kind, state, opened_at, parties, escalated_at,
        resolution_claim_id
      - `jobs` — idempotency key `content_hash + prompt_version + model_version`, state,
        attempts, payload, result
      - `audit_log` — append-only, every write with identity and token id
      - `query_log` — for ranking disputes by real query traffic later
* [ ] Indexes: HNSW on `embedding`, GIN on `tsv`, btree on
      `(subject_entity_id, status, valid_to)`.
* [ ] Hybrid search query: vector + FTS with reciprocal-rank fusion, filtered by entity,
      status and time window. This is the single most important query in the system —
      worth unit tests against a fixture corpus.
* [ ] Recursive CTE for `traverse_entity` and for supersession chains.
* [ ] Read tools: `search_knowledge`, `get_claim`, `traverse_entity`, `get_timeline`,
      `list_disputes`, `fetch_source`.
* [ ] Output shaping: every returned claim carries provenance, status, age, and an
      explicit staleness/dispute flag. Never let a disputed claim come back looking settled.
* [ ] Seed script: a few dozen hand-written claims about a system we know well (Rucio
      subscriptions, or the AF login flow) to exercise retrieval.
* [ ] Eval harness skeleton — `eval/` with a runner, scoring retrieval recall and answer
      correctness *separately*, wired to `npm run eval` even though the gold set is tiny.

## Phase 2 — ingest pipeline

Goal: `submit_knowledge` and `submit_document` actually work, with novelty detection but
before the full contradiction machinery.

* [ ] LLM provider abstraction: `chat(model, schema)` with structured output, plus
      `embed(texts)`. Cheap/strong split configured by env, so switching between vLLM and
      hosted is a config change.
* [ ] Parsers: markdown/plain text first; then PDF and PPTX; HTML for wiki pages. Each
      records `parser_version` and preserves character offsets — the offsets are what make
      provenance verifiable, so they cannot be dropped in cleanup.
* [ ] Extraction prompt + JSON schema requiring, per claim: text, subject entity,
      span_start/span_end, temporal scope if stated, confidence. Constrained decoding.
      Version the prompt; the version is part of the job idempotency key.
* [ ] **Conversation rule**: when the payload is a chat transcript, only the human turns
      are treated as assertions. Assistant turns are context, never sources.
* [ ] Entity resolution: match extracted entity mentions against `entities`/aliases, and
      against CRIC for sites and services (reuse the CRIC MCP's fetch logic). Unmatched
      mentions create provisional entities flagged for review.
* [ ] Novelty check: embed each candidate, retrieve neighbours filtered to the same
      entity, drop exact duplicates (record an extra `claim_provenance` row instead —
      re-attestation raises confidence), keep refinements.
* [ ] Job queue on the same Postgres (`pgqueuer`-style `SELECT ... FOR UPDATE SKIP
      LOCKED`); no extra infrastructure. Worker drains it; `get_job` polls.
* [ ] `submit_knowledge` runs the pipeline synchronously and returns the extraction for
      confirmation — *"6 claims, 2 new, 1 conflicts"* — with a `confirm` handle.
      `submit_document` returns a job id.
* [ ] Quarantine state for claims from identities not on the trusted list.
* [ ] Rate limits per identity; audit every write.
* [ ] Re-embed path: `npm run reembed` that rebuilds the embedding column (new model or
      new dimension) into a shadow column and swaps it, so the 3072-dim choice is not a
      one-way door once there are claims.
* [ ] Replay tooling: `npm run reextract --since=... --prompt-version=...` that re-runs
      extraction and **diffs new claims against old before committing**. This is the payoff
      for the idempotency key and the reason to build it now rather than later.

## Phase 3 — contradictions, disputes, resolution

Goal: the librarian actually curates. This is the phase that decides whether the whole
thing works, since during bootstrap the conflict queue will be enormous.

* [ ] Two-stage conflict detection: hybrid retrieval of candidate counterparts filtered to
      the same entity, then pairwise classification into
      `duplicate | refinement | temporal_supersession | scope_qualification | true_conflict`.
      Cheap model triages; strong model only sees the last two.
* [ ] Auto-commit temporal supersessions: close the old claim's `valid_to`, write a
      `supersedes` edge, log it. No human involved.
* [ ] Open a `dispute` row for scope qualifications and true conflicts, with both claim ids
      and both owners.
* [ ] Resolution with **four** outcomes, not two: A correct / B correct / **both true under
      different conditions** / neither, here is the truth. The third fires most often and
      resolves by adding qualifiers to both claims rather than retiring either — if the UI
      only asks "which is correct", people will pick one and destroy a true claim.
* [ ] Store the resolution **as a claim**, with its own provenance and `resolves` edges to
      the disputed pair, so "was this already settled?" is a graph query.
* [ ] Disputed claims stay queryable; answers surface both versions with attribution.
* [ ] Timeout ladder: ping the two authors, then after a window route to the system's
      coordinator, then park as permanently disputed. Re-raise if query traffic keeps
      hitting it.
* [ ] Role map — coordinators and system experts per entity, as a table seeded from
      whatever ATLAS keeps this in. Fallback routing only.
* [ ] Mattermost digest: one message per person per week, ranked by how often each disputed
      claim was hit by real queries (hence `query_log` in Phase 1). Posted via incoming
      webhook. Interactive message buttons for the four resolution outcomes if the
      Mattermost instance allows them — that is the "one click" that decides whether people
      actually resolve anything; plain links to a resolution page otherwise.
* [ ] `resolve_dispute`, `dispute_claim`, `confirm_claim`, `retire_claim` tools.
* [ ] Bootstrap import: bulk-load a chunk of the existing corpus even if messy, then send
      people their extracted claims to *correct*. "Here are the 40 claims we extracted about
      Rucio subscriptions, which are wrong?" gets answers; "tell us about Rucio" does not.

## Phase 4 — steady state: connectors and decay

Goal: writes arrive without anyone pushing them, and stale knowledge announces itself.

* [ ] Connector framework: fetch, hash, skip if unchanged, else parse and enqueue. One
      scheduled sweep per source.
* [ ] TWiki connector (highest volume, worst staleness).
* [ ] GitHub connector — READMEs, docs directories, release notes.
* [ ] Indico connector — agendas and attached slides.
* [ ] GGUS connector — reuse the GGUS MCP's client; solved tickets are dense with
      operational knowledge.
* [ ] TTL-driven re-verification: volatile claims (endpoints, versions, who is on call) get
      a TTL; expiry generates a re-verification ping to the owner. Nobody will proactively
      tell us an endpoint moved.
* [ ] Mine the query log: questions that return nothing, or return disputed claims, are the
      highest-value ingest targets. Surface them as a weekly report — they say exactly where
      to spend human attention.
* [ ] Backpressure and cost controls: per-source rate caps, a daily token budget, and a
      kill switch per connector.

## Phase 5 — answer quality

Goal: matters much more in steady state than during bootstrap, which is why it is here and
not earlier.

* [ ] Intent routing: "how do I" assembles ordered procedure claims; "describe system X"
      does a graph walk; "what changed" reads the timeline.
* [ ] `compose_brief` tool — a synthesized, cited answer for agents that want one call
      instead of an agentic loop.
* [ ] Always surface staleness and unresolved conflict rather than silently picking a side.
* [ ] Grow the gold set to a real regression suite; run `npm run eval` in CI on any change
      to a prompt, model, or retrieval code path.

## Phase 6 — more front ends

* [ ] Plain HTTP API (the MCP tools are already a thin layer over it) for bulk import and
      scripting.
* [ ] CLI for bulk operations.
* [ ] Mattermost bot — `@owl remember this` on a thread is the lowest-friction capture path
      in our environment, and the conversations already happen there.
* [ ] Email drop for forwarding threads that contain the answer.
* [ ] AF chatbot integration.

---

## Documentation tasks

* [ ] `README.md` — written, kept current as phases land; drop the "not implemented"
      status note when Phase 1 ships.
* [ ] Add OWL to the MCP table in the repo root `README.md`.
* [ ] `docs/architecture.md` — add OWL to the platform diagram.
* [ ] `mcps/OWL/docs/schema.md` — the DDL with commentary, once it stabilizes.
* [ ] `mcps/OWL/docs/prompts.md` — extraction and adjudication prompts, versioned, with
      the output contracts.
* [ ] A short contributor-facing page: how to submit knowledge, what makes a good claim,
      what happens when you are asked to resolve a dispute.

---

## Risks worth naming

* **Adjudication throughput is the bottleneck**, not extraction quality. If resolving a
  conflict is slow or annoying, the system dies in month two. Phase 3 notification design
  matters more than Phase 2 model choice.
* **Cost profile is inverted from intuition**: cheap model on the high-volume extraction
  path, strong model only on the rare adjudication. Getting this backwards makes bootstrap
  unaffordable.
* **Span offsets get lost in cleanup.** Every parser change risks silently breaking
  provenance. Test it.
* **Agent-written knowledge can poison the store.** Quarantine, audit, and reversibility
  are not optional extras.
* **Embedding dimension is a one-way door** until a re-embed migration exists. Build the
  re-embed path in Phase 2, not when it is urgent.
