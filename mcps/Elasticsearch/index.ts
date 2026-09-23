#!/usr/bin/env node

import express, { Request, Response } from 'express';
import { requireApiKey } from './authMiddleware.js';

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    Client,
    estypes,
    ClientOptions,
    Transport,
    TransportRequestOptions,
    TransportRequestParams,
} from "@elastic/elasticsearch";
import fs from "fs";

import dotenv from 'dotenv';
dotenv.config();

// @ts-expect-error ignore `with` keyword
import pkg from './package.json' with { type: 'json' }

// Product metadata, used to generate the request User-Agent header and 
// passed to the McpServer constructor.
const product = {
    name: pkg.name,
    version: pkg.version,
};

// Prepend a path prefix to every request path
class CustomTransport extends Transport {
    private readonly pathPrefix: string;

    constructor(
        opts: ConstructorParameters<typeof Transport>[0],
        pathPrefix: string
    ) {
        super(opts);
        this.pathPrefix = pathPrefix;
    }

    async request(
        params: TransportRequestParams,
        options?: TransportRequestOptions
    ): Promise<any> {
        const newParams = { ...params, path: this.pathPrefix + params.path };
        return super.request(newParams, options);
    }
}

// Configuration schema with auth options
const ConfigSchema = z
    .object({
        url: z
            .string()
            .trim()
            .min(1, "Elasticsearch URL cannot be empty")
            .url("Invalid Elasticsearch URL format")
            .describe("Elasticsearch server URL"),

        apiKey: z
            .string()
            .optional()
            .describe("API key for Elasticsearch authentication"),

        username: z
            .string()
            .optional()
            .describe("Username for Elasticsearch authentication"),

        password: z
            .string()
            .optional()
            .describe("Password for Elasticsearch authentication"),

        caCert: z
            .string()
            .optional()
            .describe("Path to custom CA certificate for Elasticsearch"),

        pathPrefix: z.string().optional().describe("Path prefix for Elasticsearch"),
    })
    .refine(
        (data) => {
            // If username is provided, password must be provided
            if (data.username) {
                return !!data.password;
            }

            // If password is provided, username must be provided
            if (data.password) {
                return !!data.username;
            }

            // If apiKey is provided, it's valid
            if (data.apiKey) {
                return true;
            }

            // No auth is also valid (for local development)
            return true;
        },
        {
            message:
                "Either ES_API_KEY or both ES_USERNAME and ES_PASSWORD must be provided, or no auth for local development",
            path: ["username", "password"],
        }
    );

type ElasticsearchConfig = z.infer<typeof ConfigSchema>;

