import type { JSONValue, ToolResultPart } from "ai";

import type { ConversationManager } from "../conversation/conversation.js";
import type { ModelInvoker } from "../model/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolRunner } from "../tools/runner.js";

export type ToolTurnOutcome =
  | { readonly status: "completed"; readonly finalText: string }
  | { readonly status: "cancelled" }
  | { readonly status: "initial_model_failed"; readonly error: Error }
  | { readonly status: "tools_completed_final_response_failed"; readonly error: Error };

export interface ToolTurnDependencies {
  readonly model: ModelInvoker;
  readonly registry: ToolRegistry;
  readonly toolRunner: ToolRunner;
  readonly conversation: ConversationManager;
  readonly workspace: string;
  readonly idFactory?: () => string;
  readonly signal?: AbortSignal;
}

export class ToolTurn {
  private retryableHistoryLength: number | undefined;
  private retryInFlight: Promise<ToolTurnOutcome> | undefined;

  constructor(private readonly dependencies: ToolTurnDependencies) {}

  async run(): Promise<ToolTurnOutcome> {
    const { model, registry, toolRunner, conversation, workspace, signal } = this.dependencies;
    const usedToolCallIds = collectToolCallIds(conversation.getMessages());
    let initial;
    try {
      initial = await model.collect({
        messages: conversation.getMessages(),
        tools: registry.definitions(),
        toolChoice: "auto",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      return { status: "initial_model_failed", error: asError(error) };
    }
    if (signal?.aborted) return { status: "cancelled" };
    conversation.addMessages(initial.responseMessages);
    if (initial.toolCalls.length === 0) {
      return { status: "completed", finalText: initial.text };
    }
    const batch = await toolRunner.runBatch(initial.toolCalls, {
      toolBatchId: this.dependencies.idFactory?.() ?? crypto.randomUUID(),
      workspace,
      usedToolCallIds,
      ...(signal === undefined ? {} : { signal }),
    });
    conversation.addToolResults(
      batch.results.map(
        ({ toolCallId, toolName, result }): ToolResultPart => ({
          type: "tool-result",
          toolCallId,
          toolName,
          output: { type: "json", value: result as JSONValue },
        })
      )
    );
    if (signal?.aborted) return { status: "cancelled" };
    try {
      const final = await model.collect({
        messages: conversation.getMessages(),
        tools: [],
        toolChoice: "none",
        ...(signal === undefined ? {} : { signal }),
      });
      if (signal?.aborted) return { status: "cancelled" };
      conversation.addMessages(final.responseMessages);
      this.retryableHistoryLength = undefined;
      return { status: "completed", finalText: final.text };
    } catch (error) {
      this.retryableHistoryLength = conversation.len();
      return {
        status: "tools_completed_final_response_failed",
        error: asError(error),
      };
    }
  }

  retryFinalResponse(): Promise<ToolTurnOutcome> {
    if (this.retryInFlight) return this.retryInFlight;
    if (
      this.retryableHistoryLength === undefined ||
      this.dependencies.conversation.len() !== this.retryableHistoryLength
    ) {
      throw new Error("This Tool Turn is no longer the latest retryable conversation item");
    }
    this.retryInFlight = this.generateRetry().finally(() => {
      this.retryInFlight = undefined;
    });
    return this.retryInFlight;
  }

  private async generateRetry(): Promise<ToolTurnOutcome> {
    try {
      const final = await this.dependencies.model.collect({
        messages: this.dependencies.conversation.getMessages(),
        tools: [],
        toolChoice: "none",
        ...(this.dependencies.signal === undefined
          ? {}
          : { signal: this.dependencies.signal }),
      });
      if (this.dependencies.signal?.aborted) return { status: "cancelled" };
      this.dependencies.conversation.addMessages(final.responseMessages);
      this.retryableHistoryLength = undefined;
      return { status: "completed", finalText: final.text };
    } catch (error) {
      return {
        status: "tools_completed_final_response_failed",
        error: asError(error),
      };
    }
  }
}

function collectToolCallIds(
  messages: ReturnType<ConversationManager["getMessages"]>
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolCallId) ids.add(part.toolCallId);
    }
  }
  return ids;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
