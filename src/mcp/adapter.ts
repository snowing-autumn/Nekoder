import { mcpToolName } from "./naming.js";
import type { Tool, ToolInputSchema, ToolResult } from "../tools/types.js";

export interface McpRemoteTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: ToolInputSchema;
}

export interface McpCallToolResult {
  readonly content?: readonly Record<string, unknown>[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface McpToolClient {
  callTool(
    params: { readonly name: string; readonly arguments: Record<string, unknown> },
    options: { readonly signal?: AbortSignal }
  ): Promise<McpCallToolResult>;
}

export function createMcpTool(options: {
  readonly serverName: string;
  readonly remoteTool: McpRemoteTool;
  readonly timeoutMs: number;
  readonly client: McpToolClient;
}): Tool<Record<string, unknown>, Record<string, unknown>, unknown> {
  const { serverName, remoteTool, timeoutMs, client } = options;
  return {
    name: mcpToolName(serverName, remoteTool.name),
    description: `External MCP Tool from ${serverName}: ${remoteTool.description ?? remoteTool.name}`,
    effect: "execute",
    inputSchema: remoteTool.inputSchema,
    timeoutMs,
    async prepare(input) {
      return { ok: true, data: input };
    },
    async authorizationTarget() {
      return {
        ok: true,
        data: {
          primary: `mcp:${serverName}/${remoteTool.name}`,
          maxApprovalScope: "session",
        },
      };
    },
    async execute(prepared, context) {
      try {
        const result = await client.callTool(
          { name: remoteTool.name, arguments: prepared },
          { ...(context.signal ? { signal: context.signal } : {}) }
        );
        const normalized = normalizeMcpResult(result);
        if (result.isError === true) {
          return failure("execution_failed", "MCP Tool reported an execution error", false, normalized);
        }
        return { ok: true, data: normalized };
      } catch (error) {
        if (context.signal?.aborted) return failure("cancelled", "MCP Tool call was cancelled", false);
        const sdkCode = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
        if (sdkCode === "REQUEST_TIMEOUT") {
          return failure("timeout", "MCP Tool call timed out", true);
        }
        if (["NOT_CONNECTED", "CONNECTION_CLOSED", "SEND_FAILED"].includes(sdkCode ?? "")) {
          return failure("mcp_server_unavailable", "MCP Server is unavailable", false);
        }
        return failure("mcp_protocol_error", "MCP Tool call failed at the protocol boundary", false, {
          cause: safeErrorMessage(error),
        });
      }
    },
  };
}

function normalizeMcpResult(result: McpCallToolResult): Record<string, unknown> {
  const content = (result.content ?? []).map((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    return {
      type: "omitted",
      originalType: typeof block.type === "string" ? block.type : "unknown",
      reason: "unsupported_mcp_content",
    };
  });
  return {
    content,
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
  };
}

function failure(
  code: "execution_failed" | "cancelled" | "timeout" | "mcp_server_unavailable" | "mcp_protocol_error",
  message: string,
  retryable: boolean,
  details?: unknown
): ToolResult<never> {
  return {
    ok: false,
    error: { code, message, retryable, ...(details === undefined ? {} : { details }) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_024) : String(error).slice(0, 1_024);
}
