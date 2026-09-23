#!/usr/bin/env node

import express, { Request, Response } from 'express';
import { requireApiKey } from './authMiddleware.js';

import cors from 'cors';

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';
dotenv.config();

// @ts-expect-error ignore `with` keyword
import pkg from './package.json' with { type: 'json' }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADC_DIR = process.env.ADC_DIR || path.resolve(__dirname, '../../ADC');

const product = {
    name: pkg.name,
    version: pkg.version,
};


function getAllMarkdownFiles(dir: string): string[] {
    const results: string[] = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...getAllMarkdownFiles(fullPath));
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                results.push(fullPath);
            }
        }
    } catch (err) {
        console.error(`Error reading directory ${dir}:`, err);
    }
    return results;
}


export async function createKnowledgeMcpServer(): Promise<McpServer> {

    const server = new McpServer(product);

    const mdFiles = getAllMarkdownFiles(ADC_DIR);
    console.log(`Found ${mdFiles.length} Markdown file(s) in ${ADC_DIR}`);

    const resourceMap = new Map<string, string>(); // uri -> filePath

    for (const filePath of mdFiles) {
        const relativePath = path.relative(ADC_DIR, filePath).replace(/\\/g, '/');
        const uri = `knowledge://${relativePath}`;

        resourceMap.set(uri, filePath);

        server.registerResource(
            relativePath,
            uri,
            {
                description: `Markdown document: ${relativePath}`,
                mimeType: 'text/markdown',
            },
            async (resourceUri) => {
                const content = fs.readFileSync(filePath, 'utf-8');
                return {
                    contents: [
                        {
                            uri: resourceUri.href,
                            text: content,
                            mimeType: 'text/markdown',
                        },
                    ],
                };
            }
        );
    }

    server.registerTool(
        'list_resources',
        {
            title: 'List Resources',
            description: 'Returns a list of all available knowledge resource URIs and their names',
            inputSchema: {},
        },
        async () => {
            const resources = Array.from(resourceMap.keys()).map(uri => ({
                uri,
                name: uri.replace('knowledge://', ''),
            }));
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(resources, null, 2),
                    },
                ],
            };
        }
    );

    server.registerTool(
        'get_resource',
        {
            title: 'Get Resource',
            description: 'Fetches the content of a specific knowledge resource by URI',
            inputSchema: {
                uri: z.string().describe('The knowledge:// URI of the resource to fetch'),
            },
        },
        async ({ uri }) => {
            const filePath = resourceMap.get(uri);
            if (!filePath) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Resource not found: ${uri}`,
                        },
                    ],
                    isError: true,
                };
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            return {
                content: [
                    {
                        type: 'text' as const,
                        text: content,
                    },
                ],
            };
        }
    );

    return server;
}



const app = express();
app.use(cors());
app.use(express.json());

app.post('/mcp', requireApiKey, async (req: Request, res: Response) => {
    const server = await createKnowledgeMcpServer();
    try {
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        console.log('Received MCP request:', req.body);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
            console.log('Request closed');
            transport.close();
            server.close();
        });
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: 'Internal server error',
                },
                id: null,
            });
        }
    }
});

app.get('/mcp', requireApiKey, async (req: Request, res: Response) => {
    console.log('Received GET MCP request');
    res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message: "Method not allowed."
        },
        id: null
    }));
});

app.delete('/mcp', requireApiKey, async (req: Request, res: Response) => {
    console.log('Received DELETE MCP request');
    res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
            code: -32000,
            message: "Method not allowed."
        },
        id: null
    }));
});


// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Knowledge MCP Server listening on port ${PORT}`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    process.exit(0);
});
