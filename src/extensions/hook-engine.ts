import { compileCondition, type CompiledCondition, type Condition } from "./condition-matcher.js";
import type { ToolAuthorizer, ToolAuthorizationRequest } from "../tools/runner.js";

export type HookSource = "project" | "user" | "plugin" | "builtin";

export type HookAction =
  | { readonly http: { readonly url: string; readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string; readonly timeout_ms?: number } }
  | { readonly command: { readonly command: string; readonly cwd?: string; readonly timeout_ms?: number } }
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
}

export type HookEventType =
  | "system_start" | "system_exit" | "context_compact" | "system_error"
  | "session_start" | "session_end"
  | "run_start" | "run_finish" | "step_start" | "step_finish"
  | "message_added" | "tool_before" | "tool_after";

export type HookEvent = {
  readonly type: HookEventType;
  readonly system?: { readonly workspace: string; readonly reason?: string };
  readonly session?: { readonly id: string; readonly reason?: string };
  readonly compaction?: { readonly manual: boolean; readonly outcome: "compacted" | "noop" | "failed"; readonly before_tokens?: number; readonly after_tokens?: number };
  readonly error?: { readonly source: string; readonly message: string; readonly code?: string };
  readonly run?: { readonly id: string; readonly agent: "root" | "subagent" };
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
  readonly executeHttp?: (request: Extract<HookAction, { http: unknown }>["http"]) => Promise<{ readonly status: number }>;
  readonly executeCommand?: (request: Extract<HookAction, { command: unknown }>["command"]) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

interface CompiledRule { readonly rule: HookRule; readonly matches: CompiledCondition }

const SOURCE_ORDER: Record<HookSource, number> = { project: 0, user: 1, plugin: 2, builtin: 3 };
const FIELDS: Record<HookEventType, readonly string[]> = {
  system_start: ["type", "system.workspace"],
  system_exit: ["type", "system.workspace", "system.reason"],
  context_compact: ["type", "compaction.manual", "compaction.outcome", "compaction.before_tokens", "compaction.after_tokens", "session.id"],
  system_error: ["type", "error.source", "error.message", "error.code", "session.id", "run.id", "run.agent"],
  session_start: ["type", "session.id", "session.reason"],
  session_end: ["type", "session.id", "session.reason"],
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
  }

  async handle(event: HookEvent): Promise<HookResult> {
    if (event.run && event.run.id !== this.currentRun) this.startRun(event.run.id);
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
      if ("http" in rule.action) {
        try {
          const response = await (this.options.executeHttp ?? executeHttp)(rule.action.http);
          if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
        } catch (error) {
          diagnostics.push({ code: "hook_http_failed", hookId: rule.id, message: String(error) });
        }
        continue;
      }
      if ("command" in rule.action) {
        try {
          const response = await (this.options.executeCommand ?? executeCommand)(rule.action.command);
          if (response.exitCode !== 0) throw new Error(`Command exited ${response.exitCode}: ${response.stderr}`);
        } catch (error) {
          diagnostics.push({ code: "hook_command_failed", hookId: rule.id, message: String(error) });
        }
        continue;
      }
      if ("prompt" in rule.action) {
        messages.push({ origin: "hook", hookId: rule.id, content: rule.action.prompt.message });
        continue;
      }
      if (event.run?.agent === "subagent") {
        diagnostics.push({ code: "delegation_not_allowed", hookId: rule.id, message: "SubAgent events cannot create tasks" });
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
    if (event.type !== "system_error") {
      for (const diagnostic of diagnostics.filter(({ code }) => ["hook_http_failed", "hook_command_failed", "task_creation_failed"].includes(code))) {
        const reported = await this.handle({
          type: "system_error",
          ...(event.run ? { run: event.run } : {}),
          ...(event.session ? { session: event.session } : {}),
          error: { source: `hook:${diagnostic.hookId}`, message: diagnostic.message, code: diagnostic.code },
        });
        messages.push(...reported.messages);
        taskIds.push(...reported.taskIds);
        diagnostics.push(...reported.diagnostics);
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
  if (!(rule.event in FIELDS)) throw new Error(`Invalid Hook event: ${rule.event}`);
  if ("deny" in rule.action && rule.event !== "tool_before") throw new Error(`Hook ${rule.id}: deny is only valid for tool_before`);
  if ("http" in rule.action) new URL(rule.action.http.url);
}

async function executeHttp(request: Extract<HookAction, { http: unknown }>["http"]): Promise<{ status: number }> {
  const response = await fetch(request.url, {
    method: request.method ?? "POST",
    ...(request.headers ? { headers: request.headers } : {}),
    ...(request.body === undefined ? {} : { body: request.body }),
    signal: AbortSignal.timeout(request.timeout_ms ?? 60_000),
  });
  return { status: response.status };
}

async function executeCommand(request: Extract<HookAction, { command: unknown }>["command"]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const windows = process.platform === "win32";
  const child = Bun.spawn(windows
    ? ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", request.command]
    : ["/bin/sh", "-lc", request.command], {
      ...(request.cwd ? { cwd: request.cwd } : {}),
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(request.timeout_ms ?? 60_000),
    });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
