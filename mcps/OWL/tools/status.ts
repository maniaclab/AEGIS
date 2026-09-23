import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runTool } from '../logger.js';
import { blobBackend, config } from '../config.js';
import { dbStatus } from '../db/pool.js';
import type { Identity } from '../identity.js';

/**
 * The only tool in Phase 0. It exists to prove the transport, auth, identity and database
 * path end to end before any of the librarian machinery is built, and stays useful
 * afterwards as a diagnostic.
 */
export function registerStatusTool(server: McpServer, identity?: Identity): void {
    server.registerTool(
        'owl_status',
        {
            title: 'OWL Status',
            description:
                'Report the health of the OWL librarian: version, database reachability, ' +
                'number of stored claims, configured models and blob backend, and how the ' +
                'caller is identified.',
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {},
        },
        async () => runTool('owl_status', {}, async () => {
            const db = await dbStatus();
            return JSON.stringify(
                {
                    version: process.env.npm_package_version ?? 'dev',
                    mode: config.mode,
                    database: db,
                    schema_migrated: db.claims !== null && db.claims !== undefined,
                    models: {
                        cheap: config.cheap.model,
                        cheap_endpoint: config.cheap.baseUrl ?? '(not configured)',
                        strong: config.strong.model,
                        embedding: `${config.embedding.model} (${config.embedding.dimensions}d)`,
                    },
                    blob_backend: blobBackend(),
                    caller: identity
                        ? {
                            kind: identity.kind,
                            id: identity.id,
                            username: identity.username,
                            can_write: identity.canWrite,
                            trusted: identity.trusted,
                        }
                        : null,
                },
                null,
                2,
            );
        }),
    );
}
