/**
 * Every environment variable OWL reads, in one place.
 *
 * Nothing here throws at import time except `DATABASE_URL`, which the service cannot do
 * anything useful without. The rest is validated where it is used, so a Phase 0 deployment
 * without S3 or Mattermost credentials still starts and serves reads.
 */
import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} environment variable is not set`);
    return value;
}

function list(name: string): string[] {
    return (process.env[name] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

export const config = {
    mode: (process.env.OWL_MODE ?? 'mcp') as 'mcp' | 'worker',
    port: Number(process.env.PORT ?? 8000),

    databaseUrl: required('DATABASE_URL'),

    /** Identities whose claims commit directly instead of landing in quarantine. */
    trustedWriters: list('OWL_TRUSTED_WRITERS'),

    /** Shared service keys. Read-only: they authenticate a service, not a person. */
    serviceKeys: [process.env.API_KEY_1, process.env.API_KEY_2].filter(
        (k): k is string => !!k,
    ),

    keycloak: {
        url: process.env.KEYCLOAK_URL,
        realm: process.env.KEYCLOAK_REALM,
        audience: process.env.KEYCLOAK_AUDIENCE,
    },

    /** High-volume path: extraction, novelty, pair triage. Local vLLM on the Sparks. */
    cheap: {
        baseUrl: process.env.OWL_CHEAP_BASE_URL,
        model: process.env.OWL_MODEL_CHEAP ?? 'nano-30b',
    },

    /** Rare path: adjudication of scope qualifications and true conflicts. */
    strong: {
        baseUrl: process.env.OWL_STRONG_BASE_URL ?? 'https://api.openai.com/v1',
        model: process.env.OWL_MODEL_STRONG ?? 'gpt-5',
    },

    embedding: {
        model: process.env.OWL_EMBEDDING_MODEL ?? 'text-embedding-3-large',
        /**
         * Baked into the `vector(N)` column type. Changing it needs `npm run reembed`,
         * so it is pinned here rather than inferred from whatever the provider returns.
         */
        dimensions: Number(process.env.OWL_EMBEDDING_DIMENSIONS ?? 3072),
    },

    openaiApiKey: process.env.OPENAI_API_KEY,

    /** Originals, content-addressed. S3 in the cluster; a directory for local dev. */
    blob: {
        s3Endpoint: process.env.S3_ENDPOINT,
        s3Bucket: process.env.S3_BUCKET,
        s3AccessKey: process.env.S3_ACCESS_KEY,
        s3SecretKey: process.env.S3_SECRET_KEY,
        dir: process.env.BLOB_DIR,
    },

    mattermostWebhookUrl: process.env.MATTERMOST_WEBHOOK_URL,
};

export function blobBackend(): 's3' | 'dir' | 'none' {
    if (config.blob.s3Endpoint && config.blob.s3Bucket) return 's3';
    if (config.blob.dir) return 'dir';
    return 'none';
}
