import type { ModelMessage } from "ai";
import type { AgentOutcome } from "../agent/types.js";
import type { ConversationManager } from "../conversation/conversation.js";
import type { ToolCallResult } from "../tools/runner.js";
import type { ControllerResult, SessionController } from "../tui/session-controller.js";
import { ContextCompactor, ContextCompactorError, type CompactionResult } from "./context-compactor.js";
import { InstructionLoader, type InstructionSnapshot } from "./instruction-loader.js";
import { MemoryCatalog, type MemoryFilter, type MemoryNote, type MemoryNoteSummary } from "./memory-catalog.js";
import type { MemoryJobRunner } from "./memory-job-runner.js";
import { SessionJournal, type SessionProjection, type SessionSnapshot } from "./session-journal.js";
import { ToolArtifactStore } from "./tool-artifact-store.js";
import type { HookEvent } from "../extensions/hook-engine.js";

export type RuntimeCommand =
  | { readonly kind: "plan.execute" }
  | { readonly kind: "context.compact" }
  | { readonly kind: "session.new" }
  | { readonly kind: "session.resume"; readonly sessionId: string }
  | { readonly kind: "session.delete"; readonly sessionId: string }
  | { readonly kind: "memory.forget"; readonly memoryId: string }
  | { readonly kind: "confirmation.resolve"; readonly confirmationId: string; readonly accepted: boolean };

export type RuntimeQuery =
  | { readonly kind: "runtime.status" }
  | { readonly kind: "session.current" }
  | { readonly kind: "session.list"; readonly limit?: number }
  | { readonly kind: "memory.status" }
  | ({ readonly kind: "memory.list" } & MemoryFilter)
  | { readonly kind: "memory.show"; readonly memoryId: string };

export type RuntimeCommandResult =
  | { readonly kind: "run_started"; readonly agentRunId: string }
  | { readonly kind: "success"; readonly message: string; readonly clearTimeline?: boolean }
  | { readonly kind: "info"; readonly message: string }
  | { readonly kind: "confirmation_required"; readonly confirmationId: string; readonly message: string }
  | { readonly kind: "blocked"; readonly code: "run_active" | "no_active_plan" | "not_found" | "operation_failed"; readonly message: string };

export type RuntimeQueryResult =
  | { readonly kind: "runtime.status"; readonly value: RuntimeStatus }
  | { readonly kind: "session.current"; readonly value: SessionProjection }
  | { readonly kind: "session.list"; readonly value: readonly SessionProjection[] }
  | { readonly kind: "memory.status"; readonly value: ReturnType<MemoryCatalog["status"]> }
  | { readonly kind: "memory.list"; readonly value: readonly MemoryNoteSummary[] }
  | { readonly kind: "memory.show"; readonly value: MemoryNote };

export interface RuntimeStatus {
  readonly session: SessionProjection;
  readonly compaction: ReturnType<ContextCompactor["status"]>;
  readonly memory: ReturnType<MemoryCatalog["status"]>;
  readonly memoryJobs?: ReturnType<MemoryJobRunner["status"]>;
}

export interface WorkspaceRuntimeOptions {
  readonly controller: SessionController;
  readonly conversation: ConversationManager;
  readonly journal: SessionJournal;
  readonly memory: MemoryCatalog;
  readonly instructions: InstructionLoader;
  readonly compactor: ContextCompactor;
  readonly artifacts: ToolArtifactStore;
  readonly memoryJobs?: MemoryJobRunner;
  readonly onMemoryUpdate?: (outcome: AgentOutcome) => void | Promise<void>;
  readonly prepareRun?: () => void | Promise<void>;
  readonly onLifecycle?: (event: HookEvent) => void | Promise<void>;
}

type PendingConfirmation =
  | { readonly kind: "session.delete"; readonly sessionId: string }
  | { readonly kind: "memory.forget"; readonly memoryId: string };

/**
 * Deep continuity Module. TUI and Slash handlers cross only this Interface; JSONL,
 * Markdown, compaction, and Tool Artifact rules remain inside its Implementation.
 */
export class WorkspaceRuntime {
  private instructionSnapshot: InstructionSnapshot = {
    layers: [], trustedInstructions: "", referenceData: "",
  };
  private pending = new Map<string, PendingConfirmation>();
  private persistedMessages = 0;
  private persistenceTail: Promise<void> = Promise.resolve();
  private resumeReminder: string | undefined;

  constructor(private readonly options: WorkspaceRuntimeOptions) {}

