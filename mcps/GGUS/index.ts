#!/usr/bin/env node
import express, { Request, Response } from 'express';
import { protectedResourceMetadata, requireApiKey } from './authMiddleware.js';
import { log, logUpstream, requestLogger, runTool } from './logger.js';

import cors from 'cors';
import { z } from 'zod';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import dotenv from 'dotenv';
dotenv.config();

// @ts-expect-error ignore `with` keyword
import pkg from './package.json' with { type: 'json' }

const product = {
    name: pkg.name,
    version: pkg.version,
};

const GGUS_BASE = 'https://helpdesk.ggus.eu';
const MY_USER_ID = 1094;

function ggusHeaders(): Record<string, string> {
    const token = process.env.GGUS_TOKEN;
    if (!token) throw new Error('GGUS_TOKEN environment variable not set');
    return {
        'Authorization': `Token token=${token}`,
        'Content-Type': 'application/json',
    };
}

async function ggusRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    const started = process.hrtime.bigint();
    const res = await fetch(`${GGUS_BASE}${path}`, {
        method,
        headers: ggusHeaders(),
        ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    logUpstream(method, path, res.status, started);
    if (!res.ok) throw new Error(`GGUS API error ${res.status}: ${await res.text()}`);
    return res.json();
}

async function ggusGet(path: string): Promise<unknown> {
    return ggusRequest('GET', path);
}

async function ggusPost(path: string, body: unknown): Promise<unknown> {
    return ggusRequest('POST', path, body);
}

async function ggusPut(path: string, body: unknown): Promise<unknown> {
    return ggusRequest('PUT', path, body);
}

export async function createGgusMcpServer(): Promise<McpServer> {

    const server = new McpServer(product);

    server.registerTool(
        "list_my_tickets",
        {
            title: "List My Tickets",
            description: "List GGUS helpdesk tickets created by the current user, optionally filtered by state. Returns ticket number, title, state, area, WLCG sites, and last updated time.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                per_page: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .optional()
                    .describe("Number of tickets to return (default 25, max 100)."),
                state: z
                    .string()
                    .optional()
                    .describe("Filter tickets by state name (e.g. 'open', 'closed', 'assigned', 'solved'). If omitted, returns tickets in all states."),
            }
        },
        async ({ per_page, state }) => runTool("list_my_tickets", { per_page, state }, async () => {
            const count = per_page ?? 25;
            let query = `created_by_id:${MY_USER_ID}`;
            if (state !== undefined) query += ` AND state.name:"${state}"`;
            const tickets = await ggusGet(
                `/api/v1/tickets/search?query=${encodeURIComponent(query)}&per_page=${count}`
            ) as Record<string, unknown>[];

            const summary = (tickets as Record<string, unknown>[]).map((t) => ({
                id: t.id,
                number: t.number,
                title: t.title,
                state: t.state,
                priority: t.priority,
                area: t['area'],
                wlcg_sites: t['wlcg_sites'],
                updated_at: t.updated_at,
            }));

            return JSON.stringify(summary, null, 2);
        })
    );

    server.registerTool(
        "list_tickets",
        {
            title: "List Tickets",
            description: "Search all GGUS helpdesk tickets with optional filters for state, group, area, WLCG sites, and VO support. Returns ticket number, title, state, area, WLCG sites, and last updated time.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                per_page: z
                    .number()
                    .int()
                    .min(1)
                    .max(100)
                    .optional()
                    .describe("Number of tickets to return (default 25, max 100)."),
                state: z
                    .string()
                    .optional()
                    .describe("Filter by ticket state(e.g. 'in progress', 'closed', 'assigned', 'solved')."),
                group: z
                    .string()
                    .optional()
                    .describe("Filter by Zammad group name (e.g. 'GGUS')."),
                area: z
                    .string()
                    .optional()
                    .describe("Filter by GGUS problem area (e.g. 'Storage')."),
                wlcg_sites: z
                    .string()
                    .optional()
                    .describe("Filter by WLCG site name (e.g. 'AGLT2')."),
                vo_support: z
                    .string()
                    .optional()
                    .describe("Filter by virtual organisation (e.g. 'atlas')."),
            }
        },
        async ({ per_page, state, group, area, wlcg_sites, vo_support }) => runTool("list_tickets", { per_page, state, group, area, wlcg_sites, vo_support }, async () => {
            const count = per_page ?? 25;
            const clauses: string[] = [];
            if (state !== undefined) clauses.push(`state.name:"${state}"`);
            if (group !== undefined) clauses.push(`group.name:"${group}"`);
            if (area !== undefined) clauses.push(`area:"${area}"`);
            if (wlcg_sites !== undefined) clauses.push(`wlcg_sites:"${wlcg_sites}"`);
            if (vo_support !== undefined) clauses.push(`vo_support:"${vo_support}"`);

            const query = clauses.length > 0 ? clauses.join(' AND ') : '*';
            const tickets = await ggusGet(
                `/api/v1/tickets/search?query=${encodeURIComponent(query)}&per_page=${count}`
            ) as Record<string, unknown>[];

            const summary = tickets.map((t) => ({
                id: t.id,
                number: t.number,
                title: t.title,
                state: t.state,
                priority: t.priority,
                area: t['area'],
                wlcg_sites: t['wlcg_sites'],
                updated_at: t.updated_at,
            }));

            return JSON.stringify(summary, null, 2);
        })
    );

    server.registerTool(
        "get_ticket",
        {
            title: "Get Ticket",
            description: "Fetch full details of a GGUS ticket by its numeric ID, including GGUS-specific custom fields.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                id: z
                    .number()
                    .int()
                    .positive()
                    .describe("The numeric ticket ID (not the GGUS ticket number — use the Zammad internal ID)."),
            }
        },
        async ({ id }) => runTool("get_ticket", { id }, async () => {
            const data = await ggusGet(`/api/v1/tickets/${id}?expand=true`);
            return JSON.stringify(data, null, 2);
        })
    );

    server.registerTool(
        "create_ticket",
        {
            title: "Create Ticket",
            description: "Create a new GGUS helpdesk ticket.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
            inputSchema: {
                title: z
                    .string()
                    .min(1)
                    .describe("Ticket subject/title."),
                group: z
                    .string()
                    .min(1)
                    .describe("Zammad group to assign the ticket to (e.g. 'GGUS')."),
                body: z
                    .string()
                    .min(1)
                    .describe("Initial ticket body / description."),
                wlcg_sites: z
                    .string()
                    .optional()
                    .describe("Comma-separated WLCG site names affected (e.g. 'AGLT2,MWT2')."),
                vo_support: z
                    .string()
                    .optional()
                    .describe("Virtual organisation (e.g. 'atlas')."),
                area: z
                    .string()
                    .optional()
                    .describe("GGUS problem area (e.g. 'Storage')."),
            }
        },
        async ({ title, group, body, wlcg_sites, vo_support, area }) => runTool("create_ticket", { title, group, body, wlcg_sites, vo_support, area }, async () => {
            const payload: Record<string, unknown> = {
                title,
                group,
                article: {
                    subject: title,
                    body,
                    type: 'note',
                    internal: false,
                },
            };
            if (wlcg_sites !== undefined) payload['wlcg_sites'] = wlcg_sites;
            if (vo_support !== undefined) payload['vo_support'] = vo_support;
            if (area !== undefined) payload['area'] = area;

            const data = await ggusPost('/api/v1/tickets', payload);
            return JSON.stringify(data, null, 2);
        })
    );

    server.registerTool(
        "add_comment",
        {
            title: "Add Comment",
            description: "Post a follow-up article (comment) to an existing GGUS ticket.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
            inputSchema: {
                ticket_id: z
                    .number()
                    .int()
                    .positive()
                    .describe("The numeric Zammad ticket ID to comment on."),
                body: z
                    .string()
                    .min(1)
                    .describe("The comment text to add."),
                internal: z
                    .boolean()
                    .optional()
                    .describe("If true, the comment is internal (not visible to the requester). Defaults to false."),
            }
        },
        async ({ ticket_id, body, internal }) => runTool("add_comment", { ticket_id, body, internal }, async () => {
            const payload = {
                ticket_id,
                subject: 'Follow-up',
                body,
                type: 'note',
                internal: internal ?? false,
            };
            const data = await ggusPost('/api/v1/ticket_articles', payload);
            return JSON.stringify(data, null, 2);
        })
    );

    server.registerTool(
        "get_ticket_articles",
        {
            title: "Get Ticket Articles",
            description: "Fetch all articles (comments, notes, emails) attached to a GGUS ticket by its numeric ticket ID.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                ticket_id: z
                    .number()
                    .int()
                    .positive()
                    .describe("The numeric Zammad ticket ID whose articles should be retrieved."),
            }
        },
        async ({ ticket_id }) => runTool("get_ticket_articles", { ticket_id }, async () => {
            const data = await ggusGet(`/api/v1/ticket_articles/by_ticket/${ticket_id}?expand=true`);
            return JSON.stringify(data, null, 2);
        })
    );

    server.registerTool(
        "update_ticket_state",
        {
            title: "Update Ticket State",
            description: "Change the state of an existing GGUS ticket (e.g. 'open', 'closed', 'solved', 'pending reminder').",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                id: z
                    .number()
                    .int()
                    .positive()
                    .describe("The numeric Zammad ticket ID."),
                state: z
                    .string()
                    .describe("The target state for the ticket (e.g. 'open', 'closed', 'assigned', 'solved', 'pending reminder')."),
            }
        },
        async ({ id, state }) => runTool("update_ticket_state", { id, state }, async () => {
            const data = await ggusPut(`/api/v1/tickets/${id}`, { state });
            return JSON.stringify(data, null, 2);
        })
    );

    return server;
}


const app = express();
app.use(cors({
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['WWW-Authenticate'],
}));
app.use(express.json());
app.use(requestLogger);

app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

app.post('/mcp', requireApiKey, async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    const server = await createGgusMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});


const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    log.info(`GGUS MCP Streamable HTTP Server listening on port ${PORT}`);
});

process.on('SIGINT', async () => {
    log.info('Shutting down server...');
    process.exit(0);
});
