-- Phase 1 schema: the claim store and its read-side bookkeeping.
--
-- Conventions:
--   * Nothing is deleted. Claims end by `valid_to` (stopped being true) or
--     `retracted_at` (we stopped believing it), and change status; audit_log refuses
--     UPDATE and DELETE outright.
--   * Span offsets are Unicode code points, not bytes or UTF-16 units, so they agree with
--     Postgres substring() and with Python string indexing.
--   * The embedding dimension is baked into the column type. The worker refuses to start
--     if OWL_EMBEDDING_DIMENSIONS disagrees; changing it is `npm run reembed` (Phase 2).
--     halfvec rather than vector because pgvector's HNSW index stops at 2000 dimensions
--     for vector and at 4000 for halfvec; the precision loss does not matter for ranking.

CREATE TABLE entities (
    id          text PRIMARY KEY,               -- slug, e.g. 'frontier', 'cscs-lcg2'
    kind        text NOT NULL,                  -- service, site, host, software, dataset, ...
    name        text NOT NULL,
    cric_ref    text,                           -- CRIC name, only where CRIC has the entity
    provisional boolean NOT NULL DEFAULT false, -- created by extraction, awaiting review
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entity_aliases (
    entity_id text NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
    alias     text NOT NULL
);
CREATE UNIQUE INDEX entity_aliases_uniq ON entity_aliases (entity_id, lower(alias));
CREATE INDEX entity_aliases_lower ON entity_aliases (lower(alias));
CREATE INDEX entity_aliases_trgm ON entity_aliases USING gin (lower(alias) gin_trgm_ops);

CREATE TABLE documents (
    content_hash   text PRIMARY KEY,            -- sha256 hex of the original
    uri            text NOT NULL,
    title          text,
    source_kind    text NOT NULL,               -- agent-memory, statement, twiki, github, ...
    fetched_at     timestamptz NOT NULL DEFAULT now(),
    parser_version text,
    blob_ref       text                         -- null until the blob store lands (Phase 2)
);

CREATE TABLE claims (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    external_id       text UNIQUE,              -- stable handle from outside, e.g. 'seed:s01'
    text              text NOT NULL,
    canonical_text    text,
    subject_entity_id text REFERENCES entities (id),
    predicate         text,
    valid_from        timestamptz,              -- null: true since before we know
    valid_to          timestamptz,              -- null: still true
    asserted_at       timestamptz NOT NULL DEFAULT now(),
    retracted_at      timestamptz,
    status            text NOT NULL DEFAULT 'quarantined'
                      CHECK (status IN ('active', 'quarantined', 'disputed', 'superseded', 'retired')),
    confidence        real CHECK (confidence BETWEEN 0 AND 1),
    ttl_days          integer CHECK (ttl_days > 0), -- null: stable, never re-verify
    owner_identity    text NOT NULL,
    classification    text NOT NULL DEFAULT 'internal',
    embedding         halfvec(3072),
    embedding_model   text,
    tsv               tsvector GENERATED ALWAYS AS
                      (to_tsvector('english', coalesce(canonical_text, text))) STORED,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX claims_embedding_hnsw ON claims USING hnsw (embedding halfvec_cosine_ops);
CREATE INDEX claims_tsv ON claims USING gin (tsv);
CREATE INDEX claims_subject_status ON claims (subject_entity_id, status, valid_to);

CREATE TABLE claim_provenance (
    claim_id          uuid NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
    document_id       text NOT NULL REFERENCES documents (content_hash),
    span_start        integer NOT NULL CHECK (span_start >= 0),
    span_end          integer NOT NULL,
    -- The cited text itself. Redundant with the original, but the original lives in the
    -- blob store and citations are on the hot read path.
    span_text         text NOT NULL,
    extractor_version text NOT NULL,
    submitted_by      text NOT NULL,            -- identity that put it in OWL
    asserted_by       text,                     -- person the source attributes it to
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (claim_id, document_id, span_start),
    CHECK (span_end > span_start)
);
CREATE INDEX claim_provenance_document ON claim_provenance (document_id);

CREATE TABLE claim_edges (
    from_claim uuid NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
    to_claim   uuid NOT NULL REFERENCES claims (id) ON DELETE CASCADE,
    type       text NOT NULL
               CHECK (type IN ('supersedes', 'contradicts', 'refines', 'qualifies', 'resolves')),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (from_claim, to_claim, type),
    CHECK (from_claim <> to_claim)
);
CREATE INDEX claim_edges_to ON claim_edges (to_claim);

CREATE TABLE disputes (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    claim_a             uuid NOT NULL REFERENCES claims (id),
    claim_b             uuid NOT NULL REFERENCES claims (id),
    kind                text NOT NULL CHECK (kind IN ('scope_qualification', 'true_conflict')),
    state               text NOT NULL DEFAULT 'open'
                        CHECK (state IN ('open', 'escalated', 'parked', 'resolved')),
    parties             text[] NOT NULL DEFAULT '{}',
    opened_at           timestamptz NOT NULL DEFAULT now(),
    escalated_at        timestamptz,
    resolved_at         timestamptz,
    resolution_claim_id uuid REFERENCES claims (id)
);
CREATE INDEX disputes_state ON disputes (state, opened_at);
CREATE INDEX disputes_claims ON disputes (claim_a, claim_b);

CREATE TABLE jobs (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- content_hash + prompt_version + model_version: replaying unchanged work is a no-op.
    idempotency_key text NOT NULL UNIQUE,
    kind            text NOT NULL,
    state           text NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued', 'running', 'done', 'failed')),
    attempts        integer NOT NULL DEFAULT 0,
    payload         jsonb NOT NULL DEFAULT '{}',
    result          jsonb,
    error           text,
    run_after       timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON jobs (run_after) WHERE state = 'queued';

CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    identity_id text NOT NULL,
    token_id    text,
    action      text NOT NULL,                  -- e.g. claim.upsert, edge.create
    target_kind text,
    target_id   text,
    detail      jsonb
);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- Every read query, so disputes can later be ranked by how often real traffic hits them.
CREATE TABLE query_log (
    id               bigserial PRIMARY KEY,
    at               timestamptz NOT NULL DEFAULT now(),
    identity_id      text,
    tool             text NOT NULL,
    query            text,
    filters          jsonb,
    result_claim_ids uuid[] NOT NULL DEFAULT '{}',
    hit_disputed     boolean NOT NULL DEFAULT false
);
CREATE INDEX query_log_at ON query_log (at);
CREATE INDEX query_log_results ON query_log USING gin (result_claim_ids);
