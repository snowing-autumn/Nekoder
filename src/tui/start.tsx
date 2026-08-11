import React, { useEffect, useReducer, useRef, useState } from "react";
import { resolve as resolvePath } from "node:path";
import {
  Box,
  Text,
  render,
  useInput,
  usePaste,
  useWindowSize,
  type Instance,
} from "ink";

import type { TaskMode } from "../agent/types.js";
import type { ApprovalDecision, PermissionMode } from "../security/types.js";
import type { McpDiagnostic } from "../mcp/manager.js";
import { createBuiltinSlashRegistry } from "../slash/builtins.js";
import { UserInputRouter } from "../slash/dispatcher.js";
import type { SlashCommand, SlashCommandResult, SlashRegistry } from "../slash/registry.js";
import type { DelegatedTask } from "../extensions/delegated-task-manager.js";
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeQueryResult,
  WorkspaceRuntime,
} from "../continuity/workspace-runtime.js";
import {
  applyComposerAction,
  createComposerBuffer,
  type ComposerAction,
} from "./composer-buffer.js";
import type { ControllerResult, SessionController, SessionSnapshot } from "./session-controller.js";
import { parseSgrMouse } from "./mouse-input.js";
import { parseSafeMarkdown } from "./markdown.js";
import { createTuiState, reduceTuiAction, type TranscriptItem, type TuiAction } from "./store.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import { runStateColor, toolColor, TUI_COLORS } from "./theme.js";

export interface StartTuiOptions {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
  readonly workspace: string;
  readonly taskMode: TaskMode;
  readonly controller?: SessionController;
  readonly debug?: boolean;
  readonly plainIcons?: boolean;
  readonly reduceMotion?: boolean;
  readonly onDispose?: () => void | Promise<void>;
  readonly toolNames?: readonly string[];
  readonly permissionSources?: readonly string[];
  readonly mcpDiagnostics?: () => readonly McpDiagnostic[];
  readonly initialMessages?: readonly string[];
  readonly runtime?: WorkspaceRuntime;
  readonly tasks?: () => readonly DelegatedTask[];
  readonly moveTaskToBackground?: (taskId: string) => void;
  readonly skillInstall?: (source: string, project: boolean) => Promise<string>;
  readonly skillCreate?: (name: string, description: string, project: boolean) => Promise<string>;
  readonly slashRegistry?: SlashRegistry;
}

export interface TuiApplication {
  readonly ready: Promise<void>;
  flush(): Promise<void>;
  waitUntilExit(): Promise<void>;
  stop(): Promise<void>;
}

const BUILTIN_SLASH_REGISTRY = createBuiltinSlashRegistry();

function TranscriptLine({
  item,
  plainIcons = false,
  selected = false,
}: {
  readonly item: TranscriptItem;
  readonly plainIcons?: boolean;
  readonly selected?: boolean;
}) {
  switch (item.type) {
    case "user":
      return <Text><Text bold color={TUI_COLORS.user}>You  </Text>{sanitizeTerminalText(item.text)}</Text>;
    case "assistant":
      return (
        <Box flexDirection="column">
          <Text bold color={TUI_COLORS.assistant}>Nekoder{item.interrupted ? " · interrupted" : ""}</Text>
          <MarkdownContent source={item.text} />
        </Box>
      );
    case "tool": {
      const icon = item.status === "not_executed" || item.status === "failed"
        ? "!"
        : plainIcons ? "*" : "󰄬";
      const target = primaryToolTarget(item.input);
      return (
        <Box flexDirection="column">
          <Text color={toolColor(item)}>{selected ? ">" : " "} {icon} {sanitizeTerminalText(item.toolName)}{target ? ` · ${target}` : ""} · {item.status}</Text>
          {item.expanded && <Text dimColor>    Input: {formatToolValue(item.input)}</Text>}
          {item.result && <Text dimColor>    Result: {formatToolValue(item.result.ok ? item.result.data : item.result.error, item.expanded ? 1_000 : 160)}</Text>}
        </Box>
      );
    }
    case "run_notice":
      return (
        <Text color={noticeColor(item.status)}>
          {item.status.toUpperCase()}{item.message ? ` · ${sanitizeTerminalText(item.message)}` : ""}
        </Text>
      );
  }
}

function noticeColor(status: string): "red" | "green" | "yellow" | undefined {
  if (status === "completed" || status === "success") return TUI_COLORS.success;
  if (status === "info") return undefined;
  if (status === "cancelled" || status === "rejected") return TUI_COLORS.approval;
  return TUI_COLORS.danger;
}

function MarkdownContent({ source }: { readonly source: string }) {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {parseSafeMarkdown(source).map((block, index) => {
        switch (block.type) {
          case "heading": return <Text key={index} bold>{"#".repeat(block.level)} {block.text}</Text>;
          case "bullet": return <Text key={index}>• {block.text}</Text>;
          case "quote": return <Text key={index} dimColor>│ {block.text}</Text>;
          case "code": return <Text key={index} dimColor>{block.language ? `[${block.language}]\n` : ""}{block.text}</Text>;
          case "table": return (
            <Box key={index} flexDirection="column">
              {block.rows.map((row, rowIndex) => <Text key={rowIndex}>{row.join(" · ")}</Text>)}
            </Box>
          );
          case "text": return <Text key={index}>{block.text}</Text>;
        }
      })}
    </Box>
  );
}

