import { compileCondition, type CompiledCondition, type Condition } from "./condition-matcher.js";
import type { ToolAuthorizer, ToolAuthorizationRequest } from "../tools/runner.js";

export type HookEventType = "run_start" | "run_finish" | "step_start" | "step_finish" | "message_added" | "tool_before" | "tool_after";
export type HookSource = "project" | "user" | "plugin" | "builtin";

export type HookAction =
  | { readonly prompt: { readonly message: string } }
  | { readonly deny: { readonly reason: string } }
  | { readonly subagent: { readonly agent: string; readonly task: string } };

export interface HookRule {
  readonly id: string;
  readonly event: HookEventType;
  readonly if?: Condition;
  readonly once?: boolean;
  readonly action: HookAction;
  readonly source: HookSource;
  readonly path?: string;
  readonly order?: number;
  readonly trusted?: boolean;
  readonly contentHash?: string;
}

export type HookEvent = {
  readonly type: HookEventType;
  readonly run: { readonly id: string; readonly agent: "root" | "subagent" };
  readonly step?: { readonly number: number; readonly outcome?: string };
  readonly message?: { readonly role: string; readonly origin: string };
  readonly tool?: { readonly name: string; readonly category?: string; readonly path?: string; readonly command?: string; readonly cwd?: string; readonly outcome?: string; readonly error_code?: string };
};

export interface HookMessage {
  readonly origin: "hook";
  readonly hookId: string;
  readonly content: string;
}

export interface HookDiagnostic { readonly code: string; readonly hookId: string; readonly message: string }

export interface HookResult {
  readonly messages: readonly HookMessage[];
  readonly denial?: { readonly hookId: string; readonly reason: string };
  readonly taskIds: readonly string[];
  readonly diagnostics: readonly HookDiagnostic[];
}

export interface HookEngineOptions {
  readonly createTask?: (request: { agent: string; task: string; hookId: string }) => Promise<string>;
  readonly maxPromptBytes?: number;
}

interface CompiledRule { readonly rule: HookRule; readonly matches: CompiledCondition }

const SOURCE_ORDER: Record<HookSource, number> = { project: 0, user: 1, plugin: 2, builtin: 3 };
const FIELDS: Record<HookEventType, readonly string[]> = {
  run_start: ["type", "run.id", "run.agent"], run_finish: ["type", "run.id", "run.agent"],
  step_start: ["type", "run.id", "run.agent", "step.number"],
  step_finish: ["type", "run.id", "run.agent", "step.number", "step.outcome"],
  message_added: ["type", "run.id", "run.agent", "message.role", "message.origin"],
  tool_before: ["type", "run.id", "run.agent", "tool.name", "tool.category", "tool.path", "tool.command", "tool.cwd"],
  tool_after: ["type", "run.id", "run.agent", "tool.name", "tool.category", "tool.path", "tool.command", "tool.cwd", "tool.outcome", "tool.error_code"],
};

export class HookEngine {
  private rules: readonly CompiledRule[] = [];
  private currentRun = "";
  private once = new Set<string>();
  private promptBytes = 0;

  constructor(rules: readonly HookRule[], private readonly options: HookEngineOptions = {}) {
    this.reload(rules);
  }