  async initialize(): Promise<void> {
    await this.options.memory.refresh();
    const expired = await this.options.journal.cleanupExpired();
    await Promise.all(expired.map((id) => this.options.artifacts.deleteSessionArtifacts(id)));
    let current = await this.options.journal.current();
    if (!current) current = await this.options.journal.new();
    await this.options.onLifecycle?.({ type: "session_start", session: { id: current.projection.id, reason: "created" } });
    if (this.options.memoryJobs) {
      const input = this.memoryMaintenanceInput();
      await Promise.allSettled([
        this.options.memoryJobs.maybeOrganize({ scope: "project", input }),
        this.options.memoryJobs.maybeOrganize({ scope: "user", input }),
      ]);
    }
  }

  async startRun(input: { readonly modelText: string; readonly displayText: string }): Promise<ControllerResult> {
    if (this.options.controller.getSnapshot().runStatus === "running") return runActiveControllerResult();
    await this.options.prepareRun?.();
    this.instructionSnapshot = await this.options.instructions.load();
    await this.options.memory.refresh();
    const result = this.options.controller.startUserRun(input.modelText);
    if (!result.ok) return result;
    const persistedThroughUser = this.options.conversation.len();
    await this.options.journal.append({
      type: "message",
      role: "user",
      content: input.modelText,
      submittedToAgent: true,
      ...(input.displayText === input.modelText ? {} : {
        rawSlashInput: input.displayText,
        expandedText: input.modelText,
      }),
    });
    this.persistedMessages = persistedThroughUser;
    this.persistenceTail = this.options.controller.whenIdle().then(() => this.persistConversationTail());
    return result;
  }

  async execute(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.kind === "confirmation.resolve") return this.resolveConfirmation(command.confirmationId, command.accepted);
    if (this.options.controller.getSnapshot().runStatus === "running") {
      return { kind: "blocked", code: "run_active", message: "An agent run is already active" };
    }
    await this.persistenceTail;
    try {
      switch (command.kind) {
        case "plan.execute": {
          await this.options.prepareRun?.();
          this.instructionSnapshot = await this.options.instructions.load();
          await this.options.memory.refresh();
          const result = this.options.controller.executeActivePlan();
          if (!result.ok) {
            return { kind: "blocked", code: result.code === "run_active" ? "run_active" : "no_active_plan", message: result.message };
          }
          if (result.action !== "run_started") return { kind: "blocked", code: "operation_failed", message: "Active Plan did not start a Run" };
          const persistedThroughUser = this.options.conversation.len();
          const user = this.options.conversation.getMessages().at(-1);
          if (user?.role === "user") await this.options.journal.append({ type: "message", role: "user", content: user.content, submittedToAgent: true });
          this.persistedMessages = persistedThroughUser;
          this.persistenceTail = this.options.controller.whenIdle().then(() => this.persistConversationTail());
          return { kind: "run_started", agentRunId: result.agentRunId };
        }
        case "context.compact":
          return formatCompaction(await this.options.compactor.compact(true));
        case "session.new": {
          await this.persistConversationTail();
          const previous = await this.options.journal.current();
          if (previous) await this.options.onLifecycle?.({ type: "session_end", session: { id: previous.projection.id, reason: "replaced" } });
          const snapshot = await this.options.journal.new(this.options.controller.getSnapshot().taskMode);
          this.options.conversation.replaceMessages([]);
          this.persistedMessages = 0;
          await this.options.onLifecycle?.({ type: "session_start", session: { id: snapshot.projection.id, reason: "created" } });
          return { kind: "success", message: `Created Session ${snapshot.projection.id}`, clearTimeline: true };
        }
        case "session.resume": {
          await this.persistConversationTail();
          const target = (await this.options.journal.list({ limit: Number.MAX_SAFE_INTEGER }))
            .find(({ id }) => id === command.sessionId);
          if (!target) return notFound(`Session not found: ${command.sessionId}`);
          const gapMs = Date.now() - Date.parse(target.updatedAt);
          const previous = await this.options.journal.current();
          if (previous && previous.projection.id !== command.sessionId) {
            await this.options.onLifecycle?.({ type: "session_end", session: { id: previous.projection.id, reason: "resumed_another" } });
          }
          const snapshot = await this.options.journal.resume(command.sessionId);
          this.restoreConversation(snapshot);
          this.resumeReminder = gapMs > 24 * 60 * 60 * 1_000
            ? `This Session was resumed after ${Math.floor(gapMs / (60 * 60 * 1_000))} hours. Revalidate time-sensitive assumptions and external state before relying on the earlier history.`
            : undefined;
          if (!previous || previous.projection.id !== snapshot.projection.id) {
            await this.options.onLifecycle?.({ type: "session_start", session: { id: snapshot.projection.id, reason: "resumed" } });
          }
          return { kind: "success", message: `Resumed Session ${snapshot.projection.id}`, clearTimeline: true };
        }
        case "session.delete": {
          const sessions = await this.options.journal.list({ limit: Number.MAX_SAFE_INTEGER });
          const target = sessions.find(({ id }) => id === command.sessionId);
          if (!target) return notFound(`Session not found: ${command.sessionId}`);
          const confirmationId = `session-delete:${command.sessionId}`;
          this.pending.set(confirmationId, command);
          return {
            kind: "confirmation_required",
            confirmationId,
            message: `Delete Session ${target.id} (${target.title || "untitled"}, ${target.messageCount} messages) and its Tool Artifacts? [Y] Confirm  [N] Cancel`,
          };
        }
        case "memory.forget": {
          await this.options.memory.refresh();
          let note: MemoryNote;
          try { note = this.options.memory.show(command.memoryId); }
          catch { return notFound(`Memory Note not found: ${command.memoryId}`); }
          const confirmationId = `memory-forget:${command.memoryId}`;
          this.pending.set(confirmationId, command);
          return {
            kind: "confirmation_required",
            confirmationId,
            message: `Forget ${note.id} (${note.scope}/${note.type}) ${note.title}? The Session history is not deleted. [Y] Confirm  [N] Cancel`,
          };
        }
      }
    } catch (error) {
      if (!(command.kind === "context.compact" && error instanceof ContextCompactorError)) {
        await this.options.onLifecycle?.({ type: "system_error", error: {
          source: command.kind,
          message: boundedMessage(error),
          ...(error instanceof Error && "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
        } });
      }
      return { kind: "blocked", code: "operation_failed", message: boundedMessage(error) };
    }
  }

