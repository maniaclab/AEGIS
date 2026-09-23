-- Runs once, on first initialization of an empty data directory, by both the
-- docker-compose database and the in-cluster StatefulSet (which mounts this same
-- file from a ConfigMap).
--
-- Schema itself is owned by the migrations, not by this file. Only extensions
-- belong here, because creating them needs superuser and must happen before any
-- migration references a `vector` column.

CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector: claim embeddings, HNSW index
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram similarity, for alias matching
CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; -- claim and document identifiers