  reload(rules: readonly HookRule[]): void {
    this.rules = Object.freeze([...rules]
      .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || (a.path ?? "").localeCompare(b.path ?? "") || (a.order ?? 0) - (b.order ?? 0))
      .map((rule) => {
        validateRule(rule);
        return Object.freeze({ rule: Object.freeze({ ...rule }), matches: rule.if ? compileCondition(rule.if, { allowedFields: FIELDS[rule.event] }) : () => true });
      }));
  }

  startRun(runId: string): void {
    this.currentRun = runId;
    this.once = new Set();
    this.promptBytes = 0;
  }

  async handle(event: HookEvent): Promise<HookResult> {
    if (event.run.id !== this.currentRun) this.startRun(event.run.id);
    const messages: HookMessage[] = [];
    const taskIds: string[] = [];
    const diagnostics: HookDiagnostic[] = [];
    let denial: HookResult["denial"];
    const eventRules = this.rules.filter(({ rule }) => rule.event === event.type);
    for (let index = 0; index < eventRules.length; index++) {
      const { rule, matches } = eventRules[index]!;
      if (denial) {
        diagnostics.push({ code: "skipped_after_deny", hookId: rule.id, message: "Skipped after an earlier deny" });
        continue;
      }
      if (rule.once && this.once.has(rule.id)) continue;
      if (!matches(event)) continue;
      if (rule.once) this.once.add(rule.id);
      if ("deny" in rule.action) {
        denial = { hookId: rule.id, reason: rule.action.deny.reason };
        continue;
      }
      if ("prompt" in rule.action) {
        if (rule.source === "project" && rule.trusted !== true) {
          diagnostics.push({ code: "hook_untrusted", hookId: rule.id, message: "Project prompt Hook is not trusted" });
          continue;
        }
        const bytes = Buffer.byteLength(rule.action.prompt.message, "utf8");
        if (bytes > 32 * 1024 || this.promptBytes + bytes > (this.options.maxPromptBytes ?? 128 * 1024)) {
          diagnostics.push({ code: "hook_prompt_budget_exceeded", hookId: rule.id, message: "Hook prompt budget exceeded" });
          continue;
        }
        this.promptBytes += bytes;
        messages.push({ origin: "hook", hookId: rule.id, content: rule.action.prompt.message });
        continue;
      }
      if (event.run.agent !== "root") {
        diagnostics.push({ code: "delegation_not_allowed", hookId: rule.id, message: "SubAgent events cannot create tasks" });
        continue;
      }
      if (rule.source === "project" && rule.trusted !== true) {
        diagnostics.push({ code: "hook_untrusted", hookId: rule.id, message: "Project subagent Hook is not trusted" });
        continue;
      }
      if (!this.options.createTask) {
        diagnostics.push({ code: "task_manager_unavailable", hookId: rule.id, message: "Delegated Task Manager is unavailable" });
        continue;
      }
      try {
        const taskId = await this.options.createTask({ ...rule.action.subagent, hookId: rule.id });
        taskIds.push(taskId);
        messages.push({ origin: "hook", hookId: rule.id, content: `Delegated task created: ${taskId}` });
      } catch (error) {
        diagnostics.push({ code: "task_creation_failed", hookId: rule.id, message: String(error) });
      }
    }
    return Object.freeze({ messages: Object.freeze(messages), ...(denial ? { denial: Object.freeze(denial) } : {}), taskIds: Object.freeze(taskIds), diagnostics: Object.freeze(diagnostics) });
  }

  toolGate(
    identity: { readonly runId: string; readonly agent: "root" | "subagent" },
    onMessage?: (message: HookMessage) => void
  ): ToolAuthorizer {
    return { authorize: async (request) => {
      const result = await this.handle(toolEvent(identity, request));
      for (const message of result.messages) onMessage?.(message);
      return result.denial
        ? { kind: "deny", source: "security_invariant", reason: result.denial.reason, ruleId: result.denial.hookId }
        : "allow";
    } };
  }
}

function toolEvent(identity: { runId: string; agent: "root" | "subagent" }, request: ToolAuthorizationRequest): HookEvent {
  const target = request.authorizationTarget;
  return { type: "tool_before", run: { id: identity.runId, agent: identity.agent }, tool: {
    name: request.toolName, category: request.effect, path: target?.requestedPath ?? target?.resolvedPath,
    command: target?.commands?.join(" && ") ?? (request.toolName === "run_command" ? target?.primary : undefined), cwd: target?.cwd,
  } };
}

function validateRule(rule: HookRule): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(rule.id)) throw new Error(`Invalid Hook ID: ${rule.id}`);
  if ("deny" in rule.action && rule.event !== "tool_before") throw new Error(`Hook ${rule.id}: deny is only valid for tool_before`);
  if ("prompt" in rule.action && Buffer.byteLength(rule.action.prompt.message, "utf8") > 32 * 1024) throw new Error(`Hook ${rule.id}: prompt exceeds 32 KiB`);
}
