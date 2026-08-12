import type { DelegatedTaskManager } from "./delegated-task-manager.js";
import type { AnyTool, Tool, ToolResult } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ConversationMessage } from "../conversation/conversation.js";

const ROOT_TASK_TOOL_NAMES = new Set(["delegate_agent", "task_list", "task_get", "task_cancel"]);

export function inheritParentToolsForSubagent(
  parent: ToolRegistry,
  child: ToolRegistry,
  options: {
    readonly kind: "defined" | "fork";
    readonly allowed?: ReadonlySet<string>;
    readonly denied?: ReadonlySet<string>;
  }
): void {
  for (const { name } of parent.definitions()) {
    if (
      name === "use_skill"
      || name === "run_command"
      || ROOT_TASK_TOOL_NAMES.has(name)
      || options.denied?.has(name)
      || (options.kind === "defined" && name.startsWith("skill__"))
      || (options.allowed && !options.allowed.has(name))
    ) continue;
    const candidate = parent.get(name);
    if (candidate) child.register(candidate);
  }
}

export interface TaskToolsOptions {
  readonly foregroundTimeoutMs?: number;
  readonly forkHistoryProvider?: () => readonly ConversationMessage[];
  readonly inheritedSkillsProvider?: () => readonly string[];
  readonly agentDefinitions?: readonly { readonly name: string; readonly description: string }[];
  readonly resolveIsolation?: (agent: string | undefined, requested: "shared" | "worktree" | undefined, kind: "defined" | "fork") => "shared" | "worktree";
  readonly requestSecrets?: (names: readonly string[]) => Promise<readonly string[]>;
}

export class TaskTools {
  constructor(private readonly manager: DelegatedTaskManager, private readonly options: TaskToolsOptions = {}) {}

  root(): readonly AnyTool[] {
    return [this.delegate(), this.list(), this.get(), this.cancel()];
  }

  child(taskId: string): readonly AnyTool[] {
    return [this.get(taskId), this.update(taskId)];
  }

