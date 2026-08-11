import type { ConversationManager } from "../conversation/conversation.js";
import type { JSONValue, ToolResultPart } from "ai";
import type { ModelInvoker, ModelUsage } from "../model/types.js";
import {
  buildSupplementalSystemTexts,
  type PromptEnvironment,
} from "../prompt/assembler.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolRunner } from "../tools/runner.js";
import { AsyncQueue } from "./async-queue.js";
import type { AgentEvent, AgentOutcome, AgentRunHandle, RunUsage, TaskMode } from "./types.js";

type EventFields<T extends AgentEvent["type"]> = Extract<
  AgentEvent,
  { readonly type: T }
> extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, "agentRunId" | "sequence" | "timestamp" | "type">
    : never
  : never;

type OutcomeSpecific =
  | { status: "completed"; finalText: string; activePlanId?: string }
  | { status: "stopped"; reason: "step_limit_reached" | "unknown_tool_loop" | "permission_denial_loop"; finalizationText?: string }
  | { status: "cancelled" }
  | { status: "model_stopped"; reason: "length" | "content_filter" | "other" | "empty_response" | "protocol_error"; failedStep?: number }
  | { status: "model_failed"; message: string; failedStep?: number }
  | { status: "finalization_failed"; message: string };
type MutableUsage = { -readonly [K in keyof RunUsage]: RunUsage[K] };

export interface AgentSessionDependencies {
  readonly model: ModelInvoker;
  readonly registry: ToolRegistry;
  readonly toolRunner: ToolRunner;
  readonly conversation: ConversationManager;
  readonly workspace: string;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly maxSteps?: number;
  readonly promptContext?: {
    readonly permissionMode: "strict" | "plan" | "default" | "acceptEdit" | "permissive";
    readonly environment: PromptEnvironment;
    readonly environmentProvider?: () => PromptEnvironment;
    readonly customInstructions?: string;
    readonly skills?: readonly string[];
    readonly longTermMemory?: string;
  };
}

export class AgentSession {
  private active = false;
  private permissionMode: "strict" | "plan" | "default" | "acceptEdit" | "permissive";
  private activePlan:
    | { readonly id: string; readonly originalGoal: string; readonly text: string; readonly createdAt: string }
    | undefined;
  private pendingUserGoal = "";

