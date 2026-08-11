export type ToolName = string;

export type ToolEffect = "read" | "write" | "execute";

export type ToolErrorCode =
  | "invalid_input"
  | "unknown_tool"
  | "duplicate_tool_call_id"
  | "path_outside_workspace"
  | "not_found"
  | "not_a_file"
  | "range_out_of_bounds"
  | "conflict"
  | "multiple_matches"
  | "content_changed"
  | "file_changed_during_read"
  | "unsupported_content"
  | "file_too_large"
  | "permission_denied"
  | "approval_required"
  | "approval_denied"
  | "timeout"
  | "cancelled"
  | "execution_failed"
  | "mcp_server_unavailable"
  | "mcp_protocol_error"
  | "filesystem_error"
  | "output_limit_exceeded"
  | "batch_limit_exceeded"
  | "internal_error"
  | "skipped";

export type ToolResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ToolErrorCode;
        readonly message: string;
        readonly retryable: boolean;
        readonly details?: unknown;
      };
    };

export interface ToolInputSchema {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly [keyword: string]: unknown;
}

export interface ToolPreparationContext {
  readonly workspace: string;
  readonly signal?: AbortSignal;
}

export interface ToolExecutionContext extends ToolPreparationContext {}

export interface AuthorizationTarget {
  readonly primary: string;
  readonly maxApprovalScope?: "once" | "session" | "persistent";
  readonly cwd?: string;
  readonly shell?: "powershell" | "sh";
  readonly commands?: readonly string[];
  readonly requestedPath?: string;
  readonly resolvedPath?: string;
  readonly dynamic?: boolean;
  readonly sensitive?: boolean;
  readonly dangerous?: boolean;
  readonly protectedWritePath?: "permission_control_plane" | "git_metadata";
}

export interface Tool<I, P, O> {
  readonly name: ToolName;
  readonly description: string;
  readonly effect: ToolEffect;
  readonly inputSchema: ToolInputSchema;
  readonly timeoutMs: number;
  prepare(input: I, context: ToolPreparationContext): Promise<ToolResult<P>>;
  authorizationTarget?(
    prepared: P,
    context: ToolPreparationContext
  ): Promise<ToolResult<AuthorizationTarget>>;
  execute(prepared: P, context: ToolExecutionContext): Promise<ToolResult<O>>;
}

export type AnyTool = Tool<unknown, unknown, unknown>;
