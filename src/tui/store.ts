import type { AgentEvent, RunUsage } from "../agent/types.js";
import type { ToolCallResult } from "../tools/runner.js";
import {
  applyComposerAction,
  createComposerBuffer,
  type ComposerAction,
  type ComposerBuffer,
} from "./composer-buffer.js";

export type RunVisualState =
  | "idle"
  | "composing"
  | "generating"
  | "executing_tool"
  | "awaiting_approval"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export type TranscriptItem =
  | {
      readonly id: string;
      readonly type: "user";
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly type: "assistant";
      readonly text: string;
      readonly committed: boolean;
      readonly interrupted: boolean;
    }
  | {
      readonly id: string;
      readonly type: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly expanded: boolean;
      readonly status:
        | "pending"
        | "preflight"
        | "validated"
        | "awaiting_approval"
        | "authorized"
        | "running"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "skipped"
        | "not_executed";
      readonly result?: ToolCallResult["result"];
    }
  | {
      readonly id: string;
      readonly type: "run_notice";
      readonly status: string;
      readonly message?: string;
    };

export interface TuiState {
  readonly transcript: readonly TranscriptItem[];
  readonly runVisualState: RunVisualState;
  readonly composer: ComposerBuffer;
  readonly usage: RunUsage;
  readonly cumulativeUsage: RunUsage;
  readonly scrollOffset: number;
  readonly focus: "compose" | "browse" | "approval";
  readonly selectedTranscriptIndex?: number;
}

export function createTuiState(): TuiState {
  return {
    transcript: [],
    runVisualState: "idle",
    composer: createComposerBuffer(),
    usage: {},
    cumulativeUsage: {},
    scrollOffset: 0,
    focus: "compose",
  };
}

export type TuiAction =
  | { readonly type: "agent_event"; readonly event: AgentEvent }
  | { readonly type: "composer"; readonly action: ComposerAction }
  | { readonly type: "composer_reset" }
  | { readonly type: "scroll"; readonly delta: number }
  | { readonly type: "local_notice"; readonly message: string }
  | {
      readonly type: "local_message";
      readonly level: "info" | "success" | "error";
      readonly message: string;
      readonly preserveComposer?: boolean;
    }
  | { readonly type: "clear_transcript" }
  | { readonly type: "focus_browse" }
  | { readonly type: "focus_compose" }
  | { readonly type: "browse_move"; readonly delta: number }
  | { readonly type: "toggle_selected" }
  | { readonly type: "activate_transcript"; readonly index: number }
  | { readonly type: "cancel_requested" }
  | { readonly type: "user_submitted"; readonly text: string };

export function reduceTuiAction(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "agent_event":
      return reduceTuiState(state, action.event);
    case "composer":
      return { ...state, composer: applyComposerAction(state.composer, action.action) };
    case "composer_reset":
      return { ...state, composer: createComposerBuffer() };
    case "scroll":
      return {
        ...state,
        scrollOffset: Math.max(
          0,
          Math.min(state.transcript.length, state.scrollOffset + action.delta)
        ),
      };
    case "local_notice":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            id: `local-notice:${state.transcript.length}`,
            type: "run_notice",
            status: "rejected",
            message: action.message,
          },
        ],
      };
    case "local_message":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            id: `local-message:${state.transcript.length}`,
            type: "run_notice",
            status: action.level,
            message: action.message,
          },
        ],
        composer: action.preserveComposer ? state.composer : createComposerBuffer(),
        focus: action.preserveComposer ? state.focus : "compose",
        selectedTranscriptIndex: action.preserveComposer ? state.selectedTranscriptIndex : undefined,
      };
    case "clear_transcript":
      return {
        ...state,
        transcript: [],
        composer: createComposerBuffer(),
        scrollOffset: 0,
        focus: "compose",
        selectedTranscriptIndex: undefined,
      };
    case "focus_browse": {
      if (state.transcript.length === 0) return state;
      const lastTool = state.transcript.findLastIndex((item) => item.type === "tool");
      return {
        ...state,
        focus: "browse",
        selectedTranscriptIndex: lastTool >= 0 ? lastTool : state.transcript.length - 1,
      };
    }
    case "focus_compose":
      return { ...state, focus: "compose", selectedTranscriptIndex: undefined };
    case "browse_move": {
      if (state.transcript.length === 0) return state;
      const current = state.selectedTranscriptIndex ?? state.transcript.length - 1;
      return {
        ...state,
        focus: "browse",
        selectedTranscriptIndex: Math.max(0, Math.min(state.transcript.length - 1, current + action.delta)),
      };
    }
    case "toggle_selected": {
      const selected = state.selectedTranscriptIndex;
      if (selected === undefined) return state;
      return {
        ...state,
        transcript: state.transcript.map((item, index) =>
          index === selected && item.type === "tool"
            ? { ...item, expanded: !item.expanded }
            : item
        ),
      };
    }
    case "activate_transcript":
      if (action.index < 0 || action.index >= state.transcript.length) return state;
      return reduceTuiAction(
        { ...state, focus: "browse", selectedTranscriptIndex: action.index },
        { type: "toggle_selected" }
      );
    case "cancel_requested":
      return { ...state, runVisualState: "cancelling" };
    case "user_submitted":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            id: `user:${state.transcript.length}`,
            type: "user",
            text: action.text,
          },
        ],
        composer: createComposerBuffer(),
        focus: "compose",
        selectedTranscriptIndex: undefined,
      };
  }
}