export async function createElasticsearchMcpServer(
    config: ElasticsearchConfig
) {
    const validatedConfig = ConfigSchema.parse(config);
    const { url, apiKey, username, password, caCert, pathPrefix } =
        validatedConfig;

    const clientOptions: ClientOptions = {
        node: url,
        headers: {
            "user-agent": `${product.name}/${product.version}`,
        },
    };

    if (pathPrefix) {
        const verifiedPathPrefix = pathPrefix;
        clientOptions.Transport = class extends CustomTransport {
            constructor(opts: ConstructorParameters<typeof Transport>[0]) {
                super(opts, verifiedPathPrefix);
            }
        };
    }

    // Set up authentication
    if (apiKey) {
        clientOptions.auth = { apiKey };
    } else if (username && password) {
        clientOptions.auth = { username, password };
    }

    // Set up SSL/TLS certificate if provided
    if (caCert) {
        try {
            const ca = fs.readFileSync(caCert);
            clientOptions.tls = { ca };
        } catch (error) {
            console.error(
                `Failed to read certificate file: ${error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }

    const esClient = new Client(clientOptions);

    const server = new McpServer(product);

    // Tool 1: List indices
    server.tool(
        "list_indices",
        "List all available Elasticsearch indices",
        {
            indexPattern: z
                .string()
                .trim()
                .min(1, "Index pattern is required")
                .describe("Index pattern of Elasticsearch indices to list"),
        },
        async ({ indexPattern }) => {
            try {
                const response = await esClient.cat.indices({
                    index: indexPattern,
                    format: "json",
                });

                const indicesInfo = response.map((index) => ({
                    index: index.index,
                    health: index.health,
                    status: index.status,
                    docsCount: index.docsCount,
                }));

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Found ${indicesInfo.length} indices`,
                        },
                        {
                            type: "text" as const,
                            text: JSON.stringify(indicesInfo, null, 2),
                        },
                    ],
                };
            } catch (error) {
                console.error(
                    `Failed to list indices: ${error instanceof Error ? error.message : String(error)
                    }`
                );
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error: ${error instanceof Error ? error.message : String(error)
                                }`,
                        },
                    ],
                };
            }
        }
    );

    // Tool 2: Get mappings for an index
    server.tool(
        "get_mappings",
        "Get field mappings for a specific Elasticsearch index",
        {
            index: z
                .string()
                .trim()
                .min(1, "Index name is required")
                .describe("Name of the Elasticsearch index to get mappings for"),
        },
        async ({ index }) => {
            try {
                const mappingResponse = await esClient.indices.getMapping({
                    index,
                });

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Mappings for index ${index}:\n ${JSON.stringify(
                                mappingResponse[index]?.mappings || {},
                                null,
                                2
                            )}`,
                        },
                    ],
                };
            } catch (error) {
                console.error(
                    `Failed to get mappings: ${error instanceof Error ? error.message : String(error)
                    }`
                );
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error: ${error instanceof Error ? error.message : String(error)
                                }`,
                        },
                    ],
                };
            }
        }
    );

    // Tool 3: Search an index
    server.tool(
        "search",
        "Perform an Elasticsearch search with the provided query DSL. Parameters: index(string) and queryBody(object) are mandatory parameters.",
        {
            index: z
                .string()
                .trim()
                .min(1, "Index name is required")
                .describe("Name of the Elasticsearch index to search"),
            queryBody: z
                .record(z.any())
                .describe(
                    "DSL query that can include query, size, from, etc"
                )
                .refine(
                    (val) => {
                        try {
                            JSON.parse(JSON.stringify(val));
                            return true;
                        } catch (e) {
                            return false;
                        }
                    },
                    {
                        message: "queryBody must be a valid Elasticsearch query DSL object",
                    }
                ),
        },
        async ({ index, queryBody }) => {
            console.log(`Searching index: ${index} with query:`, queryBody);
            try {
                const searchRequest: estypes.SearchRequest = {
                    index,
                    ...queryBody,
                };
                const result = await esClient.search(searchRequest);
                return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
            } catch (error) {
                console.error(
                    `Search failed: ${error instanceof Error ? error.message : String(error)
                    }`
                );
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error: ${error instanceof Error ? error.message : String(error)
                                }`,
                        },
                    ],
                };
            }
        }
    );

    return server;
}

const config: ElasticsearchConfig = {
    url: process.env.ES_URL || "",
    apiKey: process.env.ES_API_KEY || "",
    username: process.env.ES_USERNAME || "",
    password: process.env.ES_PASSWORD || "",
    caCert: process.env.ES_CA_CERT || "",
    pathPrefix: process.env.ES_PATH_PREFIX || "",
};


const app = express();
app.use(express.json());

app.post('/mcp', requireApiKey, async (req: Request, res: Response) => {
    const server = await createElasticsearchMcpServer(config);
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MCP Stateless Streamable HTTP Server listening on port ${PORT}`);
    // console.debug("Elasticsearch:", config);
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    process.exit(0);
});

// async function main() {
//     // console.log(config);
//     const transport = new StreamableHTTPServerTransport({
//         sessionIdGenerator: undefined,
//     });

//     const server = await createElasticsearchMcpServer(config);
//     await server.connect(transport);

//     process.on("SIGINT", async () => {
//         await server.close();
//         process.exit(0);
//     });
// }

// main().catch((error) => {
//     console.error(
//         "Server error:",
//         error instanceof Error ? error.message : String(error)
//     );
//     process.exit(1);
// });
