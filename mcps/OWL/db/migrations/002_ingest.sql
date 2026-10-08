-- Phase 2: the ingest pipeline.
--
-- A submission is a job. submit_knowledge runs it synchronously and parks it in
-- `awaiting_confirmation` until the submitter confirms (or it expires); submit_document
-- queues it for the worker, which commits as soon as extraction finishes.

ALTER TABLE jobs DROP CONSTRAINT jobs_state_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_state_check CHECK (state IN
    ('queued', 'running', 'awaiting_confirmation', 'done', 'failed', 'expired', 'rejected'));
ALTER TABLE jobs
    ADD COLUMN submitted_by text,             -- identity id; rate limits and ownership key off it
    ADD COLUMN document_id  text REFERENCES documents (content_hash),
    ADD COLUMN expires_at   timestamptz;      -- awaiting_confirmation only
CREATE INDEX jobs_submitter ON jobs (submitted_by, created_at);
CREATE INDEX jobs_awaiting ON jobs (expires_at) WHERE state = 'awaiting_confirmation';

ALTER TABLE documents
    ADD COLUMN media_type   text,             -- what the parser was chosen by
    ADD COLUMN text_ref     text,             -- blob of the parsed text, when it differs from the original
    ADD COLUMN submitted_by text;

-- Span offsets point into the parser's output for `documents.parser_version`; for
-- markdown and plain text that is the original itself.
COMMENT ON COLUMN claim_provenance.span_start IS
    'Code point offset into the parsed text of the document (the original, for text and markdown)';
