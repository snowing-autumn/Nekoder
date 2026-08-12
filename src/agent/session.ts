import type { ConversationManager } from "../conversation/conversation.js";
import type { JSONValue, ToolResultPart } from "ai";
import type { ModelInvoker, ModelUsage } from "../model/types.js";
import {
  buildSupplementalSystemTexts,
  type PromptEnvironment,
} from "../prompt/assembler.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolCallResult, ToolRunner } from "../tools/runner.js";
import type { ModelMessage } from "ai";
import { AsyncQueue } from "./async-queue.js";
import type { AgentEvent, AgentOutcome, AgentRunHandle, RunUsage, TaskMode } from "./types.js";
import type { SkillRun } from "../extensions/skill-run.js";
import type { HookEngine, HookEvent, HookResult } from "../extensions/hook-engine.js";

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
  | { status: "stopped"; reason: "step_limit_reached" | "unknown_tool_loop" | "permission_denial_loop" | "hook_denial_loop"; finalizationText?: string }
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
  readonly skillRun?: SkillRun;
  readonly hookEngine?: HookEngine;
  readonly agentKind?: "root" | "subagent";
  readonly automationInbox?: { drain(): readonly { origin: "hook" | "task"; id: string; content: string }[] };
  readonly continuity?: {
    prepareModelCall(messages: readonly ModelMessage[]): Promise<{
      readonly messages: readonly ModelMessage[];
      readonly supplementalInstructions?: readonly string[];
      readonly resetPromptCounter?: boolean;
    }>;
    prepareToolResults?(results: readonly ToolCallResult[]): Promise<readonly ToolCallResult[]>;
    scheduleMemoryUpdate?(outcome: AgentOutcome): void | Promise<void>;
  };
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
  private modelCallNumber = 0;

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
    this.pendingHookMessages.length = 0;
    this.dependencies.skillRun?.begin();
    this.modelCallNumber = 0;
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
      this.dependencies.hookEngine?.startRun(agentRunId);
      if (this.dependencies.hookEngine) {
        await this.applyHooks({ type: "run_start", run: { id: agentRunId, agent: this.dependencies.agentKind ?? "root" } });
        await this.applyHooks({ type: "message_added", run: { id: agentRunId, agent: this.dependencies.agentKind ?? "root" }, message: { role: "user", origin: "user" } });
      }
      const outcome = await this.run(
        agentRunId,
        taskMode,
        controller.signal,
        emit,
        startedAt
      );
      if (this.dependencies.hookEngine && outcome.status !== "completed" && outcome.status !== "cancelled") {
        await this.applyHooks({
          type: "system_error",
          run: { id: agentRunId, agent: this.dependencies.agentKind ?? "root" },
          error: {
            source: "agent_run",
            message: "message" in outcome ? outcome.message : "reason" in outcome ? outcome.reason : "Agent run failed",
            code: outcome.status,
          },
        });
      }
      this.drainAutomationInbox();
      if (this.dependencies.hookEngine) await this.applyHooks({ type: "run_finish", run: { id: agentRunId, agent: this.dependencies.agentKind ?? "root" } });
      await emit("run_finished", outcome);
      return outcome;
    })()
      .finally(async () => {
        await this.dependencies.skillRun?.end();
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
    let previousHookDenial: string | undefined;
    let consecutiveHookDenials = 0;
    let stopReason: "step_limit_reached" | "unknown_tool_loop" | "permission_denial_loop" | "hook_denial_loop" | undefined;
    const usedToolCallIds = collectToolCallIds(this.dependencies.conversation.getMessages());
    const maxSteps = this.dependencies.maxSteps ?? 20;
    while (stepsCompleted < maxSteps) {
      if (signal.aborted) return finish({ status: "cancelled" }, stepsCompleted);
      const stepNumber = stepsCompleted + 1;
      this.drainAutomationInbox();
      const exposedTools = visibleTools(this.dependencies.registry, taskMode);
      await emit("step_started", { step: stepNumber });
      if (this.dependencies.hookEngine) await this.applyHooks({ type: "step_start", run: { id: agentRunId, agent: this.dependencies.agentKind ?? "root" }, step: { number: stepNumber } });
      let step;
      try {
        const prepared = this.dependencies.continuity
          ? await this.dependencies.continuity.prepareModelCall(this.dependencies.conversation.getMessages())
          : { messages: this.dependencies.conversation.getMessages() };
        step = await this.dependencies.model.collect({
          messages: prepared.messages,
          tools: exposedTools,
          systemInstructions: [
            ...this.systemInstructions(taskMode, this.nextModelCallNumber(prepared.resetPromptCounter)),
            ...(prepared.supplementalInstructions ?? []),
          ],
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
        if (this.dependencies.hookEngine) await this.applyHooks({ type: "step_finish", run: { id: agentRunId, agent: this.dependencies.agentKind ?? "root" }, step: { number: stepNumber, outcome: "completed" } });
        if (taskMode === "plan") {
          const activePlanId = this.dependencies.idFactory?.() ?? crypto.randomUUID();
          this.activePlan = {
            id: activePlanId,
            originalGoal: this.pendingUserGoal,
            text: step.text,
            createdAt: this.now(),
          };
          const outcome = finish({ status: "completed", finalText: step.text, activePlanId }, stepsCompleted);
          await this.dependencies.continuity?.scheduleMemoryUpdate?.(outcome);
          return outcome;
        }
        const outcome = finish({ status: "completed", finalText: step.text }, stepsCompleted);
        await this.dependencies.continuity?.scheduleMemoryUpdate?.(outcome);
        return outcome;
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
        ...(this.dependencies.hookEngine === undefined ? {} : {
          postAuthorizationGate: this.dependencies.hookEngine.toolGate(
            { runId: agentRunId, agent: this.dependencies.agentKind ?? "root" },
            (message) => this.pendingHookMessages.push(message)
          ),
        }),
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
      const persistedResults = this.dependencies.continuity?.prepareToolResults
        ? await this.dependencies.continuity.prepareToolResults(batch.results)
        : batch.results;
      const toolParts = persistedResults.map(
        ({ toolCallId, toolName, result }): ToolResultPart => ({
          type: "tool-result",
          toolCallId,
          toolName,
          output: { type: "json", value: result as JSONValue },
        })
      );
      this.dependencies.conversation.addToolResults(toolParts);
      for (const message of this.pendingHookMessages.splice(0)) {
        this.dependencies.conversation.addAutomationMessage("hook", message.hookId, message.content);
      }
      this.drainAutomationInbox();
      for (const item of persistedResults) {
        await emit("tool_result", {
          step: stepNumber,
          toolBatchId: batch.toolBatchId,
          ...item,
        });
        if (this.dependencies.hookEngine) await this.applyHooks({
          type: "tool_after",
          run: { id: agentRunId, agent: this.dependencies.agentKind ?? "root" },
          tool: {
            name: item.toolName,
            outcome: item.result.ok ? "succeeded" : "failed",
            ...(item.result.ok ? {} : { error_code: item.result.error.code }),
          },
        });
      }
      stepsCompleted++;
      await emit("step_finished", { step: stepNumber });
      if (this.dependencies.hookEngine) await this.applyHooks({ type: "step_finish", run: { id: agentRunId, agent: this.dependencies.agentKind ?? "root" }, step: { number: stepNumber } });
      if (signal.aborted) return finish({ status: "cancelled" }, stepsCompleted);
      const allUnknown = persistedResults.length > 0 && persistedResults.every(
        ({ result }) => !result.ok && result.error.code === "unknown_tool"
      );
      consecutiveUnknownBatches = allUnknown ? consecutiveUnknownBatches + 1 : 0;
      if (consecutiveUnknownBatches >= 3) {
        stopReason = "unknown_tool_loop";
        break;
      }
      const denial = denialIdentity(persistedResults);
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
      const hookDenial = hookDenialIdentity(persistedResults);
      if (hookDenial === undefined) {
        previousHookDenial = undefined;
        consecutiveHookDenials = 0;
      } else if (hookDenial === previousHookDenial) {
        consecutiveHookDenials++;
      } else {
        previousHookDenial = hookDenial;
        consecutiveHookDenials = 1;
      }
      if (consecutiveHookDenials >= 3) {
        stopReason = "hook_denial_loop";
        break;
      }
    }
    stopReason ??= "step_limit_reached";
    let finalization;
    try {
      const prepared = this.dependencies.continuity
        ? await this.dependencies.continuity.prepareModelCall(this.dependencies.conversation.getMessages())
        : { messages: this.dependencies.conversation.getMessages() };
      finalization = await this.dependencies.model.collect({
        messages: prepared.messages,
        tools: [],
        systemInstructions: [
          ...this.systemInstructions(
            taskMode,
            this.nextModelCallNumber(prepared.resetPromptCounter),
            boundedFinalizationInstructions(stopReason, taskMode)
          ),
          ...(prepared.supplementalInstructions ?? []),
        ],
        toolChoice: "none",
        signal,
        onTextDelta: (delta) => emit("text_delta", { finalization: true, delta }),
      });
      if (taskMode === "plan" && !isNormalFinalization(finalization)) {
        finalization = await this.dependencies.model.collect({
          messages: [
            ...prepared.messages,
            {
              role: "user",
              content: "The investigation budget is exhausted. Do not request or imitate any tool call. Respond now with only the final actionable implementation plan based on the evidence already collected.",
            },
          ],
          tools: [],
          systemInstructions: [
            ...this.systemInstructions(
              taskMode,
              this.nextModelCallNumber(),
              boundedFinalizationInstructions(stopReason, taskMode)
            ),
            ...(prepared.supplementalInstructions ?? []),
          ],
          toolChoice: "none",
          signal,
          onTextDelta: (delta) => emit("text_delta", { finalization: true, delta }),
        });
      }
    } catch (error) {
      if (signal.aborted) return finish({ status: "cancelled" }, stepsCompleted);
      return finish({ status: "finalization_failed", message: String(error) }, stepsCompleted);
    }
    if (signal.aborted) return finish({ status: "cancelled" }, stepsCompleted);
    if (!isNormalFinalization(finalization)) {
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
    if (taskMode === "plan") {
      const activePlanId = this.dependencies.idFactory?.() ?? crypto.randomUUID();
      this.activePlan = {
        id: activePlanId,
        originalGoal: this.pendingUserGoal,
        text: finalization.text,
        createdAt: this.now(),
      };
      const outcome = finish({
        status: "completed",
        finalText: finalization.text,
        activePlanId,
      }, stepsCompleted);
      await this.dependencies.continuity?.scheduleMemoryUpdate?.(outcome);
      return outcome;
    }
    return finish(
      { status: "stopped", reason: stopReason, finalizationText: finalization.text },
      stepsCompleted
    );
  }

  private now(): string {
    return (this.dependencies.clock?.() ?? new Date()).toISOString();
  }

  private async applyHooks(event: HookEvent): Promise<HookResult> {
    const result = await this.dependencies.hookEngine!.handle(event);
    for (const message of result.messages) {
      this.dependencies.conversation.addAutomationMessage("hook", message.hookId, message.content);
    }
    return result;
  }

  private readonly pendingHookMessages: Array<{ hookId: string; content: string }> = [];

  private drainAutomationInbox(): void {
    for (const message of this.dependencies.automationInbox?.drain() ?? []) {
      this.dependencies.conversation.addAutomationMessage(message.origin, message.id, message.content);
    }
  }

  private nextModelCallNumber(reset = false): number {
    if (reset) this.modelCallNumber = 0;
    return ++this.modelCallNumber;
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
      ...(this.dependencies.skillRun === undefined
        ? {}
        : { activeSkills: this.dependencies.skillRun.supplementalInstructions() }),
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

function boundedFinalizationInstructions(
  reason: "step_limit_reached" | "unknown_tool_loop" | "permission_denial_loop" | "hook_denial_loop",
  taskMode: TaskMode
): string {
  if (taskMode === "plan") {
    return `Do not use or imitate tool calls. Stop investigating because ${reason}. Based only on the evidence already collected, produce the best actionable implementation plan now. Include intended changes, important constraints, and verification. Output only the plan; do not claim implementation is complete.`;
  }
  return `Do not use tools. The run stopped because ${reason}. State the stop reason, completed work, unfinished work, and recommended next step.`;
}

function isNormalFinalization(result: import("../model/types.js").ModelStepResult): boolean {
  return result.finishReason === "stop"
    && result.toolCalls.length === 0
    && Boolean(result.text.trim());
}

function hookDenialIdentity(results: readonly import("../tools/runner.js").ToolCallResult[]): string | undefined {
  if (results.length !== 1) return undefined;
  const result = results[0]?.result;
  if (result?.ok !== false || result.error.code !== "hook_denied") return undefined;
  return JSON.stringify(result.error.details ?? result.error.message);
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
