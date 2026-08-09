import type { ModelUsage } from "../model/types.js";
import type { ToolEvent } from "../tools/events.js";
import type {
  ToolAuthorizationRequest,
  ToolCall,
  ToolCallResult,
} from "../tools/runner.js";

export type TaskMode = "plan" | "execute";

export interface RunUsage extends ModelUsage {}

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
    | { readonly status: "stopped"; readonly reason: "step_limit_reached" | "unknown_tool_loop" | "permission_denial_loop"; readonly finalizationText?: string }
    | { readonly status: "cancelled" }
    | {
        readonly status: "model_stopped";
        readonly reason: "length" | "content_filter" | "other" | "empty_response" | "protocol_error";
        readonly failedStep?: number;
      }
    | { readonly status: "model_failed"; readonly message: string; readonly failedStep?: number }
    | { readonly status: "finalization_failed"; readonly message: string }
  );

interface AgentEventBase {
  readonly agentRunId: string;
  readonly sequence: number;
  readonly timestamp: string;
}

type StepOrFinalization =
  | { readonly step: number; readonly finalization?: never }
  | { readonly step?: never; readonly finalization: true };

export type AgentEvent =
  | (AgentEventBase & { readonly type: "run_started"; readonly taskMode: TaskMode })
  | (AgentEventBase & { readonly type: "step_started"; readonly step: number })
  | (AgentEventBase & { readonly type: "text_delta"; readonly delta: string } & StepOrFinalization)
  | (AgentEventBase & { readonly type: "assistant_completed" } & StepOrFinalization)
  | (AgentEventBase & {
      readonly type: "tool_call";
      readonly step: number;
      readonly call: ToolCall;
    })
  | (AgentEventBase & {
      readonly type: "tool_event";
      readonly step: number;
      readonly toolSequence: number;
      readonly event: ToolEvent;
    })
  | (AgentEventBase & {
      readonly type: "tool_result";
      readonly step: number;
      readonly toolBatchId: string;
    } & ToolCallResult)
  | (AgentEventBase & {
      readonly type: "approval_requested";
      readonly step: number;
      readonly request: ToolAuthorizationRequest;
    })
  | (AgentEventBase & {
      readonly type: "approval_resolved";
      readonly step: number;
      readonly request: ToolAuthorizationRequest;
      readonly approved: boolean;
    })
  | (AgentEventBase & {
      readonly type: "usage";
      readonly delta: ModelUsage;
      readonly total: RunUsage;
    } & Partial<StepOrFinalization>)
  | (AgentEventBase & { readonly type: "step_finished"; readonly step: number })
  | (AgentEventBase & { readonly type: "run_finished" } & AgentOutcome);

export interface AgentRunHandle {
  readonly agentRunId: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<AgentOutcome>;
  cancel(): void;
}
