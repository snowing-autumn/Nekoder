import type { ModelUsage } from "../model/types.js";

export type TaskMode = "plan" | "execute";

export interface RunUsage extends ModelUsage {}

export interface AgentEvent {
  readonly agentRunId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type:
    | "run_started"
    | "step_started"
    | "text_delta"
    | "assistant_completed"
    | "tool_call"
    | "tool_event"
    | "tool_result"
    | "approval_requested"
    | "approval_resolved"
    | "usage"
    | "step_finished"
    | "run_finished";
  readonly [field: string]: unknown;
}

export interface AgentOutcomeBase {
  readonly agentRunId: string;
  readonly status: string;
  readonly stepsCompleted: number;
  readonly usage: RunUsage;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type AgentOutcome = AgentOutcomeBase &
  (
    | { readonly status: "completed"; readonly finalText: string; readonly activePlanId?: string }
    | { readonly status: "stopped"; readonly reason: "step_limit_reached" | "unknown_tool_loop"; readonly finalizationText?: string }
    | { readonly status: "cancelled" }
    | {
        readonly status: "model_stopped";
        readonly reason: "length" | "content_filter" | "other" | "empty_response" | "protocol_error";
        readonly failedStep?: number;
      }
    | { readonly status: "model_failed"; readonly message: string; readonly failedStep?: number }
    | { readonly status: "finalization_failed"; readonly message: string }
  );

export interface AgentRunHandle {
  readonly agentRunId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentOutcome>;
  cancel(): void;
}