function primaryToolTarget(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "command", "query", "pattern"]) {
    if (typeof record[key] === "string") return sanitizeTerminalText(record[key]).slice(0, 120);
  }
  return undefined;
}

function formatToolValue(value: unknown, limit = 1_000): string {
  const text = sanitizeTerminalText(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}… [truncated]`;
}

const composerGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function ComposerLine({ text, cursor }: { readonly text: string; readonly cursor: number }) {
  const before = sanitizeTerminalText(text.slice(0, cursor));
  const rest = text.slice(cursor);
  const current = composerGraphemes.segment(rest)[Symbol.iterator]().next().value?.segment ?? "";
  const after = sanitizeTerminalText(rest.slice(current.length));
  return (
    <Text><Text bold color={TUI_COLORS.composer}>❯ </Text>{before}<Text inverse color={TUI_COLORS.composer}>{sanitizeTerminalText(current) || " "}</Text>{after}</Text>
  );
}

function ApprovalCard({
  session,
  confirmingUser,
}: {
  readonly session: SessionSnapshot;
  readonly confirmingUser: boolean;
}) {
  const pending = session.pendingApproval;
  if (!pending) return null;
  const input = pending.request.preparedInput;
  const record = typeof input === "object" && input !== null
    ? input as Record<string, unknown>
    : {};
  const command = sanitizeTerminalText(
    typeof record.command === "string" ? record.command : input
  );
  const cwd = sanitizeTerminalText(
    typeof record.absolutePath === "string"
      ? record.absolutePath
      : typeof record.cwd === "string" ? record.cwd : pending.request.workspace
  );
  const target = pending.request.authorizationTarget;
  const isMcp = pending.request.toolName.startsWith("mcp_");
  const displayedInput = isMcp ? redactApprovalInput(input) : input;
  const decision = pending.authorizationDecision;
  const scopes = decision?.allowedScopes ?? ["once"];
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color={TUI_COLORS.approval}>Approval required</Text>
      <Text>tool: {sanitizeTerminalText(pending.request.toolName)} · effect: {pending.request.effect}</Text>
      {decision && <Text>reason: {sanitizeTerminalText(decision.reason)}</Text>}
      {decision && <Text>source: {decision.source}</Text>}
      {target && <Text>target: {sanitizeTerminalText(target.primary)}</Text>}
      {target?.requestedPath && <Text>requested: {sanitizeTerminalText(target.requestedPath)}</Text>}
      {target?.resolvedPath && <Text>resolved: {sanitizeTerminalText(target.resolvedPath)}</Text>}
      <Text>input: {sanitizeTerminalText(JSON.stringify(displayedInput)).slice(0, 2_048)}</Text>
      {pending.request.toolName === "run_command" && <Text>command: {command}</Text>}
      {pending.request.toolName === "run_command" && <Text>cwd: {cwd}</Text>}
      {decision && <Text>scopes: {decision.allowedScopes.join(", ")}</Text>}
      {pending.request.toolName === "run_command" && <Text color={TUI_COLORS.approval}>Nekoder cannot prove this command has no side effects.</Text>}
      {isMcp && <Text color={TUI_COLORS.approval}>This MCP Server is not constrained to the Workspace and is not OS-sandboxed.</Text>}
      {confirmingUser && <Text color={TUI_COLORS.danger}>This rule applies across all Workspaces. Press U again to confirm.</Text>}
      <Text>
        {!confirmingUser && scopes.includes("once") && <><Text bold>[Y]</Text> Allow once  </>}
        {!confirmingUser && scopes.includes("session") && <><Text bold>[S]</Text> Allow session  </>}
        {!confirmingUser && scopes.includes("persistent_local") && <><Text bold>[L]</Text> Always allow locally  </>}
        {scopes.includes("persistent_user") && <><Text bold>[U]</Text> {confirmingUser ? "Confirm user-wide" : "Always allow user-wide"}  </>}
        {confirmingUser && <><Text bold>[B]</Text> Back  </>}
        <Text bold>[N]</Text> Deny
      </Text>
    </Box>
  );
}

function totalTokens(usage: object): string {
  const values = Object.values(usage).filter((value: unknown): value is number => typeof value === "number");
  return values.length === 0 ? "—" : values.reduce((sum, value) => sum + value, 0).toLocaleString();
}

export function redactApprovalInput(value: unknown, depth = 0): unknown {
  if (depth >= 8) return "[TRUNCATED]";
  if (typeof value === "string") return value.length <= 512 ? value : `${value.slice(0, 512)}[TRUNCATED]`;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactApprovalInput(item, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, child]) => [
    key,
    /(?:secret|token|password|authorization|api[_-]?key|credential)/iu.test(key)
      ? "[REDACTED]"
      : redactApprovalInput(child, depth + 1),
  ]));
}

function NekoSidebar({
  session,
  state,
  debug,
  screenReader,
  tasks = [],
}: {
  readonly session: SessionSnapshot;
  readonly state: ReturnType<typeof createTuiState>;
  readonly debug?: boolean;
  readonly screenReader?: boolean;
  readonly tasks?: readonly DelegatedTask[];
}) {
  const visual = session.pendingApproval ? "awaiting_approval" : state.runVisualState;
  const cat = state.composer.text
    ? "  /\\_/\\\n ( o.O ) ?\n  > ^ < /\n ( / \\ )"
    : visual === "generating"
      ? "  /\\_/\\\n ( o.o )\n  > ^ < /\n/========/"
      : visual === "executing_tool"
        ? "  /\\_/\\\n ( -.- )\n☕> ^ < /\n ( / \\ )"
        : visual === "awaiting_approval"
          ? "  /\\_/\\ zzz\n ( -.- )\n  > ω <\n ( / \\ )"
          : visual === "failed"
            ? "  /\\_/\\ !\n ( >.< )\n  > ^ < /\n! ERROR !"
            : visual === "completed"
              ? "  /\\_/\\\n ( ^.^ )\n  > ω < /\n ( / \\ )"
              : "  /\\_/\\\n ( o.o )\n  > ^ < /\n ( / \\ )";
  return (
    <Box width={24} height="100%" flexShrink={0} flexDirection="column" borderStyle="single" borderColor={TUI_COLORS.chrome} paddingX={1} overflow="hidden">
      {!screenReader && <Text color={TUI_COLORS.chrome}>{cat}</Text>}
      <Text dimColor>Mode</Text>
      <Text color={session.taskMode === "plan" ? TUI_COLORS.plan : TUI_COLORS.execute}>{session.taskMode === "plan" ? "PLAN" : "EXECUTE"}</Text>
      <Text dimColor>Permission</Text>
      <Text>{session.permissionMode.toUpperCase()}</Text>
      <Text dimColor>State</Text>
      <Text color={runStateColor(visual)}>{visual.toUpperCase()}</Text>
      <Text dimColor>Current tokens</Text>
      <Text>{totalTokens(state.usage)}</Text>
      <Text dimColor>Cumulative</Text>
      <Text>{totalTokens(state.cumulativeUsage)}</Text>
      {session.activePlanId && <Text color={TUI_COLORS.plan}>Plan ready</Text>}
      {tasks.length > 0 && <Text dimColor>Tasks</Text>}
      {tasks.slice(-4).map((task) => <Text key={task.id} color={task.status === "failed" ? TUI_COLORS.danger : undefined}>{task.id.slice(0, 10)} {task.status}{task.isolation === "worktree" ? " [wt]" : ""}</Text>)}
      {debug && <Text dimColor>items {state.transcript.length}</Text>}
    </Box>
  );
}

interface ShellProps extends StartTuiOptions {
  readonly onInputReady: () => void;
  readonly onRequestExit: () => void;
}

function Shell({
  workspace,
  taskMode,
  controller,
  debug,
  plainIcons,
  toolNames = [],
  permissionSources = [],
  mcpDiagnostics,
  initialMessages = [],
  runtime,
  tasks: taskProvider,
  moveTaskToBackground,
  skillInstall,
  skillCreate,
  slashRegistry = BUILTIN_SLASH_REGISTRY,
  onInputReady,
  onRequestExit,
}: ShellProps) {
  const { columns, rows } = useWindowSize();
  const screenReader = process.env.INK_SCREEN_READER === "true";
  const [state, dispatch] = useReducer(reduceTuiAction, undefined, createTuiState);
  const composerRef = useRef(state.composer);
  const selectedSlashRef = useRef<SlashCommand | undefined>(undefined);
  useEffect(() => {
    composerRef.current = state.composer;
  }, [state.composer]);
  const editComposer = (action: ComposerAction): void => {
    setCompletion(undefined);
    selectedSlashRef.current = undefined;
    composerRef.current = applyComposerAction(composerRef.current, action);
    dispatch({ type: "composer", action });
  };
  const completeComposer = (command: SlashCommand): void => {
    const firstWhitespace = composerRef.current.text.search(/\s/u);
    const end = firstWhitespace < 0 ? composerRef.current.text.length : firstWhitespace;
    editComposer({
      type: "replace_range",
      start: 0,
      end,
      text: `/${command.name}${command.argumentHint ? " " : ""}`,
    });
    selectedSlashRef.current = command;
  };
  const [session, setSession] = useState<SessionSnapshot>(() =>
    controller?.getSnapshot() ?? { taskMode, permissionMode: "default", runStatus: "idle" }
  );
  const [userConfirmation, setUserConfirmation] = useState<string>();
  const [localConfirmation, setLocalConfirmation] = useState<{ readonly id: string; readonly message: string }>();
  const [completion, setCompletion] = useState<{ readonly commands: readonly SlashCommand[]; readonly index: number }>();
  const [tasks, setTasks] = useState<readonly DelegatedTask[]>(() => taskProvider?.() ?? []);
  useEffect(() => {
    if (!taskProvider) return;
    const timer = setInterval(() => setTasks(taskProvider()), 250);
    return () => clearInterval(timer);
  }, [taskProvider]);
  const initialMessagesPublished = useRef(false);
  useEffect(() => {
    if (initialMessagesPublished.current) return;
    initialMessagesPublished.current = true;
    for (const message of initialMessages) dispatch({ type: "local_message", level: "info", message });
  }, [initialMessages]);
  useEffect(() => {
    setUserConfirmation(undefined);
  }, [session.pendingApproval?.requestId]);
  useEffect(() => {
    if (!controller) return;
    const unsubscribeSnapshot = controller.subscribe(setSession);
    const unsubscribeEvents = controller.subscribeEvents((event) =>
      dispatch({ type: "agent_event", event })
    );
    return () => {
      unsubscribeSnapshot();
      unsubscribeEvents();
    };
  }, [controller]);
  usePaste(
    (text) => editComposer({ type: "insert", text }),
    { isActive: !session.pendingApproval }
  );
  useInput((input, key) => {
    if (input.toLowerCase() === "b" && session.runStatus === "running") {
      const foreground = tasks.find((task) => task.mode === "foreground" && !["completed", "failed", "cancelled", "interrupted"].includes(task.status));
      if (foreground) moveTaskToBackground?.(foreground.id);
      return;
    }
    const mouse = parseSgrMouse(input);
    if (mouse?.type === "wheel") {
      dispatch({ type: "scroll", delta: mouse.direction === "up" ? 3 : -3 });
      return;
    }
    if (mouse?.type === "left_release") {
      if (session.pendingApproval && mouse.y >= rows - 4) {
        const decision = mouseApprovalDecision(session.pendingApproval, mouse.x);
        if (decision) controller?.resolveApprovalDecision(decision);
      } else if (mouse.y >= 2 && mouse.y < rows - 2) {
        dispatch({ type: "activate_transcript", index: visibleStart + mouse.y - 2 });
      }
      return;
    }
    if (key.ctrl && (input === "c" || input === "d")) {
      if (input === "c" && session.runStatus === "running") {
        dispatch({ type: "cancel_requested" });
        controller?.cancelActiveRun();
      }
      else if (session.runStatus === "idle") onRequestExit();
      return;
    }
    if (localConfirmation) {
      const answer = input.toLowerCase();
      if (answer === "y") {
        if (localConfirmation.id === "permission-permissive") {
          controller?.setPermissionMode("permissive");
          dispatch({ type: "local_message", level: "success", message: "Permission Mode changed to permissive for this session" });
        } else if (runtime) {
          void runtime.execute({
            kind: "confirmation.resolve",
            confirmationId: localConfirmation.id,
            accepted: true,
          }).then((result) => publishRuntimeResult(result, dispatch));
        }
        setLocalConfirmation(undefined);
      } else if (answer === "n" || key.escape) {
        if (localConfirmation.id !== "permission-permissive" && runtime) {
          void runtime.execute({
            kind: "confirmation.resolve",
            confirmationId: localConfirmation.id,
            accepted: false,
          }).then((result) => publishRuntimeResult(result, dispatch));
        } else {
          dispatch({ type: "local_message", level: "info", message: "Permission Mode was not changed" });
        }
        setLocalConfirmation(undefined);
      }
      return;
    }
    if (key.escape && session.runStatus === "running" && !session.pendingApproval) {
      dispatch({ type: "cancel_requested" });
      controller?.cancelActiveRun();
      return;
    }
    if (completion) {
      if (key.escape) {
        setCompletion(undefined);
        return;
      } else if (key.upArrow) setCompletion({
        ...completion,
        index: (completion.index - 1 + completion.commands.length) % completion.commands.length,
      });
      else if (key.downArrow || key.tab) setCompletion({
        ...completion,
        index: (completion.index + 1) % completion.commands.length,
      });
      else if (key.return) {
        completeComposer(completion.commands[completion.index]!);
        setCompletion(undefined);
      } else {
        setCompletion(undefined);
        // Continue below so the key that dismissed the menu still edits the Composer.
        return void (input && editComposer({ type: "insert", text: input }));
      }
      return;
    }
    if (session.pendingApproval) {
      const keyInput = input.toLowerCase();
      const scopes = session.pendingApproval.authorizationDecision?.allowedScopes ?? ["once"];
      if (keyInput === "y" && scopes.includes("once")) {
        controller?.resolveApprovalDecision({ kind: "allow_once" });
      } else if (keyInput === "s" && scopes.includes("session")) {
        controller?.resolveApprovalDecision({ kind: "allow_session" });
      } else if (keyInput === "l" && scopes.includes("persistent_local")) {
        controller?.resolveApprovalDecision(localPersistentDecision(session.pendingApproval));
      } else if (keyInput === "u" && scopes.includes("persistent_user")) {
        if (userConfirmation === session.pendingApproval.requestId) {
          controller?.resolveApprovalDecision(userPersistentDecision(session.pendingApproval));
        } else {
          setUserConfirmation(session.pendingApproval.requestId);
        }
      } else if (keyInput === "b" && userConfirmation === session.pendingApproval.requestId) {
        setUserConfirmation(undefined);
      } else if (keyInput === "n") controller?.resolveApprovalDecision({ kind: "deny" });
      else if (key.escape) {
        dispatch({ type: "cancel_requested" });
        controller?.cancelActiveRun();
      }
      return;
    }
    if (key.tab) {
      const slashPrefix = slashCompletionPrefix(composerRef.current);
      if (state.focus === "compose" && slashPrefix !== undefined) {
        const commands = uniqueCompletionCommands(slashRegistry.complete(slashPrefix));
        if (commands.length === 1) {
          completeComposer(commands[0]!);
          return;
        }
        if (commands.length > 1) {
          setCompletion({ commands, index: 0 });
          return;
        }
      }
      dispatch({ type: state.focus === "browse" ? "focus_compose" : "focus_browse" });
      return;
    }
    if (state.focus === "browse") {
      if (key.escape) dispatch({ type: "focus_compose" });
      else if (key.upArrow) dispatch({ type: "browse_move", delta: -1 });
      else if (key.downArrow) dispatch({ type: "browse_move", delta: 1 });
      else if (key.return) dispatch({ type: "toggle_selected" });
      else if (key.pageUp) dispatch({ type: "scroll", delta: Math.max(3, rows - 6) });
      else if (key.pageDown) dispatch({ type: "scroll", delta: -Math.max(3, rows - 6) });
      return;
    }
    if (key.return && !key.shift) {
      const text = composerRef.current.text;
      if (!text.trim() || !controller) return;
      const slashToken = /^\/(\S+)/u.exec(text.trim())?.[1];
      if (slashToken && !selectedSlashRef.current) {
        const candidates = slashRegistry.candidates(slashToken);
        if (candidates.length > 1) {
          setCompletion({ commands: candidates, index: 0 });
          return;
        }
      }
      setCompletion(undefined);
      const slash = new UserInputRouter(slashRegistry, () => ({
        runActive: controller.getSnapshot().runStatus === "running",
        enterPlanMode: () => controllerResult(controller.enterPlanMode(), "/plan"),
        executeActivePlan: async () => runtime
          ? runtimeCommandToSlash(await runtime.execute({ kind: "plan.execute" }), setLocalConfirmation, dispatch, "/do")
          : controllerResult(controller.executeActivePlan(), "/do"),
        startPrompt: async (modelText, displayText) => controllerResult(
          runtime
            ? await runtime.startRun({ modelText, displayText })
            : controller.startUserRun(modelText),
          displayText
        ),
        clearTranscript: () => dispatch({ type: "clear_transcript" }),
        status: async () => {
          const base = formatStatus({
            workspace,
            session: controller.getSnapshot(),
            state,
            toolNames,
            permissionSources,
            diagnostics: mcpDiagnostics?.() ?? [],
          });
          if (!runtime) return `${base}\nContinuity: unavailable`;
          return `${base}\n${formatRuntimeQuery(await runtime.inspect({ kind: "runtime.status" }))}`;
        },
        permission: () => {
          const snapshot = controller.getSnapshot();
          return {
            base: snapshot.permissionMode,
            effective: effectivePermission(snapshot.permissionMode, snapshot.taskMode),
            sources: permissionSources,
          };
        },
        setPermission: (mode) => { controller.setPermissionMode(mode); },
        confirmPermissive: () => {
          const confirmationId = "permission-permissive";
          setLocalConfirmation({
            id: confirmationId,
            message: "Permissive Mode allows most operations without approval. Nekoder has no OS sandbox.",
          });
          return {
            kind: "confirmation_required",
            confirmationId,
            message: "Permissive Mode allows most operations without approval. Nekoder has no OS sandbox. [Y] Confirm  [N] Cancel",
          };
        },
        compact: async () => runtimeCommandToSlash(
          runtime ? await runtime.execute({ kind: "context.compact" }) : runtimeUnavailable(),
          setLocalConfirmation,
          dispatch
        ),
        clearSession: async () => runtimeCommandToSlash(
          runtime ? await runtime.execute({ kind: "session.new" }) : runtimeUnavailable(),
          setLocalConfirmation,
          dispatch
        ),
        session: async (action) => {
          if (!runtime) return runtimeCommandToSlash(runtimeUnavailable(), setLocalConfirmation, dispatch);
          if (action.kind === "current") {
            return { kind: "info", message: formatRuntimeQuery(await runtime.inspect({ kind: "session.current" })) };
          }
          if (action.kind === "list") {
            return { kind: "info", message: formatRuntimeQuery(await runtime.inspect({ kind: "session.list", limit: 20 })) };
          }
          const command: RuntimeCommand = action.kind === "new"
            ? { kind: "session.new" }
            : action.kind === "resume"
              ? { kind: "session.resume", sessionId: action.sessionId! }
              : { kind: "session.delete", sessionId: action.sessionId! };
          return runtimeCommandToSlash(await runtime.execute(command), setLocalConfirmation, dispatch);
        },
        memory: async (action) => {
          if (!runtime) return runtimeCommandToSlash(runtimeUnavailable(), setLocalConfirmation, dispatch);
          if (action.kind === "status") {
            return { kind: "info", message: formatRuntimeQuery(await runtime.inspect({ kind: "memory.status" })) };
          }
          if (action.kind === "list") {
            return { kind: "info", message: formatRuntimeQuery(await runtime.inspect({
              kind: "memory.list",
              ...(action.scope === undefined ? {} : { scope: action.scope }),
              ...(action.type === undefined ? {} : { type: action.type }),
              limit: 20,
            })) };
          }
          if (action.kind === "show") {
            try {
              return { kind: "info", message: formatRuntimeQuery(await runtime.inspect({ kind: "memory.show", memoryId: action.memoryId! })) };
            } catch (error) {
              return { kind: "blocked", code: "not_found", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
            }
          }
          return runtimeCommandToSlash(
            await runtime.execute({ kind: "memory.forget", memoryId: action.memoryId! }),
            setLocalConfirmation,
            dispatch
          );
        },
        skillInstall: skillInstall ? async (source, project) => {
          try { return { kind: "success", message: await skillInstall(source, project) }; }
          catch (error) { return { kind: "blocked", code: "operation_failed", message: String(error).slice(0, 500) }; }
        } : undefined,
        skillCreate: skillCreate ? async (name, description, project) => {
          try { return { kind: "success", message: await skillCreate(name, description, project) }; }
          catch (error) { return { kind: "blocked", code: "operation_failed", message: String(error).slice(0, 500) }; }
        } : undefined,
      }));
      void slash.submit(text, selectedSlashRef.current).then((result) => {
        selectedSlashRef.current = undefined;
        const preserveComposer = result.kind === "blocked" && result.code === "run_active";
        if (!preserveComposer) composerRef.current = createComposerBuffer();
        if (result.kind === "run_started") {
          dispatch({ type: "user_submitted", text: result.displayText });
        } else if (result.kind === "success") {
          if (!result.clearTranscript) dispatch({ type: "composer_reset" });
          if (result.message) dispatch({ type: "local_message", level: "success", message: result.message });
        } else if (result.kind === "info") {
          dispatch({ type: "local_message", level: "info", message: result.message });
        } else if (result.kind === "confirmation_required") {
          dispatch({ type: "composer_reset" });
        } else {
          const message = result.kind === "usage_error"
            ? `${result.message}\nUsage: ${result.usage}`
            : result.message;
          dispatch({ type: "local_message", level: "error", message, preserveComposer });
        }
      });
      return;
    }
    if (key.return && key.shift) {
      editComposer({ type: "insert", text: "\n" });
      return;
    }
    if (key.leftArrow) {
      editComposer({ type: "move_left" });
      return;
    }
    if (key.rightArrow) {
      editComposer({ type: "move_right" });
      return;
    }
    if (key.home) {
      editComposer({ type: "move_home" });
      return;
    }
    if (key.end) {
      editComposer({ type: "move_end" });
      return;
    }
    if (key.ctrl && input === "z") {
      editComposer({ type: "undo" });
      return;
    }
    if (key.ctrl && input === "y") {
      editComposer({ type: "redo" });
      return;
    }
    if (key.backspace) {
      editComposer({ type: "backspace" });
      return;
    }
    if (key.delete) {
      editComposer({ type: "delete" });
      return;
    }
    if (key.pageUp) {
      dispatch({ type: "scroll", delta: Math.max(3, rows - 6) });
      return;
    }
    if (key.pageDown) {
      dispatch({ type: "scroll", delta: -Math.max(3, rows - 6) });
      return;
    }
    if (input) editComposer({ type: "insert", text: input });
  });
  useEffect(onInputReady, [onInputReady]);
  const transcriptCapacity = Math.max(1, rows - 4);
  const transcriptEnd = Math.max(0, state.transcript.length - state.scrollOffset);
  const virtualized = state.transcript.length > 50 || state.scrollOffset > 0;
  const visibleStart = virtualized ? Math.max(0, transcriptEnd - transcriptCapacity) : 0;
  const visibleTranscript = virtualized
    ? state.transcript.slice(visibleStart, transcriptEnd)
    : state.transcript;
  return (
    <Box flexDirection="row" width={columns} height={rows} overflow="hidden" alignItems="stretch">
      <Box flexDirection="column" flexGrow={1} height={rows} minWidth={0} overflow="hidden">
        <Text bold color={TUI_COLORS.brand}>Nekoder <Text dimColor>· {sanitizeTerminalText(workspace)}</Text></Text>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflowY="hidden" justifyContent="flex-end">
          {visibleTranscript.map((item, index) => (
            <TranscriptLine
              key={item.id}
              item={item}
              plainIcons={plainIcons}
              selected={state.focus === "browse" && state.selectedTranscriptIndex === visibleStart + index}
            />
          ))}
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          <ApprovalCard
            session={session}
            confirmingUser={userConfirmation === session.pendingApproval?.requestId}
          />
          {localConfirmation && (
            <Box flexDirection="column" borderStyle="round" borderColor={TUI_COLORS.approval} paddingX={1}>
              <Text bold>Local confirmation required</Text>
               <Text>{localConfirmation.message}</Text>
              <Text>[Y] Confirm  [N] Cancel</Text>
            </Box>
          )}
          {!session.pendingApproval && <ComposerLine text={state.composer.text} cursor={state.composer.cursor} />}
          {completion && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              {completion.commands.map((command, index) => (
                <Text key={command.name} inverse={index === completion.index}>
                  /{command.name} - {command.description}
                </Text>
              ))}
            </Box>
          )}
          <Text>
            <Text color={session.taskMode === "plan" ? TUI_COLORS.plan : TUI_COLORS.execute}>[{session.taskMode === "plan" ? "PLAN" : "EXECUTE"}]</Text>{" "}
            <Text>permission: {session.permissionMode}</Text>{" "}
            <Text color={runStateColor(session.pendingApproval ? "awaiting_approval" : state.runVisualState)}>
              {(session.pendingApproval ? "awaiting_approval" : state.runVisualState).toUpperCase()}
            </Text>
          </Text>
        </Box>
      </Box>
      {columns >= 120 && <NekoSidebar session={session} state={state} debug={debug} screenReader={screenReader} tasks={tasks} />}
    </Box>
  );
}

function localPersistentDecision(
  pending: NonNullable<SessionSnapshot["pendingApproval"]>
): ApprovalDecision {
  const target = pending.request.authorizationTarget;
  const match = pending.request.toolName === "run_command" && target?.cwd
    ? { command: target.primary, cwd: target.cwd }
    : target?.primary ?? JSON.stringify(pending.request.preparedInput);
  return {
    kind: "create_rule",
    scope: "local",
    rule: {
      id: `approval-${pending.requestId}`,
      tool: pending.request.toolName,
      match,
      decision: "allow",
    },
  };
}

function userPersistentDecision(
  pending: NonNullable<SessionSnapshot["pendingApproval"]>
): ApprovalDecision {
  const local = localPersistentDecision(pending);
  if (local.kind !== "create_rule") throw new Error("Persistent decision must create a rule");
  return {
    ...local,
    scope: "user",
    rule: {
      ...local.rule,
      match: pending.request.authorizationTarget?.primary
        ?? JSON.stringify(pending.request.preparedInput),
    },
  };
}

function mouseApprovalDecision(
  pending: NonNullable<SessionSnapshot["pendingApproval"]>,
  column: number
): ApprovalDecision | undefined {
  const scopes = pending.authorizationDecision?.allowedScopes ?? ["once"];
  let start = 2;
  const option = (label: string, decision: ApprovalDecision): ApprovalDecision | undefined => {
    const end = start + label.length;
    const selected = column >= start && column < end ? decision : undefined;
    start = end;
    return selected;
  };
  if (scopes.includes("once")) {
    const selected = option("[Y] Allow once  ", { kind: "allow_once" });
    if (selected) return selected;
  }
  if (scopes.includes("session")) {
    const selected = option("[S] Allow session  ", { kind: "allow_session" });
    if (selected) return selected;
  }
  if (scopes.includes("persistent_local")) {
    const selected = option("[L] Always allow locally  ", localPersistentDecision(pending));
    if (selected) return selected;
  }
  return option("[N] Deny", { kind: "deny" });
}

function controllerResult(result: ControllerResult, displayText: string): SlashCommandResult {
  if (result.ok && result.action === "run_started") {
    return { kind: "run_started", agentRunId: result.agentRunId, displayText };
  }
  if (result.ok) return { kind: "success", message: `Task Mode changed to ${result.taskMode}` };
  return {
    kind: "blocked",
    code: result.code === "no_active_plan" ? "no_active_plan" : result.code === "run_active" ? "run_active" : "unavailable",
    message: result.message,
  };
}

function slashCompletionPrefix(buffer: ReturnType<typeof createComposerBuffer>): string | undefined {
  if (!buffer.text.startsWith("/")) return undefined;
  const firstWhitespace = buffer.text.search(/\s/u);
  const tokenEnd = firstWhitespace < 0 ? buffer.text.length : firstWhitespace;
  if (buffer.cursor > tokenEnd) return undefined;
  return buffer.text.slice(1, buffer.cursor);
}

function uniqueCompletionCommands(
  completions: ReturnType<typeof BUILTIN_SLASH_REGISTRY.complete>
): SlashCommand[] {
  const commands = new Set<SlashCommand>();
  for (const completion of completions) commands.add(completion.command);
  return [...commands].sort((left, right) => left.name.localeCompare(right.name) || left.description.localeCompare(right.description));
}

function effectivePermission(base: PermissionMode, taskMode: TaskMode): PermissionMode {
  if (taskMode === "execute") return base;
  return base === "strict" ? "strict" : "plan";
}

function formatStatus(options: {
  readonly workspace: string;
  readonly session: SessionSnapshot;
  readonly state: ReturnType<typeof createTuiState>;
  readonly toolNames: readonly string[];
  readonly permissionSources: readonly string[];
  readonly diagnostics: readonly McpDiagnostic[];
}): string {
  const planTools = new Set(["read_file", "find_files", "search_text", "run_command"]);
  const visible = options.session.taskMode === "execute"
    ? [...options.toolNames]
    : options.toolNames.filter((name) => planTools.has(name));
  const hidden = options.toolNames.length - visible.length;
  const mcp = options.diagnostics.length === 0
    ? "none"
    : options.diagnostics.map((item) =>
        `${item.server}: ${item.status}, tools ${item.registeredTools}/${item.discoveredTools}${item.restartRequired ? ", restart required" : ""}`
      ).join("\n  ");
  return [
    `Task Mode: [${options.session.taskMode.toUpperCase()}]`,
    `Base Permission: ${options.session.permissionMode}`,
    `Effective Permission: ${effectivePermission(options.session.permissionMode, options.session.taskMode)}`,
    `Permission sources: ${options.permissionSources.join(", ") || "none"}`,
    `Agent Run: ${options.session.runStatus}`,
    `Active Plan: ${options.session.activePlanId ?? "none"}`,
    `Current tokens: ${totalTokens(options.state.usage)}`,
    `Cumulative tokens: ${totalTokens(options.state.cumulativeUsage)}`,
    `Workspace: ${resolvePath(options.workspace)}`,
    `Enabled Tools: ${visible.join(", ") || "none"}`,
    `Hidden Tools: ${hidden}`,
    `MCP:\n  ${mcp}`,
  ].join("\n");
}

function runtimeUnavailable(): RuntimeCommandResult {
  return { kind: "blocked", code: "operation_failed", message: "Continuity runtime is unavailable" };
}

function runtimeCommandToSlash(
  result: RuntimeCommandResult,
  setConfirmation: (value: { readonly id: string; readonly message: string } | undefined) => void,
  dispatch: (action: TuiAction) => void,
  displayText = ""
): SlashCommandResult {
  if (result.kind === "run_started") return { kind: "run_started", agentRunId: result.agentRunId, displayText };
  if (result.kind === "success") {
    if (result.clearTimeline) dispatch({ type: "clear_transcript" });
    return { kind: "success", message: result.message, clearTranscript: result.clearTimeline };
  }
  if (result.kind === "info") return result;
  if (result.kind === "confirmation_required") {
    setConfirmation({ id: result.confirmationId, message: result.message });
    return result;
  }
  return { kind: "blocked", code: result.code, message: result.message };
}

function publishRuntimeResult(result: RuntimeCommandResult, dispatch: (action: TuiAction) => void): void {
  if (result.kind === "run_started") return;
  if (result.kind === "success") {
    if (result.clearTimeline) dispatch({ type: "clear_transcript" });
    dispatch({ type: "local_message", level: "success", message: result.message });
  } else if (result.kind === "info") {
    dispatch({ type: "local_message", level: "info", message: result.message });
  } else if (result.kind === "blocked") {
    dispatch({ type: "local_message", level: "error", message: result.message });
  }
}

function formatRuntimeQuery(result: RuntimeQueryResult): string {
  if (result.kind === "runtime.status") {
    const { session, compaction, memory, memoryJobs } = result.value;
    const accuracy = compaction.accuracy === "estimated" ? "estimated" : "exact";
    return [
      `Session: ${session.id} · ${session.messageCount} messages`,
      `Context: ${compaction.accuracy === "estimated" ? "~" : ""}${compaction.currentTokens.toLocaleString("en-US")} / ${compaction.contextWindow.toLocaleString("en-US")} tokens · ${accuracy}`,
      `Compaction: ${compaction.circuitOpen ? "circuit open" : "ready"} · auto at ${compaction.autoThreshold.toLocaleString("en-US")} · failures ${compaction.failures}`,
      `Memory: ${memory.user} user + ${memory.project} project loaded`,
      `Memory health: ${memory.conflicts} conflict · ${memory.reviewDue} review due · ${memory.invalid} invalid`,
      ...(memoryJobs ? [`Memory jobs: ${memoryJobs.update.pending + memoryJobs.update.running} update pending/running · ${memoryJobs.update.failed} failed; ${memoryJobs.organize.pending + memoryJobs.organize.running} organize pending/running · ${memoryJobs.organize.failed} failed`] : []),
    ].join("\n");
  }
  if (result.kind === "session.current") {
    const item = result.value;
    return `${item.id}\nTitle: ${item.title || "untitled"}\nMessages: ${item.messageCount}\nUpdated: ${item.updatedAt}`;
  }
  if (result.kind === "session.list") {
    return result.value.length === 0
      ? "No Sessions"
      : result.value.map((item) => `${item.id} · ${item.messageCount} messages · ${item.title || "untitled"} · ${item.updatedAt}`).join("\n");
  }
  if (result.kind === "memory.status") {
    const item = result.value;
    return `Memory: ${item.loaded} loaded (${item.user} user, ${item.project} project)\nInjectable: ${item.injectable}\nConflicts: ${item.conflicts}\nReview due: ${item.reviewDue}\nInvalid: ${item.invalid}`;
  }
  if (result.kind === "memory.list") {
    return result.value.length === 0
      ? "No Memory Notes"
      : result.value.map((item) => `${item.id} · ${item.scope}/${item.type} · ${item.status}${item.conflict ? " · conflict" : ""}${item.reviewDue ? " · review due" : ""}\n  ${item.title}`).join("\n");
  }
  return result.value.raw;
}

export function startTui(options: StartTuiOptions): TuiApplication {
  let resolveInputReady!: () => void;
  const inputReady = new Promise<void>((resolve) => {
    resolveInputReady = resolve;
  });
  let stopApplication!: () => Promise<void>;
  const instance: Instance = render(
    <Shell
      {...options}
      onInputReady={resolveInputReady}
      onRequestExit={() => { void stopApplication(); }}
    />,
    {
      stdin: options.stdin,
      stdout: options.stdout,
      stderr: options.stderr,
      alternateScreen: true,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    }
  );
  options.stdout.write("\u001B[?1000h\u001B[?1006h");
  const ready = Promise.all([instance.waitUntilRenderFlush(), inputReady]).then(() => undefined);
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let stopped: Promise<void> | undefined;
  stopApplication = () => {
      stopped ??= (async () => {
        options.stdout.write("\u001B[?1006l\u001B[?1000l");
        options.controller?.dispose();
        await options.onDispose?.();
        instance.unmount();
        await instance.waitUntilExit();
      })().finally(resolveClosed);
      return stopped;
  };
  return {
    ready,
    flush: () => instance.waitUntilRenderFlush(),
    waitUntilExit: () => closed,
    stop: stopApplication,
  };
}
