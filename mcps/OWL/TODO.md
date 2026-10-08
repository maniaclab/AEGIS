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
   in `aegis`. No operator dependency.
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
* [x] `deploy/mcps/owl_mcp.yaml` — Service, Ingress, `mcp-server-owl` (probes; started
      as 2 replicas with a PDB, now 1 replica and no PDB like the other MCPs) and
      `owl-worker` (1 replica, `Recreate` so migrations and sweeps never have two owners).
      Both carry `role: mcp-server`, so the existing network policy covers them.
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
* [x] Blob store abstraction (S3 + `BLOB_DIR`), `pipeline/blob.ts` — landed with Phase 2.

### Verified locally

`npm install` builds clean; `kustomize build deploy/` and a client-side `kubectl` dry-run
both pass. Against the compose database: extensions created, `/healthz` ok, `/mcp`
returning 401 unauthenticated and 403 on a bad key, `tools/list` and
`tools/call owl_status` both answering, worker connecting and reporting
`claims=(schema not migrated)`. Same checks pass inside the built image (319 MB), including
the `DATABASE_URL` and `OWL_MODE` guards.

### Needs you before this is live

* [x] S3 endpoint, bucket and credentials, sealed as `owl-s3`.
* [x] Mattermost channel webhook, sealed as `owl-mattermost`.
* [x] Postgres password, sealed as `owl-db`. All three live in
      `deploy/base/owl-secrets-sealed.yaml`.
* [x] Sealed secrets registered in `deploy/base/kustomization.yaml`.
* [x] Reach the vLLM on Spark 1. The campus network drops traffic from the AF cluster
      (`192.170.240.0/23`) to `dgx-spark1` before it reaches the host (tcpdump on spark1
      sees nothing), so OWL goes over the tailnet instead: `deploy/base/spark-relay.yaml`
      (tailscale in userspace mode + socat) and `OWL_CHEAP_BASE_URL: http://spark-relay:8000/v1`.
* [x] After the relay's first login, check the worker's startup log has no
      `cheap model endpoint` error. Verified 2026-10-07: the worker logs `cheap model
      'nano-30b' available`, and `/v1/models` answers through the relay. The relay logged
      `SOCKS5 server error` every 10 s until 2026-10-06 17:20 UTC (vLLM on spark1 down),
      none since.
* [x] Revoke the relay's auth key in the Tailscale console (`TS_AUTH_ONCE` means it is
      not needed again while `spark-relay-tsstate` exists). Revoked 2026-10-07.
* [x] `owl.af.atlas-ml.org` DNS record and ingress.
* [x] Storage class: `rook-ceph-block` (RBD), set explicitly. The first PVC landed on the
      cluster default, `reanadev-shared-volume-storage-class` (CephFS), and was recreated
      while the database was still empty.
* [x] Keycloak client scope `owl-mcp`; `ivukotic` resolves as a trusted writer.
* [x] Deployed in `aegis`: `mcp-server-owl`, `owl-worker`, `owl-postgres-0`.
* [x] Verified 2026-10-05: `owl_status` over OAuth answers with the database reachable
      and the caller identified as a trusted person.
* [x] Worker heartbeat logged `database unreachable: Connection terminated due to
      connection timeout` on 2026-09-30 and 2026-10-01. Checked 2026-10-07: no
      unreachable or timeout lines in 46 h of the current worker, so it was the old
      CephFS-backed database before the PVC was recreated on `rook-ceph-block`.

## Phase 1 — the store and the read path ✅

Goal: claims can be inserted by hand (SQL or a seed script) and retrieved well through MCP.
No LLM in the loop yet — this phase is about getting retrieval and the schema right while
they are still cheap to change.

* [x] Migrations, run by the worker at startup under a Postgres advisory lock (single
      writer, no separate Job to keep in sync). A small runner in `db/migrate.ts` over
      numbered SQL files in `db/migrations/` instead of `node-pg-migrate`: one dependency
      fewer, and plain SQL is what the schema is written in anyway. Each migration is
      checksummed, and an applied file that has since changed is a startup error.
* [x] Schema (`db/migrations/001_init.sql`) — `documents`, `claims`, `claim_provenance`,
      `claim_edges`, `entities` + `entity_aliases`, `disputes`, `jobs`, `audit_log`,
      `query_log`, as planned. Differences from the plan:
      - embedding is `halfvec(3072)`, not `vector(3072)`: pgvector's HNSW index stops at
        2000 dimensions for `vector` (4000 for `halfvec`). The worker refuses to start if
        `OWL_EMBEDDING_DIMENSIONS` disagrees with the column.
      - `claims.external_id` — a stable handle from outside (`seed:s01`), so seeds re-load
        in place and the gold set can name claims.
      - `claim_provenance.span_text` and `asserted_by` — the cited text itself (citations
        are on the hot read path, originals are in the blob store) and the person the
        source attributes the claim to, as distinct from who submitted it.
      - span offsets are Unicode code points, matching Postgres `substring()`.
      - `audit_log` refuses UPDATE, DELETE and TRUNCATE by trigger.
      - `tsv` is a generated column.
