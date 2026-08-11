import Ajv2020 from "ajv/dist/2020.js";

import type { McpServerConfig } from "../config/config.js";
import type { ToolInputSchema } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { createMcpTool, type McpCallToolResult, type McpToolClient } from "./adapter.js";

export type McpDiagnosticStatus =
  | "connected"
  | "disabled"
  | "untrusted_skipped"
  | "connection_failed"
  | "discovery_failed"
  | "closed";

export interface McpDiagnostic {
  readonly server: string;
  readonly transport: "stdio" | "http";
  readonly status: McpDiagnosticStatus;
  readonly protocolVersion?: string;
  readonly instructionsPresent: boolean;
  readonly discoveredTools: number;
  readonly registeredTools: number;
  readonly skippedTools: number;
  readonly restartRequired: boolean;
  readonly error?: string;
}

export interface McpConnection extends McpToolClient {
  readonly protocolVersion?: string;
  readonly instructions?: string;
  listTools(): Promise<readonly McpDiscoveredTool[]>;
  onToolsChanged?(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface McpDiscoveredTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export interface McpConnector {
  connect(
    serverName: string,
    config: Exclude<McpServerConfig, { readonly enabled: false }>,
    signal?: AbortSignal
  ): Promise<McpConnection>;
}

export interface McpTrustController {
  isTrusted(workspace: string, serverName: string, config: McpServerConfig): boolean;
  requestTrust?(request: {
    readonly workspace: string;
    readonly server: string;
    readonly config: Exclude<McpServerConfig, { readonly enabled: false }>;
  }): Promise<boolean>;
  trust?(workspace: string, serverName: string, config: McpServerConfig): Promise<void>;
}

interface StartedServer {
  readonly server: string;
  readonly config: Exclude<McpServerConfig, { readonly enabled: false }>;
  readonly connection: McpConnection;
  readonly tools: readonly McpDiscoveredTool[];
}

const MAX_DESCRIPTION_BYTES = 4 * 1024;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_MCP_TOOLS = 128;
const MAX_DEFINITION_BYTES = 256 * 1024;

export class McpManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly states = new Map<string, McpDiagnostic>();

  constructor(private readonly connector: McpConnector) {}

  async start(
    configs: Readonly<Record<string, McpServerConfig>>,
    registry: ToolRegistry,
    context: {
      readonly workspace: string;
      readonly signal?: AbortSignal;
      readonly trust?: McpTrustController;
    }
  ): Promise<void> {
    const enabled: Array<[string, Exclude<McpServerConfig, { readonly enabled: false }>]> = [];
    for (const [server, config] of Object.entries(configs).sort(([left], [right]) => left.localeCompare(right))) {
      if (isDisabled(config)) {
        this.states.set(server, emptyDiagnostic(server, "stdio", "disabled"));
        continue;
      }
      if (context.trust && !context.trust.isTrusted(context.workspace, server, config)) {
        const accepted = context.trust.requestTrust
          ? await context.trust.requestTrust({ workspace: context.workspace, server, config })
          : false;
        if (!accepted) {
          this.states.set(server, emptyDiagnostic(server, config.transport, "untrusted_skipped"));
          continue;
        }
        await context.trust.trust?.(context.workspace, server, config);
      }
      enabled.push([server, config]);
    }

    const attempts = enabled.map(async ([server, config]): Promise<StartedServer | undefined> => {
      try {
        const connection = await this.connector.connect(server, config, context.signal);
        this.connections.set(server, connection);
        try {
          const tools = await connection.listTools();
          return { server, config, connection, tools };
        } catch {
          this.states.set(server, {
            ...emptyDiagnostic(server, config.transport, "discovery_failed"),
            protocolVersion: connection.protocolVersion,
            instructionsPresent: connection.instructions !== undefined,
            error: "Tool discovery failed",
          });
          await safeClose(connection);
          this.connections.delete(server);
          return undefined;
        }
      } catch {
        this.states.set(server, {
          ...emptyDiagnostic(server, config.transport, "connection_failed"),
          error: "Connection failed",
        });
        return undefined;
      }
    });

    const started = (await Promise.all(attempts))
      .filter((entry): entry is StartedServer => entry !== undefined)
      .sort((left, right) => left.server.localeCompare(right.server));
    const ajv = new Ajv2020({ strict: true });
    let registeredCount = 0;
    let definitionBytes = 0;

    for (const entry of started) {
      let registeredTools = 0;
      let skippedTools = 0;
      const tools = [...entry.tools].sort((left, right) => left.name.localeCompare(right.name));
      for (const remoteTool of tools) {
        const descriptionBytes = Buffer.byteLength(remoteTool.description ?? "", "utf8");
        const schemaJson = safeJson(remoteTool.inputSchema);
        const schemaBytes = schemaJson === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(schemaJson, "utf8");
        const schema = remoteTool.inputSchema;
        const validShape = isRecord(schema) && schema.type === "object";
        let validSchema = validShape;
        if (validSchema) {
          try { ajv.compile(schema as Parameters<typeof ajv.compile>[0]); } catch { validSchema = false; }
        }
        const estimatedDefinitionBytes = Buffer.byteLength(remoteTool.name, "utf8")
          + descriptionBytes + schemaBytes;
        if (
          descriptionBytes > MAX_DESCRIPTION_BYTES
          || schemaBytes > MAX_SCHEMA_BYTES
          || !validSchema
          || registeredCount >= MAX_MCP_TOOLS
          || definitionBytes + estimatedDefinitionBytes > MAX_DEFINITION_BYTES
        ) {
          skippedTools++;
          continue;
        }
        try {
          registry.register(createMcpTool({
            serverName: entry.server,
            remoteTool: {
              name: remoteTool.name,
              ...(remoteTool.description === undefined ? {} : { description: remoteTool.description }),
              inputSchema: schema as ToolInputSchema,
            },
            timeoutMs: entry.config.call_timeout_ms,
            client: entry.connection,
          }));
          registeredTools++;
          registeredCount++;
          definitionBytes += estimatedDefinitionBytes;
        } catch {
          skippedTools++;
        }
      }
      this.states.set(entry.server, {
        server: entry.server,
        transport: entry.config.transport,
        status: "connected",
        ...(entry.connection.protocolVersion === undefined
          ? {}
          : { protocolVersion: entry.connection.protocolVersion }),
        instructionsPresent: entry.connection.instructions !== undefined,
        discoveredTools: tools.length,
        registeredTools,
        skippedTools,
        restartRequired: false,
      });
      entry.connection.onToolsChanged?.(() => {
        const current = this.states.get(entry.server);
        if (current) this.states.set(entry.server, { ...current, restartRequired: true });
      });
    }
  }

  diagnostics(): McpDiagnostic[] {
    return [...this.states.values()].sort((left, right) => left.server.localeCompare(right.server));
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.entries()].map(async ([server, connection]) => {
      await safeClose(connection);
      const previous = this.states.get(server);
      if (previous) this.states.set(server, { ...previous, status: "closed" });
    }));
    this.connections.clear();
  }
}

function emptyDiagnostic(
  server: string,
  transport: "stdio" | "http",
  status: McpDiagnosticStatus
): McpDiagnostic {
  return {
    server,
    transport,
    status,
    instructionsPresent: false,
    discoveredTools: 0,
    registeredTools: 0,
    skippedTools: 0,
    restartRequired: false,
  };
}

async function safeClose(connection: McpConnection): Promise<void> {
  try { await connection.close(); } catch { /* diagnostic remains bounded */ }
}

function safeJson(value: unknown): string | undefined {
  try { return JSON.stringify(value); } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDisabled(config: McpServerConfig): config is Extract<McpServerConfig, { readonly enabled: false }> {
  return "enabled" in config && config.enabled === false;
}

export type { McpCallToolResult };
