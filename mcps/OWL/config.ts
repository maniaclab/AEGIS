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

    /**
     * Service identities (`svc:<n>`, `svc:kc:<client>`) that may submit, e.g. the agent
     * memory exporter. A service is never trusted: everything it submits is quarantined.
     */
    submitServices: list('OWL_SUBMIT_SERVICES'),

    /** Submissions per identity per hour; trusted writers get ten times this. */
    rateLimitPerHour: Number(process.env.OWL_RATE_LIMIT_PER_HOUR ?? 30),

    /** Hosts submit_document may fetch from (https only). Everything else is refused. */
    fetchAllowedHosts: list('OWL_FETCH_ALLOWED_HOSTS').length
        ? list('OWL_FETCH_ALLOWED_HOSTS')
        : ['raw.githubusercontent.com', 'gitlab.cern.ch', 'twiki.cern.ch', 'indico.cern.ch'],

    /** CRIC MCP, for anchoring site entities; called with API_KEY_1. Optional. */
    cricMcpUrl: process.env.OWL_CRIC_MCP_URL,

    keycloak: {
        url: process.env.KEYCLOAK_URL,
        realm: process.env.KEYCLOAK_REALM,
        audience: process.env.KEYCLOAK_AUDIENCE,
        /** Public URL of /mcp; enables OAuth discovery for clients that send no token. */
        resourceUrl: process.env.MCP_RESOURCE_URL,
        /** Keycloak client scope that adds the audience; by convention named like it. */
        scope: process.env.MCP_OAUTH_SCOPE ?? process.env.KEYCLOAK_AUDIENCE,
    },

    /** High-volume path: extraction, novelty, pair triage. Local vLLM on the Sparks. */
    cheap: {
        baseUrl: process.env.OWL_CHEAP_BASE_URL,
        model: process.env.OWL_MODEL_CHEAP ?? 'nano-30b',
        /**
         * Let the model reason before answering. On by default: with Nemotron it extracted
         * better claims and dropped fewer, and was not slower (shorter answers).
         */
        thinking: (process.env.OWL_CHEAP_THINKING ?? 'true') === 'true',
    },

    /**
     * Which tier extracts and triages novelty. `cheap` by design (high volume); `strong`
     * trades cost, and sending documents to the hosted provider, for quality.
     */
    extractionTier: (process.env.OWL_EXTRACTION_TIER ?? 'cheap') as 'cheap' | 'strong',

    /** Rare path: adjudication of scope qualifications and true conflicts. */
    strong: {
        baseUrl: process.env.OWL_STRONG_BASE_URL ?? 'https://api.openai.com/v1',
        model: process.env.OWL_MODEL_STRONG ?? 'gpt-5',
    },

    embedding: {
        baseUrl: process.env.OWL_EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1',
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
