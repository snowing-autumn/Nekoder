export type ToolEventType =
  | "batch_requested"
  | "batch_preflight_failed"
  | "batch_started"
  | "batch_finished"
  | "batch_cancelled"
  | "requested"
  | "validation_failed"
  | "validated"
  | "authorization_denied"
  | "authorization_required"
  | "authorized"
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export interface ToolEvent {
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: ToolEventType;
  readonly toolBatchId: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly submittedArgsHash?: string;
  readonly preparedArgsHash?: string;
}

export type ToolEventSink = (event: ToolEvent) => void | Promise<void>;
