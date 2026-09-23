#!/usr/bin/env node
import express, { Request, Response } from 'express';
import { requireApiKey } from './authMiddleware.js';

import cors from 'cors';
import fs from 'fs';
import https from 'https';
import path from 'path';

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


export async function createCricMcpServer(): Promise<McpServer> {

    const server = new McpServer(product);

    server.registerTool(
        "list_rc_sites",
        {
            title: "List RC Sites",
            description: "List ATLAS RC sites from CRIC, optionally filtered by name, status, or state.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                name: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by RC site name (e.g. 'AGLT2')."),
                status: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by site status (e.g. 'online', 'offline')."),
                state: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by site state (e.g. 'ACTIVE')."),
            }
        },
        async ({ name, status, state }) => {
            const proxyPath = process.env.X509_USER_PROXY;
            const certDir = process.env.X509_CERT_DIR;

            if (!proxyPath || !certDir) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: X509_USER_PROXY or X509_CERT_DIR environment variables not set",
                    }],
                };
            }

            let proxyPem: Buffer;
            let caCerts: Buffer[];
            try {
                proxyPem = fs.readFileSync(proxyPath);
                caCerts = fs.readdirSync(certDir)
                    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
                    .map(f => fs.readFileSync(path.join(certDir, f)));
            } catch (err) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error reading certificate files: ${err}`,
                    }],
                };
            }

            const agent = new https.Agent({
                cert: proxyPem,
                key: proxyPem,
                ca: caCerts,
                rejectUnauthorized: true,
            });

            const params = new URLSearchParams({ json: '' });
            if (name) params.set('name', name);
            if (status) params.set('status', status);
            if (state) params.set('state', state);
            const url = `https://atlas-cric.cern.ch/api/core/rcsite/query/?${params}`;

            const data = await new Promise<string>((resolve, reject) => {
                https.get(
                    url,
                    { agent },
                    (res) => {
                        let body = '';
                        res.on('data', (chunk: string) => body += chunk);
                        res.on('end', () => resolve(body));
                    }
                ).on('error', reject);
            });

            return {
                content: [{
                    type: "text" as const,
                    text: data,
                }],
            };
        }
    );

    server.registerTool(
        "list_queue_statuses",
        {
            title: "List Queue Statuses",
            description: "List ATLAS PanDA queue statuses from CRIC, optionally filtered by queue name or queue state.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                pandaqueue: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by PanDA queue name (e.g. 'AGLT2_ATLAS_INSTALL')."),
                state: z
                    .enum(['ACTIVE', 'INACTIVE', 'DISABLED', 'DELETED', 'ANY'])
                    .optional()
                    .describe("Filter queues by state."),
                status: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by queue status value (e.g. 'TEST', 'ONLINE', 'OFFLINE')."),
            }
        },
        async ({ pandaqueue, state, status }) => {
            const proxyPath = process.env.X509_USER_PROXY;
            const certDir = process.env.X509_CERT_DIR;

            if (!proxyPath || !certDir) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: X509_USER_PROXY or X509_CERT_DIR environment variables not set",
                    }],
                };
            }

            let proxyPem: Buffer;
            let caCerts: Buffer[];
            try {
                proxyPem = fs.readFileSync(proxyPath);
                caCerts = fs.readdirSync(certDir)
                    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
                    .map(f => fs.readFileSync(path.join(certDir, f)));
            } catch (err) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error reading certificate files: ${err}`,
                    }],
                };
            }

            const agent = new https.Agent({
                cert: proxyPem,
                key: proxyPem,
                ca: caCerts,
                rejectUnauthorized: true,
            });

            const params = new URLSearchParams({ json: '' });
            if (pandaqueue) params.set('pandaqueue', pandaqueue);
            if (state) params.set('state', state);
            if (status) params.set('value', status);
            const url = `https://atlas-cric.cern.ch/api/atlas/pandaqueuestatus/query/?${params}`;

            const data = await new Promise<string>((resolve, reject) => {
                https.get(
                    url,
                    { agent },
                    (res) => {
                        let body = '';
                        res.on('data', (chunk: string) => body += chunk);
                        res.on('end', () => resolve(body));
                    }
                ).on('error', reject);
            });

            return {
                content: [{
                    type: "text" as const,
                    text: data,
                }],
            };
        }
    );

    server.registerTool(
        "list_ddm_endpoint_statuses",
        {
            title: "List DDM Endpoint Statuses",
            description: "List ATLAS DDM endpoint statuses from CRIC, optionally filtered by site or endpoint status.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                ddmendpoint: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by DDM endpoint name (e.g. 'AGLT2_DATADISK')."),
            }
        },
        async ({ ddmendpoint }) => {
            const proxyPath = process.env.X509_USER_PROXY;
            const certDir = process.env.X509_CERT_DIR;

            if (!proxyPath || !certDir) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: X509_USER_PROXY or X509_CERT_DIR environment variables not set",
                    }],
                };
            }

            let proxyPem: Buffer;
            let caCerts: Buffer[];
            try {
                proxyPem = fs.readFileSync(proxyPath);
                caCerts = fs.readdirSync(certDir)
                    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
                    .map(f => fs.readFileSync(path.join(certDir, f)));
            } catch (err) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error reading certificate files: ${err}`,
                    }],
                };
            }

            const agent = new https.Agent({
                cert: proxyPem,
                key: proxyPem,
                ca: caCerts,
                rejectUnauthorized: true,
            });

            const params = new URLSearchParams({ json: '' });
            if (ddmendpoint) params.set('ddmendpoint', ddmendpoint);
            const url = `https://atlas-cric.cern.ch/api/atlas/ddmendpointstatus/query/?${params}`;

            const data = await new Promise<string>((resolve, reject) => {
                https.get(
                    url,
                    { agent },
                    (res) => {
                        let body = '';
                        res.on('data', (chunk: string) => body += chunk);
                        res.on('end', () => resolve(body));
                    }
                ).on('error', reject);
            });

            return {
                content: [{
                    type: "text" as const,
                    text: data,
                }],
            };
        }
    );

    server.registerTool(
        "list_panda_queues",
        {
            title: "List PanDA Queues",
            description: "List ATLAS PanDA queues from CRIC, optionally filtered by name, state, or status.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                name: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by queue name (e.g. 'AGLT2_TEST')."),
                state: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by queue state (e.g. 'ACTIVE')."),
                status: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by queue status (e.g. 'online', 'offline')."),
            }
        },
        async ({ name, state, status }) => {
            const proxyPath = process.env.X509_USER_PROXY;
            const certDir = process.env.X509_CERT_DIR;

            if (!proxyPath || !certDir) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: X509_USER_PROXY or X509_CERT_DIR environment variables not set",
                    }],
                };
            }

            let proxyPem: Buffer;
            let caCerts: Buffer[];
            try {
                proxyPem = fs.readFileSync(proxyPath);
                caCerts = fs.readdirSync(certDir)
                    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
                    .map(f => fs.readFileSync(path.join(certDir, f)));
            } catch (err) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error reading certificate files: ${err}`,
                    }],
                };
            }

            const agent = new https.Agent({
                cert: proxyPem,
                key: proxyPem,
                ca: caCerts,
                rejectUnauthorized: true,
            });

            const params = new URLSearchParams({ json: '' });
            if (name) params.set('name', name);
            if (state) params.set('state', state);
            if (status) params.set('status', status);
            const url = `https://atlas-cric.cern.ch/api/atlas/pandaqueue/query/?${params}`;

            const data = await new Promise<string>((resolve, reject) => {
                https.get(
                    url,
                    { agent },
                    (res) => {
                        let body = '';
                        res.on('data', (chunk: string) => body += chunk);
                        res.on('end', () => resolve(body));
                    }
                ).on('error', reject);
            });

            return {
                content: [{
                    type: "text" as const,
                    text: data,
                }],
            };
        }
    );

    server.registerTool(
        "list_panda_queue_tags",
        {
            title: "List PanDA Queue Tags",
            description: "List ATLAS PanDA queue tags from CRIC, optionally filtered by queue name.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
            inputSchema: {
                panda_queue: z
                    .string()
                    .trim()
                    .optional()
                    .describe("Filter by PanDA queue name (e.g. 'AGLT2_TEST')."),
            }
        },
        async ({ panda_queue }) => {
            const proxyPath = process.env.X509_USER_PROXY;
            const certDir = process.env.X509_CERT_DIR;

            if (!proxyPath || !certDir) {
                return {
                    content: [{
                        type: "text" as const,
                        text: "Error: X509_USER_PROXY or X509_CERT_DIR environment variables not set",
                    }],
                };
            }

            let proxyPem: Buffer;
            let caCerts: Buffer[];
            try {
                proxyPem = fs.readFileSync(proxyPath);
                caCerts = fs.readdirSync(certDir)
                    .filter(f => f.endsWith('.pem') || f.endsWith('.crt'))
                    .map(f => fs.readFileSync(path.join(certDir, f)));
            } catch (err) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error reading certificate files: ${err}`,
                    }],
                };
            }

            const agent = new https.Agent({
                cert: proxyPem,
                key: proxyPem,
                ca: caCerts,
                rejectUnauthorized: true,
            });

            const params = new URLSearchParams({ json: '', preset: 'tags' });
            if (panda_queue) params.set('panda_queue', panda_queue);
            const url = `https://atlas-cric.cern.ch/api/atlas/pandaqueue/query/?${params}`;

            const data = await new Promise<string>((resolve, reject) => {
                https.get(
                    url,
                    { agent },
                    (res) => {
                        let body = '';
                        res.on('data', (chunk: string) => body += chunk);
                        res.on('end', () => resolve(body));
                    }
                ).on('error', reject);
            });

            return {
                content: [{
                    type: "text" as const,
                    text: data,
                }],
            };
        }
    );

    return server;
}


const app = express();
app.use(cors({
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

app.post('/mcp', requireApiKey, async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    const server = await createCricMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});


const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`CRIC MCP Streamable HTTP Server listening on port ${PORT}`);
});

process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    process.exit(0);
});