* [x] Indexes: HNSW on `embedding`, GIN on `tsv`, btree on
      `(subject_entity_id, status, valid_to)`, trigram on aliases.
* [x] Hybrid search (`db/search.ts`): RRF over three legs — vector, full-text with the
      query's lexemes OR'd (AND semantics returns nothing for natural questions), and
      claims whose subject entity is named in the query (weighted ½). Filters apply inside
      each leg. Each leg is optional: without an embedding key, search runs lexical+entity.
* [x] Recursive CTEs for `traverse_entity` (edge walk, any direction, n hops) and for
      supersession chains (ordered by graph position, not dates).
* [x] Read tools (`tools/read.ts`): `search_knowledge`, `get_claim`, `traverse_entity`,
      `get_timeline`, `list_disputes`, `fetch_source`. Every read is written to
      `query_log`. `fetch_source` serves the cited spans only until the blob store exists.
* [x] Output shaping (`db/claims.ts`): every claim carries citations, status, age and
      `flags` + human-readable `warnings` — superseded, disputed, unconfirmed, retired,
      expired, not_yet_valid, stale (TTL since last attestation).
* [x] Seed loader: `npm run seed -- --repo <aegis-agents>`. Reads
      `owl/seed-claims.yaml` (43 claims, 20 entities, from real agent memory, private) and
      each source with `git show <commit>:<path>`; a quote that is missing or not unique
      aborts the load. Idempotent (`seed:<id>`), re-embeds only changed text, retires seed
      claims removed from the file, and turns `expect_edge` into edges unless
      `--no-edges`.
* [x] Eval harness: `npm run eval -- --repo <aegis-agents>` over `owl/eval-gold.yaml`
      (22 questions). Scores retrieval (recall@k, hit@k, MRR) and the `must_flag` check;
      answer correctness is reported as skipped until there is an answer composer
      (`compose_brief`, Phase 5). Exits non-zero below `--min-recall` or on any flag
      failure. First run, 2026-10-07: recall@5 0.985, hit@5 1.0, MRR 0.911, no flag
      failures (lexical+entity alone: MRR 0.888). With `--no-edges` it correctly fails
      s18. The eval is the fixture-corpus test for hybrid search; a corpus of 43 claims
      flatters any ranker, so treat these numbers as a smoke test.
* [x] Deploy: merge, let the worker migrate the cluster database, then seed it from a
      laptop through `kubectl port-forward svc/owl-postgres 15432:5432` with the cluster
      `DATABASE_URL` (from the `owl-db` secret, host rewritten to `localhost:15432`).
      Done 2026-10-07 (image `sha256:40a43f12…`): worker applied `001_init`, seed loaded
      43 claims, eval on the cluster database matches local (recall@5 0.985, MRR 0.911),
      and `owl_status` through the ingress reports `claims: 43`.
* [ ] Eval in CI. The gold set is private, so CI needs read access to aegis-agents (a
      deploy key) and a throwaway pgvector service container.

## Phase 2 — ingest pipeline ✅ (deploy pending)

Goal: `submit_knowledge` and `submit_document` actually work, with novelty detection but
before the full contradiction machinery.

* [x] LLM provider abstraction (`llm/provider.ts`): `chat({tier, system, user, schema})`
      with structured output, plus `embed(texts, {model, dimensions})`. Cheap/strong split
      by env. `OWL_CHEAP_THINKING` (default on) lets Nemotron reason first: it extracted
      better and was not slower. `OWL_EXTRACTION_TIER` routes extraction and novelty to
      either tier.
* [ ] Parsers: markdown/plain text and conversations done (`pipeline/parse.ts`). Still to
      do: PDF, PPTX, HTML. Their spans will index the parsed text, stored next to the
      original (`documents.text_ref`, already in the schema).
* [x] Extraction (`pipeline/extract.ts`, `extract-v2`). Changed from the plan after
      testing on the agent memory files:
      - spans come from **line numbers**, not quotes or offsets. Nemotron paraphrased or
        invented about a third of its "verbatim" quotes however the prompt asked; line
        numbers it copies. The cited span is the original lines, verbatim by construction.
      - a **second pass labels each claim** fact / instruction / preference /
        incident_status, on the claim alone, and keeps facts. Asked inside extraction, with
        an agent's memory in view, the model labelled nearly everything an instruction.
      - reference material (known entities, the format example) lives in the system
        prompt, the document alone in the user turn; otherwise the model "extracted" the
        entity list and the example.
