import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

import type { McpServerConfig } from "../config/config.js";
import type { McpCallToolResult } from "./adapter.js";
import type { McpConnection, McpConnector, McpDiscoveredTool } from "./manager.js";

type EnabledMcpServerConfig = Exclude<McpServerConfig, { readonly enabled: false }>;

export class SdkMcpConnector implements McpConnector {
  async connect(
    _serverName: string,
    rawConfig: EnabledMcpServerConfig,
    signal?: AbortSignal
  ): Promise<McpConnection> {
    const config = expandConfig(rawConfig);
    let toolsChanged: (() => void) | undefined;
    const client = new Client(
      { name: "nekoder", version: "0.1.0" },
      {
        versionNegotiation: {
          mode: "auto",
          probe: { timeoutMs: config.connect_timeout_ms, maxRetries: 0 },
        },
        inputRequired: { autoFulfill: false },
        listChanged: {
          tools: { onChanged: () => { toolsChanged?.(); } },
        },
      }
    );
    const transport = config.transport === "stdio"
      ? new StdioClientTransport({
          command: config.command,
          ...(config.args === undefined ? {} : { args: config.args }),
          env: { ...getDefaultEnvironment(), ...config.env },
          stderr: "pipe",
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers === undefined ? undefined : { headers: config.headers },
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1_000,
            maxReconnectionDelay: 1_000,
            reconnectionDelayGrowFactor: 1,
          },
        });

    if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => undefined);
    const connectSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(config.connect_timeout_ms)])
      : AbortSignal.timeout(config.connect_timeout_ms);
    try {
      await client.connect(transport, {
        signal: connectSignal,
        timeout: config.connect_timeout_ms,
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }

    let closed = false;
    return {
      protocolVersion: client.getNegotiatedProtocolVersion(),
      instructions: client.getInstructions(),
      async listTools(): Promise<readonly McpDiscoveredTool[]> {
        const result = await client.listTools(undefined, { timeout: config.connect_timeout_ms });
        return result.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: tool.inputSchema,
        }));
      },
      async callTool(params, options): Promise<McpCallToolResult> {
        return await client.callTool(params, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeout: config.call_timeout_ms,
        }) as McpCallToolResult;
      },
      onToolsChanged(listener): () => void {
        toolsChanged = listener;
        return () => {
          if (toolsChanged === listener) toolsChanged = undefined;
        };
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        if (transport instanceof StreamableHTTPClientTransport) {
          await transport.terminateSession().catch(() => undefined);
        }
        await client.close();
      },
    };
  }
}

function expandConfig(config: EnabledMcpServerConfig): EnabledMcpServerConfig {
  if (config.transport === "stdio") {
    return {
      ...config,
      ...(config.env === undefined ? {} : {
        env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, expand(value)])),
      }),
    };
  }
  return {
    ...config,
    ...(config.headers === undefined ? {} : {
      headers: Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, expand(value)])),
    }),
  };
}

function expand(value: string): string {
  return value.replace(/\$\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (
    match,
    escapedName: string | undefined,
    expandedName: string | undefined
  ) => {
    if (escapedName !== undefined) return match.slice(1);
    const name = expandedName!;
    const replacement = process.env[name];
    if (replacement === undefined) throw new Error(`Missing environment variable: ${name}`);
    return replacement;
  });
}
