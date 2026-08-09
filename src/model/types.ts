import type { ModelMessage } from "ai";

import type { ToolInputSchema } from "../tools/types.js";

export type FinishReason =
  | "stop"
  | "tool-calls"
  | "length"
  | "content-filter"
  | "error"
  | "other";

export interface NormalizedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface ModelStepResult {
  readonly text: string;
  readonly toolCalls: readonly NormalizedToolCall[];
  readonly responseMessages: readonly ModelMessage[];
  readonly finishReason: FinishReason;
  readonly rawFinishReason?: string;
  readonly usage?: ModelUsage;
  readonly warnings: readonly unknown[];
  readonly providerMetadata?: unknown;
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

export interface ModelCollectRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly instructions?: string;
  readonly toolChoice?: "auto" | "none";
  readonly signal?: AbortSignal;
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
  readonly onToolCall?: (call: NormalizedToolCall) => void | Promise<void>;
}

export interface ModelInvoker {
  collect(request: ModelCollectRequest): Promise<ModelStepResult>;
}