* [x] **Conversation rule**: only human turns get line numbers, so only they can be cited.
      Verified: facts stated only by the assistant were not extracted.
* [x] Entity resolution (`pipeline/entities.ts`): id/name/alias, then trigram, then the CRIC
      MCP (`list_rc_sites`, in-cluster, API_KEY_1) for site-like names, else provisional.
      Values and fragments ("8.0", "it", a command line) are rejected as subjects; the
      claim is stored without one rather than minting a junk entity.
* [x] Novelty (`pipeline/novelty.ts`, `novelty-v1`): embedding neighbours (top 3), then the
      model classifies duplicate / refines / conflicts / new in one batched call per
      document. Cosine alone cannot decide — rewordings of one fact scored 0.6-0.9, the
      same band as different facts about one system. Duplicates add a citation to the
      existing claim (+0.05 confidence); refines/conflicts are kept and flagged related,
      with the neighbour recorded, for Phase 3.
* [x] Job queue on Postgres (`db/jobs.ts`, `SELECT ... FOR UPDATE SKIP LOCKED`), drained by
      the worker; retries with exponential backoff (3 attempts); orphaned `running` jobs
      requeued at startup; idempotent by key, and a failed/expired/rejected job re-arms.
* [x] `submit_knowledge` (synchronous preview, nothing stored) + `confirm_submission`
      (accept / reject / edit by idx, or reject all; previews expire after 24 h).
      `submit_document` (inline or allow-listed https URL) + `get_job`.
* [x] Quarantine: untrusted identities, every service, and every `agent-memory` source
      land in `quarantined`. `list_quarantine`, `confirm_claim` (bulk) and `retire_claim`
      pulled forward from Phase 3 for the Tier 2 bulk review.
* [x] Rate limits per identity, counted in the database (`OWL_RATE_LIMIT_PER_HOUR`,
      trusted ×10); every write audited with identity and token id (`jti`).
* [x] Service submitters: `OWL_SUBMIT_SERVICES` lists the service identities that may
      submit (always quarantined) — for the agent-memory exporter.
* [x] Re-embed: `npm run reembed -- --model … --dimensions …` fills a shadow column,
      swaps in one transaction, rebuilds the HNSW index; resumable. Round-tripped
      3072 → 1536 → 3072 locally with eval unchanged.
* [x] Replay: `npm run reextract [--since] [--document] [--all] [--commit]` re-runs
      extraction over stored originals and diffs kept / added / missing per document;
      `--commit` adds new claims as quarantined and never retires missing ones.
* [x] Blob store: S3 (NRP Ceph, `owl-s3`) or `BLOB_DIR`, content-addressed by sha256.

### Measured on agent memory (local, 2026-10-07)

Against the seed (which was hand-extracted from the same files), with `nano-30b`:
extraction recall is good (conditioner 36, rodbot 46 claims), but subjects are noisy,
the fact filter is inconsistent between runs (keeps some incident notes and agent rules,
drops some facts), and novelty labels many restatements "refines". With `gpt-5`
(`OWL_EXTRACTION_TIER=strong`) on conditioner: 56 well-formed claims with correct
subjects; 28 recognised as already known, 8 related, 20 genuinely new; about $0.20 and
2.5 minutes per file. Quarantine review catches either way; the strong tier makes that
review short.

With `qwen3.6-35b` on Spark 2 (same prompts): conditioner 33 claims, 17 known, 11 new;
rodbot 39, 19 known, 17 new; networker 10 of 10 recognised as known, incident notes
dropped. Subjects and filtering close to gpt-5, at 200-530 s per file.

### Decided 2026-10-07

* [x] Extraction tier: the cheap tier, repointed from Nemotron (Spark 1) to
      `qwen3.6-35b` on Spark 2 through a second relay port (`spark-relay:8001`). Nemotron
      stays reachable on `spark-relay:8000`. Qwen 3.8 is to replace 3.6 (repo TODO).
* [x] Exporter credential: a Keycloak service-account client `owl-exporter`
      (`svc:kc:owl-exporter`, on `OWL_SUBMIT_SERVICES`).
* [x] Tier 2 hook: `agents-export/export_agents.py --owl-agents …` submits each changed
      `MEMORY.md` after the push, as `agent-memory`, with a `git:` URI pinned to the
      export commit. Tested locally end to end with Qwen.

### Still open

* [x] Tailnet policy: allow `tag:af-k8s` → `spark-2:8000`. Done 2026-10-08, with policy
      tests; verified from the relay pod (Spark 2 :8000 answers, :22 does not).
* [ ] Keycloak: create `owl-exporter` (service accounts on, other flows off, `owl-mcp`
      as a Default client scope); put its secret in `~/.config/aegis-export/owl.env` on
      spark-2 and install the updated unit; run once with `--owl-all` to backfill.
* [ ] Within-document duplicates (two candidates restating each other) are not merged.

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
