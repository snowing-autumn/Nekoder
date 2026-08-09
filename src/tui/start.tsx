import React, { useEffect, useReducer, useRef, useState } from "react";
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
import type { ApprovalDecision } from "../security/types.js";
import {
  applyComposerAction,
  createComposerBuffer,
  type ComposerAction,
} from "./composer-buffer.js";
import type { SessionController, SessionSnapshot } from "./session-controller.js";
import { parseSgrMouse } from "./mouse-input.js";
import { parseSafeMarkdown } from "./markdown.js";
import { createTuiState, reduceTuiAction, type TranscriptItem } from "./store.js";
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
}

export interface TuiApplication {
  readonly ready: Promise<void>;
  flush(): Promise<void>;
  waitUntilExit(): Promise<void>;
  stop(): Promise<void>;
}

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
  if (status === "completed") return TUI_COLORS.success;
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
      <Text>input: {sanitizeTerminalText(JSON.stringify(input))}</Text>
      {pending.request.toolName === "run_command" && <Text>command: {command}</Text>}
      {pending.request.toolName === "run_command" && <Text>cwd: {cwd}</Text>}
      {decision && <Text>scopes: {decision.allowedScopes.join(", ")}</Text>}
      {pending.request.toolName === "run_command" && <Text color={TUI_COLORS.approval}>Nekoder cannot prove this command has no side effects.</Text>}
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

function NekoSidebar({
  session,
  state,
  debug,
  screenReader,
}: {
  readonly session: SessionSnapshot;
  readonly state: ReturnType<typeof createTuiState>;
  readonly debug?: boolean;
  readonly screenReader?: boolean;
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
  onInputReady,
  onRequestExit,
}: ShellProps) {
  const { columns, rows } = useWindowSize();
  const screenReader = process.env.INK_SCREEN_READER === "true";
  const [state, dispatch] = useReducer(reduceTuiAction, undefined, createTuiState);
  const composerRef = useRef(state.composer);
  useEffect(() => {
    composerRef.current = state.composer;
  }, [state.composer]);
  const editComposer = (action: ComposerAction): void => {
    composerRef.current = applyComposerAction(composerRef.current, action);
    dispatch({ type: "composer", action });
  };
  const [session, setSession] = useState<SessionSnapshot>(() =>
    controller?.getSnapshot() ?? { taskMode, permissionMode: "default", runStatus: "idle" }
  );
  const [userConfirmation, setUserConfirmation] = useState<string>();
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
    if (key.escape && session.runStatus === "running" && !session.pendingApproval) {
      dispatch({ type: "cancel_requested" });
      controller?.cancelActiveRun();
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
      const result = controller.submit(text);
      if (result.ok && result.action === "run_started") {
        composerRef.current = createComposerBuffer();
        dispatch({ type: "user_submitted", text });
      } else if (result.ok && result.action === "mode_changed") {
        composerRef.current = createComposerBuffer();
        dispatch({ type: "composer_reset" });
      } else if (!result.ok) {
        dispatch({ type: "local_notice", message: result.message });
      }
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
          {!session.pendingApproval && <ComposerLine text={state.composer.text} cursor={state.composer.cursor} />}
          <Text>
            <Text color={session.taskMode === "plan" ? TUI_COLORS.plan : TUI_COLORS.execute}>[{session.taskMode === "plan" ? "PLAN" : "EXECUTE"}]</Text>{" "}
            <Text>[{session.permissionMode.toUpperCase()}]</Text>{" "}
            <Text color={runStateColor(session.pendingApproval ? "awaiting_approval" : state.runVisualState)}>
              {(session.pendingApproval ? "awaiting_approval" : state.runVisualState).toUpperCase()}
            </Text>
          </Text>
        </Box>
      </Box>
      {columns >= 120 && <NekoSidebar session={session} state={state} debug={debug} screenReader={screenReader} />}
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