  private delegate(): Tool<any, any, unknown> {
    const agentDefinitions = this.options.agentDefinitions ?? [];
    const availableAgents = agentDefinitions
      .map(({ name, description }) => `${name}: ${description}`)
      .join("; ");
    return tool("delegate_agent", "The only tool for starting a general-purpose SubAgent. Delegate one bounded task to a one-level SubAgent; do not use use_skill as a substitute. Must be exclusive in its Tool Batch.", "execute", {
      kind: { type: "string", enum: ["defined", "fork"], description: "Use defined for a named bounded role, or fork to continue from the Root conversation." },
      agent: {
        type: "string",
        ...(agentDefinitions.length > 0 ? { enum: agentDefinitions.map(({ name }) => name) } : {}),
        description: agentDefinitions.length > 0
          ? `Required when kind is defined; omit when kind is fork. Available Agent Definitions: ${availableAgents}`
          : "Required when kind is defined; omit when kind is fork.",
      },
      prompt: { type: "string", minLength: 1 },
      mode: { type: "string", enum: ["foreground", "background"] }, isolation: { type: "string", enum: ["shared", "worktree"] },
    }, ["kind", "prompt"], async (input, context) => {
      try {
        const isolation = this.options.resolveIsolation?.(input.agent, input.isolation, input.kind) ?? input.isolation;
        const task = await this.manager.create({
          caller: "root", kind: input.kind, agent: input.kind === "defined" ? input.agent : undefined, prompt: input.prompt, mode: input.mode, isolation,
          ...(input.kind === "fork" && this.options.forkHistoryProvider ? { forkHistory: safeForkHistory(this.options.forkHistoryProvider()) } : {}),
          ...(input.kind === "fork" && this.options.inheritedSkillsProvider ? { inheritedSkills: this.options.inheritedSkillsProvider() } : {}),
        });
        context.signal?.addEventListener("abort", () => this.manager.cancel(task.id), { once: true });
        if (task.kind === "fork" || task.mode === "background") return success({ ...task, background: true });
        const timeout = this.options.foregroundTimeoutMs ?? 30_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const completed = await Promise.race([
          this.manager.wait(task.id).then((value) => ({ value, timedOut: false as const })),
          new Promise<{ timedOut: true }>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), timeout); }),
        ]);
        if (timer) clearTimeout(timer);
        if (completed.timedOut) {
          const backgroundTask = this.manager.moveToBackground(task.id);
          return success({ ...backgroundTask, background: true, reason: "foreground_timeout" });
        }
        return success({ ...completed.value, background: false });
      } catch (error) { return failure("task_creation_failed", String(error)); }
    }, [{
      if: { properties: { kind: { const: "defined" } }, required: ["kind"] },
      then: { properties: { agent: {} }, required: ["agent"] },
    }]);
  }

  private list(): AnyTool {
    return tool("task_list", "List delegated tasks owned by the Root session.", "read", {}, [], async () => success(this.manager.list()));
  }

  private get(onlyTaskId?: string): AnyTool {
    return tool("task_get", "Get bounded details for a delegated task.", "read", { task_id: { type: "string" } }, onlyTaskId ? [] : ["task_id"], async (input) => {
      const id = onlyTaskId ?? input.task_id;
      if (onlyTaskId && input.task_id && input.task_id !== onlyTaskId) return failure("task_access_denied", "SubAgent may only inspect its own task");
      const task = this.manager.get(id);
      return task ? success(task) : failure("task_not_found", `Unknown task: ${id}`);
    });
  }

  private cancel(): AnyTool {
    return tool("task_cancel", "Cancel a delegated task without rolling back completed side effects.", "execute", { task_id: { type: "string" } }, ["task_id"], async (input) => {
      try { return success(this.manager.cancel(input.task_id)); }
      catch (error) { return failure("task_not_found", String(error)); }
    });
  }

  private update(taskId: string): AnyTool {
    return tool("task_update", "Update this SubAgent task's phase, progress, and artifact references using version CAS.", "write", {
      expected_version: { type: "integer", minimum: 1 }, progress: { type: "string", maxLength: 4096 }, phase: { type: "string", maxLength: 4096 },
      artifacts: { type: "array", maxItems: 16, items: { type: "string" } },
      request_secrets: { type: "array", maxItems: 16, items: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" } },
    }, ["expected_version"], async (input) => {
      try {
        const task = this.manager.update(taskId, { expectedVersion: input.expected_version, progress: input.progress, phase: input.phase, artifacts: input.artifacts });
        const grantedSecrets = input.request_secrets?.length
          ? await this.options.requestSecrets?.(input.request_secrets) ?? (() => { throw new Error("Task Secret requests are unavailable"); })()
          : [];
        return success({ ...task, grantedSecrets });
      }
      catch (error) { return failure("task_update_rejected", String(error)); }
    });
  }
}

function tool(
  name: string, description: string, effect: "read" | "write" | "execute", properties: Record<string, unknown>, required: string[],
  execute: (input: any, context: import("../tools/types.js").ToolExecutionContext) => Promise<ToolResult<unknown>>,
  allOf?: readonly unknown[]
): AnyTool {
  return { name, description, effect, inputSchema: { type: "object", properties, required, additionalProperties: false, ...(allOf ? { allOf } : {}) }, timeoutMs: 35_000,
    async prepare(input) { return { ok: true, data: input }; }, execute } as AnyTool;
}
function success(data: unknown): ToolResult<unknown> { return { ok: true, data }; }
function failure(code: import("../tools/types.js").ToolErrorCode, message: string): ToolResult<never> { return { ok: false, error: { code, message, retryable: false } }; }

function safeForkHistory(messages: readonly ConversationMessage[]): readonly ConversationMessage[] {
  const completed = new Set<string>();
  for (const message of messages) if (message.role === "tool") for (const part of message.content) if (part.type === "tool-result") completed.add(part.toolCallId);
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];
    const content = message.content.filter((part) => part.type !== "reasoning" && (part.type !== "tool-call" || part.providerExecuted || completed.has(part.toolCallId)));
    return content.length > 0 ? [{ ...message, content } as ConversationMessage] : [];
  });
}