  constructor(private readonly dependencies: AgentSessionDependencies) {
    this.permissionMode = dependencies.promptContext?.permissionMode ?? "default";
    const maxSteps = dependencies.maxSteps ?? 20;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 50) {
      throw new Error("agent.max_steps must be an integer from 1 to 50");
    }
  }

  setPermissionMode(mode: "strict" | "plan" | "default" | "acceptEdit" | "permissive"): void {
    if (this.active) throw new Error("Cannot change Permission Mode during an active run");
    this.permissionMode = mode;
  }

  startUserRun(text: string, taskMode: TaskMode): AgentRunHandle {
    if (this.active) throw new Error("An agent run is already active");
    if (!this.dependencies.registry.isSealed()) throw new Error("ToolRegistry must be sealed");
    if (!text.trim()) throw new Error("User input must not be blank");
    this.activePlan = undefined;
    this.pendingUserGoal = text;
    this.dependencies.conversation.addUserMessage(text);
    return this.start(taskMode);
  }

  executeActivePlan(): AgentRunHandle {
    if (this.active) throw new Error("An agent run is already active");
    const plan = this.activePlan;
    if (!plan) throw new Error("No active plan");
    this.activePlan = undefined;
    this.pendingUserGoal = `执行活动计划 ${plan.id}。`;
    this.dependencies.conversation.addUserMessage(this.pendingUserGoal);
    return this.start("execute");
  }

  private start(taskMode: TaskMode): AgentRunHandle {
    this.active = true;
    const agentRunId = this.dependencies.idFactory?.() ?? crypto.randomUUID();
    const controller = new AbortController();
    let completion: Promise<unknown> | undefined;
    const queue = new AsyncQueue<AgentEvent>(async () => {
      controller.abort();
      await completion;
    });
    let sequence = 0;
    const emit = async <T extends AgentEvent["type"]>(
      type: T,
      fields: EventFields<T>
    ): Promise<void> => {
      await queue.push({
        ...(fields as object),
        agentRunId,
        sequence: ++sequence,
        timestamp: this.now(),
        type,
      } as Extract<AgentEvent, { readonly type: T }>);
    };
    const startedAt = this.now();
    const result = (async () => {
      await emit("run_started", { taskMode });
      const outcome = await this.run(
        agentRunId,
        taskMode,
        controller.signal,
        emit,
        startedAt
      );
      await emit("run_finished", outcome);
      return outcome;
    })()
      .finally(() => {
        this.active = false;
        queue.close();
      });
    completion = result;
    return {
      agentRunId,
      events: queue,
      result,
      cancel: () => controller.abort(),
    };
  }

  private async run(
    agentRunId: string,
    taskMode: TaskMode,
    signal: AbortSignal,
    emit: <T extends AgentEvent["type"]>(
      type: T,
      fields: EventFields<T>
    ) => Promise<void>,
    startedAt: string
  ): Promise<AgentOutcome> {
    const usage: MutableUsage = {};
    const finish = (specific: OutcomeSpecific, stepsCompleted: number): AgentOutcome => ({
      agentRunId,
      stepsCompleted,
      usage,
      startedAt,
      finishedAt: this.now(),
      ...specific,
    } as AgentOutcome);
    let stepsCompleted = 0;
    let consecutiveUnknownBatches = 0;
    let previousDenial: string | undefined;
    let consecutiveDenials = 0;
    let stopReason: "step_limit_reached" | "unknown_tool_loop" | "permission_denial_loop" | undefined;
    const usedToolCallIds = collectToolCallIds(this.dependencies.conversation.getMessages());
    const maxSteps = this.dependencies.maxSteps ?? 20;
    while (stepsCompleted < maxSteps) {
      if (signal.aborted) return finish({ status: "cancelled" }, stepsCompleted);
      const stepNumber = stepsCompleted + 1;
      const exposedTools = visibleTools(this.dependencies.registry, taskMode);
      await emit("step_started", { step: stepNumber });
      let step;
      try {
        step = await this.dependencies.model.collect({
          messages: this.dependencies.conversation.getMessages(),
          tools: exposedTools,
          systemInstructions: this.systemInstructions(taskMode, stepNumber),
          toolChoice: "auto",
          signal,
          onTextDelta: (delta) => emit("text_delta", { step: stepNumber, delta }),
          onToolCall: (call) => emit("tool_call", { step: stepNumber, call }),
        });
      } catch (error) {
        if (signal.aborted) return finish({ status: "cancelled" }, stepsCompleted);
        return finish({ status: "model_failed", message: String(error), failedStep: stepNumber }, stepsCompleted);
      }
      if (signal.aborted) return finish({ status: "cancelled" }, stepsCompleted);
      if (step.toolCalls.some(
        (call) =>
          typeof call.toolCallId !== "string" ||
          !call.toolCallId.trim() ||
          typeof call.toolName !== "string" ||
          !call.toolName.trim()
      )) {
        return finish(
          { status: "model_stopped", reason: "protocol_error", failedStep: stepNumber },
          stepsCompleted
        );
      }
      if (
        step.toolCalls.length > 0 &&
        step.finishReason !== "stop" &&
        step.finishReason !== "tool-calls"
      ) {
        if (step.finishReason === "error") {
          return finish(
            { status: "model_failed", message: "Model reported an error", failedStep: stepNumber },
            stepsCompleted
          );
        }
        const reason = step.finishReason === "content-filter"
          ? "content_filter"
          : step.finishReason === "length"
            ? "length"
            : "other";
        return finish(
          { status: "model_stopped", reason, failedStep: stepNumber },
          stepsCompleted
        );
      }
      this.dependencies.conversation.addMessages(step.responseMessages);
      await emit("assistant_completed", { step: stepNumber });
      if (step.usage) {
        addUsage(usage, step.usage);
        await emit("usage", { step: stepNumber, delta: step.usage, total: { ...usage } });
      }
      if (step.finishReason === "stop" && step.toolCalls.length === 0) {
        stepsCompleted++;
        if (!step.text.trim()) {
          return finish({ status: "model_stopped", reason: "empty_response", failedStep: stepNumber }, stepsCompleted);
        }
        await emit("step_finished", { step: stepNumber });
        if (taskMode === "plan") {
          const activePlanId = this.dependencies.idFactory?.() ?? crypto.randomUUID();
          this.activePlan = {
            id: activePlanId,
            originalGoal: this.pendingUserGoal,
            text: step.text,
            createdAt: this.now(),
          };
          return finish({ status: "completed", finalText: step.text, activePlanId }, stepsCompleted);
        }
        return finish({ status: "completed", finalText: step.text }, stepsCompleted);
      }
      if (step.finishReason === "tool-calls" && step.toolCalls.length === 0) {
        return finish({ status: "model_stopped", reason: "protocol_error", failedStep: stepNumber }, stepsCompleted);
      }
      if (step.finishReason === "length") return finish({ status: "model_stopped", reason: "length", failedStep: stepNumber }, stepsCompleted);
      if (step.finishReason === "content-filter") return finish({ status: "model_stopped", reason: "content_filter", failedStep: stepNumber }, stepsCompleted);
      if (step.finishReason === "other") return finish({ status: "model_stopped", reason: "other", failedStep: stepNumber }, stepsCompleted);
      if (step.finishReason === "error") return finish({ status: "model_failed", message: "Model reported an error", failedStep: stepNumber }, stepsCompleted);
      if (!((step.finishReason === "tool-calls" || step.finishReason === "stop") && step.toolCalls.length > 0)) {
        return finish({ status: "model_failed", message: "Model did not complete the step", failedStep: stepNumber }, stepsCompleted);
      }
      const batch = await this.dependencies.toolRunner.runBatch(step.toolCalls, {
        toolBatchId: this.dependencies.idFactory?.() ?? crypto.randomUUID(),
        workspace: this.dependencies.workspace,
        taskMode,
        signal,
        usedToolCallIds,
        visibleToolNames: new Set(exposedTools.map(({ name }) => name)),
        onEvent: (event) => emit("tool_event", {
          step: stepNumber,
          toolSequence: event.sequence,
          event,
        }),
        onApproval: (event) => emit(
          event.type === "requested" ? "approval_requested" : "approval_resolved",
          { step: stepNumber, ...event }
        ),
      });
      for (const call of step.toolCalls) usedToolCallIds.add(call.toolCallId);
      const toolParts = batch.results.map(
        ({ toolCallId, toolName, result }): ToolResultPart => ({
          type: "tool-result",
          toolCallId,
          toolName,
          output: { type: "json", value: result as JSONValue },
        })
      );
      this.dependencies.conversation.addToolResults(toolParts);
      for (const item of batch.results) {
        await emit("tool_result", {
          step: stepNumber,
          toolBatchId: batch.toolBatchId,
          ...item,
        });
      }
      stepsCompleted++;
      await emit("step_finished", { step: stepNumber });
      if (signal.aborted) return finish({ status: "cancelled" }, stepsCompleted);
      const allUnknown = batch.results.length > 0 && batch.results.every(
        ({ result }) => !result.ok && result.error.code === "unknown_tool"
      );
      consecutiveUnknownBatches = allUnknown ? consecutiveUnknownBatches + 1 : 0;
      if (consecutiveUnknownBatches >= 3) {
        stopReason = "unknown_tool_loop";
        break;
      }
      const denial = denialIdentity(batch.results);
      if (denial === undefined) {
        previousDenial = undefined;
        consecutiveDenials = 0;
      } else if (denial === previousDenial) {
        consecutiveDenials++;
      } else {
        previousDenial = denial;
        consecutiveDenials = 1;
      }
      if (consecutiveDenials >= 3) {
        stopReason = "permission_denial_loop";
        break;
      }
    }
    stopReason ??= "step_limit_reached";
    let finalization;
    try {
      finalization = await this.dependencies.model.collect({
        messages: this.dependencies.conversation.getMessages(),
        tools: [],
        systemInstructions: this.systemInstructions(
          taskMode,
          stepsCompleted + 1,
          boundedFinalizationInstructions(stopReason)
        ),
        toolChoice: "none",
        signal,
        onTextDelta: (delta) => emit("text_delta", { finalization: true, delta }),
      });
    } catch (error) {
      if (signal.aborted) return finish({ status: "cancelled" }, stepsCompleted);
      return finish({ status: "finalization_failed", message: String(error) }, stepsCompleted);
    }
    if (signal.aborted) return finish({ status: "cancelled" }, stepsCompleted);
    if (
      finalization.finishReason !== "stop" ||
      finalization.toolCalls.length > 0 ||
      !finalization.text.trim()
    ) {
      return finish({ status: "finalization_failed", message: "Bounded finalization did not produce a normal non-empty response" }, stepsCompleted);
    }
    this.dependencies.conversation.addMessages(finalization.responseMessages);
    await emit("assistant_completed", { finalization: true });
    if (finalization.usage) {
      addUsage(usage, finalization.usage);
      await emit("usage", {
        delta: finalization.usage,
        total: { ...usage },
        finalization: true,
      });
    }
    return finish(
      { status: "stopped", reason: stopReason, finalizationText: finalization.text },
      stepsCompleted
    );
  }

  private now(): string {
    return (this.dependencies.clock?.() ?? new Date()).toISOString();
  }

  private systemInstructions(
    taskMode: TaskMode,
    modelCallNumber: number,
    callInstructions?: string
  ): string[] {
    const configured = this.dependencies.promptContext;
    return buildSupplementalSystemTexts({
      taskMode,
      permissionMode: this.permissionMode,
      modelCallNumber,
      environment: safeEnvironment(
        configured?.environmentProvider,
        configured?.environment ?? defaultEnvironment(this.dependencies.workspace, this.now())
      ),
      ...(configured?.customInstructions === undefined
        ? {}
        : { customInstructions: configured.customInstructions }),
      ...(configured?.skills === undefined ? {} : { skills: configured.skills }),
      ...(configured?.longTermMemory === undefined
        ? {}
        : { longTermMemory: configured.longTermMemory }),
      ...(callInstructions === undefined ? {} : { callInstructions }),
    });
  }
}