  async close(reason = "system_exit"): Promise<void> {
    await this.persistenceTail;
    await this.persistConversationTail();
    const current = await this.options.journal.current();
    if (!current) return;
    await this.options.onLifecycle?.({ type: "session_end", session: { id: current.projection.id, reason } });
    await this.options.journal.close(reason);
  }

  async inspect(query: RuntimeQuery): Promise<RuntimeQueryResult> {
    if (this.options.controller.getSnapshot().runStatus !== "running") await this.persistenceTail;
    switch (query.kind) {
      case "runtime.status": {
        const current = await this.requireCurrent();
        return { kind: query.kind, value: {
          session: current.projection,
          compaction: this.options.compactor.status(),
          memory: this.options.memory.status(),
          ...(this.options.memoryJobs ? { memoryJobs: this.options.memoryJobs.status() } : {}),
        } };
      }
      case "session.current":
        return { kind: query.kind, value: (await this.requireCurrent()).projection };
      case "session.list":
        return { kind: query.kind, value: await this.options.journal.list({ limit: query.limit ?? 20 }) };
      case "memory.status":
        await this.options.memory.refresh();
        return { kind: query.kind, value: this.options.memory.status() };
      case "memory.list":
        await this.options.memory.refresh();
        return { kind: query.kind, value: this.options.memory.list(query) };
      case "memory.show":
        await this.options.memory.refresh();
        return { kind: query.kind, value: this.options.memory.show(query.memoryId) };
    }
  }

  continuityHooks(): NonNullable<import("../agent/session.js").AgentSessionDependencies["continuity"]> {
    return {
      prepareModelCall: async () => {
        const compacted = await this.options.compactor.prepareModelCall();
        const resumeReminder = this.resumeReminder;
        this.resumeReminder = undefined;
        const supplements = [
          this.instructionSnapshot.trustedInstructions
            ? `<nekoder-supplement kind="project-instructions">\n${this.instructionSnapshot.trustedInstructions}\n</nekoder-supplement>`
            : "",
          this.instructionSnapshot.referenceData,
          this.options.memory.snapshot().injectionText
            ? `<nekoder-supplement kind="long-term-memory" authority="context">\n${this.options.memory.snapshot().injectionText}\n</nekoder-supplement>`
            : "",
          resumeReminder
            ? `<nekoder-supplement kind="session-resume">\n${resumeReminder}\n</nekoder-supplement>`
            : "",
          ...compacted.supplementalInstructions,
        ].filter(Boolean);
        return { ...compacted, supplementalInstructions: supplements };
      },
      prepareToolResults: (results) => this.prepareToolResults(results),
      scheduleMemoryUpdate: async (outcome) => {
        if (this.options.memoryJobs) {
          const messages = this.options.conversation.getMessages().slice(-16)
            .map((message) => JSON.stringify(message).slice(0, 8_000));
          const snapshot = this.options.memory.snapshot();
          const notes = snapshot.notes;
          await this.options.memoryJobs.enqueueUpdate({
            jobId: `memory-update-${outcome.agentRunId}`,
            requests: (["project", "user"] as const).map((scope) => ({
              scope,
              input: {
                outcome,
                recentConversation: messages,
                currentIndex: snapshot.injectionText.slice(0, 25 * 1_024),
                existingNotes: notes.filter((note) => note.scope === scope).slice(0, 20)
                  .map((note) => note.raw.slice(0, 4_000)),
              },
            })),
          });
        }
        await this.options.onMemoryUpdate?.(outcome);
      },
    };
  }

