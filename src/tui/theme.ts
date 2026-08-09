import type { RunVisualState, TranscriptItem } from "./store.js";

export const TUI_COLORS = {
  brand: "magenta",
  chrome: "white",
  user: "yellow",
  assistant: "cyan",
  composer: "green",
  plan: "blue",
  execute: "green",
  approval: "yellow",
  success: "green",
  danger: "red",
  command: "magenta",
  read: "cyan",
  write: "yellow",
} as const;

export type TuiColor = (typeof TUI_COLORS)[keyof typeof TUI_COLORS];

export function toolColor(
  item: Extract<TranscriptItem, { type: "tool" }>
): TuiColor {
  if (item.status === "failed" || item.status === "not_executed") return TUI_COLORS.danger;
  if (item.status === "succeeded") return TUI_COLORS.success;
  if (item.status === "awaiting_approval") return TUI_COLORS.approval;
  if (item.toolName === "run_command") return TUI_COLORS.command;
  if (item.toolName === "write_file" || item.toolName === "edit_file") return TUI_COLORS.write;
  return TUI_COLORS.read;
}

export function runStateColor(state: RunVisualState): TuiColor | undefined {
  switch (state) {
    case "completed": return TUI_COLORS.success;
    case "failed": return TUI_COLORS.danger;
    case "awaiting_approval": return TUI_COLORS.approval;
    case "executing_tool": return TUI_COLORS.command;
    case "generating": return TUI_COLORS.assistant;
    case "cancelling":
    case "cancelled": return TUI_COLORS.approval;
    default: return undefined;
  }
}
