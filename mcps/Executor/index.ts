#!/usr/bin/env node
import express, { Request, Response } from 'express';
import { requireApiKey } from './authMiddleware.js';

import cors from 'cors';

import { z } from 'zod';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
    Client as SSHClient
} from 'ssh2';


import dotenv from 'dotenv';
dotenv.config();

// @ts-expect-error ignore `with` keyword
import pkg from './package.json' with { type: 'json' }


const executor_ssh_key = process.env.ASSISTANT_SSH_KEY || "";

// Product metadata, used to generate the request User-Agent header and 
// passed to the McpServer constructor.
const product = {
    name: pkg.name,
    version: pkg.version,
};


const SSH_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 120_000;

function sshLogin(host: string, command: string): Promise<{ stdout: string, stderr: string }> {
    const username = "assistant";

    console.log(`SSH login to: ${host}`);
    console.log(`Command: ${command}`);

    const sshPromise = new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
        const conn = new SSHClient();
        conn.on('ready', () => {
            console.log('SSH Connection established');
            conn.exec(command, (err: any, stream: any) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }
                let stdout = '';
                let stderr = '';
                stream.on('close', () => {
                    conn.end();
                    resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
                }).on('data', (data: any) => {
                    stdout += data.toString();
                }).on('error', (err: any) => {
                    conn.end();
                    reject(`SSH stream error: ${err.message}`);
                });
                stream.stderr.on('data', (data: any) => {
                    stderr += data.toString();
                });
            });
        }).on('error', (err: any) => {
            reject(`SSH Connection Error: ${err.message}`);
        }).connect({
            host: host,
            port: 22,
            username: username,
            privateKey: executor_ssh_key,
            readyTimeout: SSH_TIMEOUT_MS,
        });
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s`)), COMMAND_TIMEOUT_MS)
    );

    return Promise.race([sshPromise, timeoutPromise]);
}


export async function createExecutorMcpServer(): Promise<McpServer> {

    const server = new McpServer(product);

    // Tool 1: Execute shell command on remote server via SSH
    server.registerTool(
        "execute_shell_command",
        {
            title: "Execute Shell Command",
            description: "Execute a shell command on a remote server via SSH. Returns a JSON object with stdout and stderr.",
            inputSchema: {
                shellCommand: z
                    .string()
                    .trim()
                    .min(1, "Shell command to execute cannot be empty")
                    .describe("Shell command to execute."),
                loginNode: z
                    .string()
                    .trim()
                    .min(1, "Login node cannot be empty")
                    .describe("The SSH login node to connect to."),
            }
        },
        async ({ shellCommand, loginNode }) => {
            try {
                const { stdout, stderr } = await sshLogin(loginNode, shellCommand);

                console.log(`Command executed. Stdout: ${stdout}, Stderr: ${stderr}`);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `STDIO returned: ${stdout}`,
                        },
                        {
                            type: "text" as const,
                            text: `STDERR returned: ${stderr}`,
                        },
                    ],
                };
            } catch (error) {
                console.error(
                    `Failed to execute shell command: ${error instanceof Error ? error.message : String(error)
                    }`
                );
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                        },
                    ],
                };
            }
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
    const server = await createExecutorMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});


// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MCP Streamable HTTP Server listening on port ${PORT}`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    process.exit(0);
});