function visibleTools(registry: ToolRegistry, mode: TaskMode) {
  const definitions = registry.definitions();
  return mode === "execute"
    ? definitions
    : definitions.filter(({ name }) => ["read_file", "find_files", "search_text", "run_command"].includes(name));
}

function boundedFinalizationInstructions(reason: "step_limit_reached" | "unknown_tool_loop" | "permission_denial_loop"): string {
  return `Do not use tools. The run stopped because ${reason}. State the stop reason, completed work, unfinished work, and recommended next step.`;
}

function denialIdentity(results: readonly import("../tools/runner.js").ToolCallResult[]): string | undefined {
  if (results.length !== 1) return undefined;
  const result = results[0]?.result;
  if (result?.ok !== false) return undefined;
  if (result.error.code !== "permission_denied" && result.error.code !== "approval_denied") {
    return undefined;
  }
  const details = result.error.details;
  if (typeof details !== "object" || details === null || !("authorizationTarget" in details)) {
    return undefined;
  }
  return `${result.error.code}:${JSON.stringify(details.authorizationTarget)}`;
}

function defaultEnvironment(workspace: string, timestamp: string): PromptEnvironment {
  return {
    workspace,
    platform: process.platform,
    architecture: process.arch,
    shell: process.platform === "win32" ? "powershell" : "sh",
    gitRepository: "unavailable",
    gitBranch: "unavailable",
    model: "unavailable",
    localDate: timestamp.slice(0, 10),
  };
}

function safeEnvironment(
  provider: (() => PromptEnvironment) | undefined,
  fallback: PromptEnvironment
): PromptEnvironment {
  if (!provider) return fallback;
  try {
    return provider();
  } catch {
    return { ...fallback, gitRepository: "unavailable", gitBranch: "unavailable" };
  }
}

function addUsage(total: MutableUsage, delta: ModelUsage): void {
  for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    const value = delta[key];
    if (value !== undefined) total[key] = (total[key] ?? 0) + value;
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
