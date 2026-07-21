/**
 * MCP (Model Context Protocol) client manager.
 *
 * Manages connections to external MCP servers and exposes their tools
 * as native klyxor tools.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  MCP_CONNECT_TIMEOUT_MS,
  MCP_TOOL_CALL_TIMEOUT_MS,
  MCP_MAX_TOOLS_PER_SERVER,
} from "./constants.js";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http transport
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  serverName: string;
}

interface ConnectedServer {
  client: Client;
  config: McpServerConfig;
  tools: McpToolInfo[];
}

export class McpManager {
  private servers: Map<string, ConnectedServer> = new Map();

  async connect(config: McpServerConfig): Promise<string> {
    if (this.servers.has(config.name)) {
      return `MCP server '${config.name}' is already connected. Disconnect first.`;
    }

    const client = new Client(
      { name: "klyxor", version: "1.0.0" }
    );

    try {
      if (config.transport === "stdio") {
        if (!config.command) {
          return `Error: 'command' is required for stdio transport.`;
        }
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          stderr: "pipe",
        });
        await client.connect(transport);
      } else {
        if (!config.url) {
          return `Error: 'url' is required for http transport.`;
        }
        const url = new URL(config.url);
        const opts: Record<string, unknown> = {};
        if (config.headers) {
          opts.requestInit = { headers: config.headers };
        }
        const transport = new StreamableHTTPClientTransport(url, opts as never);
        await client.connect(transport);
      }

      // List tools from the server
      const { tools: rawTools } = await client.listTools();

      const tools: McpToolInfo[] = rawTools
        .slice(0, MCP_MAX_TOOLS_PER_SERVER)
        .map((t) => ({
          name: t.name,
          description: t.description || `MCP tool: ${t.name}`,
          inputSchema: t.inputSchema as McpToolInfo["inputSchema"],
          serverName: config.name,
        }));

      this.servers.set(config.name, { client, config, tools });

      const toolNames = tools.map((t) => t.name).join(", ");
      return `Connected to MCP server '${config.name}'. ${tools.length} tool(s) available: ${toolNames}`;
    } catch (e) {
      // Ensure client is closed on failure
      try {
        await client.close();
      } catch {
        // ignore close errors during cleanup
      }
      return `Error connecting to MCP server '${config.name}': ${e}`;
    }
  }

  async disconnect(name: string): Promise<string> {
    const server = this.servers.get(name);
    if (!server) {
      return `MCP server '${name}' is not connected.`;
    }

    try {
      await server.client.close();
    } catch {
      // ignore close errors
    }

    this.servers.delete(name);
    return `Disconnected from MCP server '${name}'.`;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    // Find the tool across all servers
    for (const [, server] of this.servers) {
      const tool = server.tools.find((t) => t.name === name);
      if (tool) {
        try {
          const result = await Promise.race([
            server.client.callTool({ name, arguments: args }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("Tool call timed out")),
                MCP_TOOL_CALL_TIMEOUT_MS
              )
            ),
          ]);

          // Extract text from result content
          if (result.isError) {
            const content = result.content as Array<{ type: string; text?: string }>;
            const errorMsg = content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
            return `MCP tool error: ${errorMsg || "Unknown error"}`;
          }

          const content = result.content as Array<{ type: string; text?: string }>;
          const text = content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          return text || "(empty result)";
        } catch (e) {
          return `Error calling MCP tool '${name}': ${e}`;
        }
      }
    }

    return `Error: MCP tool '${name}' not found. Use /mcp list to see available tools.`;
  }

  listConnected(): string {
    if (this.servers.size === 0) {
      return "No MCP servers connected.";
    }

    const lines: string[] = [];
    for (const [name, server] of this.servers) {
      const toolCount = server.tools.length;
      const toolNames = server.tools.map((t) => t.name).join(", ");
      lines.push(
        `• ${name} (${server.config.transport}): ${toolCount} tool(s) — ${toolNames}`
      );
    }
    return `Connected MCP servers:\n${lines.join("\n")}`;
  }

  getTools(): McpToolInfo[] {
    const allTools: McpToolInfo[] = [];
    for (const [, server] of this.servers) {
      allTools.push(...server.tools);
    }
    return allTools;
  }

  isConnected(name: string): boolean {
    return this.servers.has(name);
  }
}

/** Singleton MCP manager instance. */
export const mcpManager = new McpManager();