export function reduceTuiState(state: TuiState, event: AgentEvent): TuiState {
  switch (event.type) {
    case "run_started":
      return { ...state, runVisualState: "generating", usage: {} };
    case "text_delta": {
      const id = `assistant:${event.agentRunId}:${event.step ?? "finalization"}`;
      const index = state.transcript.findIndex((item) => item.id === id);
      if (index < 0) {
        return {
          ...state,
          transcript: [
            ...state.transcript,
            { id, type: "assistant", text: event.delta, committed: false, interrupted: false },
          ],
        };
      }
      const item = state.transcript[index];
      if (item?.type !== "assistant") return state;
      return {
        ...state,
        transcript: state.transcript.map((candidate, itemIndex) =>
          itemIndex === index ? { ...item, text: item.text + event.delta } : candidate
        ),
      };
    }
    case "assistant_completed": {
      const id = `assistant:${event.agentRunId}:${event.step ?? "finalization"}`;
      return {
        ...state,
        transcript: state.transcript.map((item) =>
          item.id === id && item.type === "assistant" ? { ...item, committed: true } : item
        ),
      };
    }
    case "tool_call":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            id: `tool:${event.agentRunId}:${event.call.toolCallId}`,
            type: "tool",
            toolCallId: event.call.toolCallId,
            toolName: event.call.toolName,
            input: event.call.input,
            status: "pending",
            expanded: true,
          },
        ],
      };
    case "tool_event": {
      const callId = event.event.toolCallId;
      if (!callId) return state;
      const status = toolStatusFromEvent(event.event.type);
      if (!status) return state;
      return {
        ...state,
        runVisualState: status === "awaiting_approval"
          ? "awaiting_approval"
          : status === "running" ? "executing_tool" : state.runVisualState,
        transcript: updateTool(state.transcript, callId, (item) => ({ ...item, status })),
      };
    }
    case "tool_result": {
      const status = event.result.ok
        ? "succeeded"
        : event.result.error.code === "cancelled"
          ? "cancelled"
          : event.result.error.code === "skipped"
            ? "skipped"
            : "failed";
      return {
        ...state,
        runVisualState: "generating",
        transcript: updateTool(state.transcript, event.toolCallId, (item) => ({
          ...item,
          status,
          result: event.result,
          expanded: false,
        })),
      };
    }
    case "approval_requested":
      return { ...state, runVisualState: "awaiting_approval", focus: "approval" };
    case "approval_resolved":
      return { ...state, runVisualState: "executing_tool", focus: "browse" };
    case "usage":
      return {
        ...state,
        usage: { ...event.total },
        cumulativeUsage: addUsage(state.cumulativeUsage, event.delta),
      };
    case "run_finished": {
      const failed = event.status !== "completed";
      return {
        ...state,
        runVisualState: event.status === "cancelled"
          ? "cancelled"
          : failed ? "failed" : "completed",
        transcript: [
          ...state.transcript.map((item): TranscriptItem => {
            if (item.type === "assistant" && !item.committed) {
              return { ...item, interrupted: true };
            }
            if (item.type === "tool" && item.status === "pending") {
              return { ...item, status: "not_executed" };
            }
            return item;
          }),
          {
            id: `run-notice:${event.agentRunId}`,
            type: "run_notice",
            status: event.status,
            ...("message" in event ? { message: event.message } : {}),
          },
        ],
      };
    }
    default:
      return state;
  }
}

function updateTool(
  transcript: readonly TranscriptItem[],
  toolCallId: string,
  update: (item: Extract<TranscriptItem, { type: "tool" }>) => TranscriptItem
): readonly TranscriptItem[] {
  return transcript.map((item) =>
    item.type === "tool" && item.toolCallId === toolCallId ? update(item) : item
  );
}

function toolStatusFromEvent(
  type: Extract<AgentEvent, { type: "tool_event" }>["event"]["type"]
): Extract<TranscriptItem, { type: "tool" }>["status"] | undefined {
  switch (type) {
    case "requested": return "preflight";
    case "validated": return "validated";
    case "authorization_required": return "awaiting_approval";
    case "authorized": return "authorized";
    case "started": return "running";
    case "succeeded": return "succeeded";
    case "validation_failed":
    case "authorization_denied":
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "skipped": return "skipped";
    default: return undefined;
  }
}

function addUsage(total: RunUsage, delta: RunUsage): RunUsage {
  const next = { ...total };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ] as const) {
    const value = delta[key];
    if (value !== undefined) next[key] = (next[key] ?? 0) + value;
  }
  return next;
}