  private async prepareToolResults(results: readonly ToolCallResult[]): Promise<readonly ToolCallResult[]> {
    const current = await this.requireCurrent();
    const processed = await this.options.artifacts.process(
      current.projection.id,
      results.map((item) => ({ toolCallId: item.toolCallId, toolName: item.toolName, value: item.result }))
    );
    return processed.results.map((item, index) => {
      if (!item.artifact) return results[index]!;
      const original = results[index]!.result;
      return {
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        result: original.ok
          ? { ok: true, data: item.artifact }
          : { ok: false, error: { ...original.error, details: item.artifact } },
      };
    });
  }

  private async resolveConfirmation(id: string, accepted: boolean): Promise<RuntimeCommandResult> {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (!pending) return notFound(`Confirmation is no longer active: ${id}`);
    if (!accepted) return { kind: "info", message: "Operation cancelled" };
    try {
      if (pending.kind === "session.delete") {
        await this.options.artifacts.deleteSessionArtifacts(pending.sessionId);
        await this.options.journal.delete(pending.sessionId);
        return { kind: "success", message: `Deleted Session ${pending.sessionId}` };
      }
      const note = await this.options.memory.forget(pending.memoryId);
      return { kind: "success", message: `Forgot Memory Note ${note.id}` };
    } catch (error) {
      return { kind: "blocked", code: "operation_failed", message: boundedMessage(error) };
    }
  }

  private async requireCurrent(): Promise<SessionSnapshot> {
    return (await this.options.journal.current()) ?? this.options.journal.new();
  }

  private memoryMaintenanceInput(): unknown {
    return {
      notes: this.options.memory.snapshot().notes.map(({ id, scope, type, status, title, updatedAt }) =>
        ({ id, scope, type, status, title, updatedAt })),
    };
  }

  private restoreConversation(snapshot: SessionSnapshot): void {
    const lastCompaction = snapshot.events.findLast((event) => event.type === "compacted");
    const eventMessages = snapshot.events
      .filter((event): event is Extract<typeof event, { type: "message" }> =>
        event.type === "message" && (!lastCompaction || event.seq > lastCompaction.coveredThroughSeq)
      )
      .map((event) => ({ role: event.role, content: event.content }) as ModelMessage);
    const messages = completeInteractionUnits([
      ...(lastCompaction ? [{ role: "assistant", content: lastCompaction.summary } as ModelMessage] : []),
      ...eventMessages,
    ]);
    this.options.conversation.replaceMessages(messages);
    this.persistedMessages = messages.length;
  }

  private async persistConversationTail(): Promise<void> {
    const messages = this.options.conversation.getMessages();
    for (const message of messages.slice(this.persistedMessages)) {
      if (message.role === "system") continue;
      await this.options.journal.append({ type: "message", role: message.role, content: message.content });
    }
    this.persistedMessages = messages.length;
  }
}

function formatCompaction(result: CompactionResult): RuntimeCommandResult {
  if (result.kind === "noop") {
    return {
      kind: "info",
      message: `Compaction not needed (${result.reason}). Context: ${approx(result.budget.requiredTokens, result.budget.accuracy)} tokens; compressible units: ${result.compressibleUnits}`,
    };
  }
  return {
    kind: "success",
    message: [
      `Compacted ${result.interactionCount} interaction units`,
      `Context: ${approx(result.before.requiredTokens, result.before.accuracy)} → ${approx(result.after.requiredTokens, result.after.accuracy)} tokens`,
      `Preserved: ${result.preservedUnits} recent units`,
    ].join("\n"),
  };
}

function approx(tokens: number, accuracy: "exact" | "estimated"): string {
  return `${accuracy === "estimated" ? "~" : ""}${tokens.toLocaleString("en-US")}`;
}

function notFound(message: string): RuntimeCommandResult {
  return { kind: "blocked", code: "not_found", message };
}

function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function runActiveControllerResult(): ControllerResult {
  return { ok: false, code: "run_active", message: "An agent run is already active" };
}

function completeInteractionUnits(messages: readonly ModelMessage[]): ModelMessage[] {
  const units: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || units.length === 0) units.push([]);
    units.at(-1)!.push(message);
  }
  return units.filter((unit) => {
    const calls = new Set<string>();
    const results = new Set<string>();
    for (const message of unit) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "tool-call" && !part.providerExecuted) calls.add(part.toolCallId);
        }
      }
      if (message.role === "tool") {
        for (const part of message.content) {
          if (part.type === "tool-result") results.add(part.toolCallId);
        }
      }
    }
    return [...calls].every((id) => results.has(id));
  }).flat();
}
