import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";

import type { ToolEvent, ToolEventSink, ToolEventType } from "./events.js";
import type { ToolRegistry } from "./registry.js";
import type { AuthorizationTarget, ToolResult } from "./types.js";
import type {
  ApprovalDecision,
  AuthorizationDecision as StructuredAuthorizationDecision,
} from "../security/types.js";

export interface ToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface ToolBatchContext {
  readonly toolBatchId: string;
  readonly workspace: string;
  readonly signal?: AbortSignal;
  readonly taskMode?: "plan" | "execute";
  readonly onEvent?: ToolEventSink;
  readonly onApproval?: (event: {
    readonly type: "requested" | "resolved";
    readonly request: ToolAuthorizationRequest;
    readonly approved?: boolean;
  }) => void | Promise<void>;
  readonly usedToolCallIds?: ReadonlySet<string>;
  readonly visibleToolNames?: ReadonlySet<string>;
  readonly postAuthorizationGate?: ToolAuthorizer;
}

export type AuthorizationDecision =
  | "allow"
  | "deny"
  | "require_approval"
  | StructuredAuthorizationDecision;

export interface ToolAuthorizationRequest {
  readonly toolBatchId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly effect: "read" | "write" | "execute";
  readonly preparedInput: unknown;
  readonly workspace: string;
  readonly taskMode: "plan" | "execute";
  readonly authorizationTarget?: AuthorizationTarget;
  readonly signal?: AbortSignal;
}

export interface ToolAuthorizer {
  authorize(request: ToolAuthorizationRequest): AuthorizationDecision | Promise<AuthorizationDecision>;
}

export interface ApprovalHandler {
  requestApproval(
    request: ToolAuthorizationRequest,
    decision?: Extract<StructuredAuthorizationDecision, { readonly kind: "ask" }>
  ): Promise<boolean | ApprovalDecision>;
}

export interface PersistentRuleWriter {
  add(scope: "local" | "user", rule: import("../security/types.js").PermissionRule): Promise<void>;
}

export interface ToolRunnerOptions {
  readonly authorizer?: ToolAuthorizer;
  /** A narrowing-only gate evaluated after permission approval and before execution. */
  readonly postAuthorizationGate?: ToolAuthorizer;
  readonly approvalHandler?: ApprovalHandler;
  readonly persistentRuleWriter?: PersistentRuleWriter;
  readonly eventSink?: ToolEventSink;
  readonly maxParallelReads?: number;
  /** Defer model-facing output budgeting to the continuity layer so it can persist Tool Artifacts first. */
  readonly deferOutputBudget?: boolean;
}

export interface ToolCallResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: ToolResult<unknown>;
}

export interface ToolBatchResult {
  readonly toolBatchId: string;
  readonly results: readonly ToolCallResult[];
}

export class ToolRunner {
  private readonly sessionApprovals = new Set<string>();

  private eventSequence = 0;
  private readonly ajv = new Ajv2020({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  });

  constructor(
    private readonly registry: ToolRegistry,
    private readonly options: ToolRunnerOptions = {}
  ) {
    const parallel = options.maxParallelReads ?? 4;
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 16) {
      throw new Error("maxParallelReads must be an integer from 1 to 16");
    }
  }

  async runBatch(
    calls: readonly ToolCall[],
    context: ToolBatchContext
  ): Promise<ToolBatchResult> {
    const sessionApprovalSnapshot = new Set(this.sessionApprovals);
    let emissionTail = Promise.resolve();
    const emit = (
      type: ToolEventType,
      call?: Pick<ToolCall, "toolCallId" | "toolName">,
      fields: Partial<
        Pick<
          ToolEvent,
          "durationMs" | "errorCode" | "submittedArgsHash" | "preparedArgsHash"
        >
      > = {}
    ): Promise<void> => {
      const event: ToolEvent = {
        sequence: ++this.eventSequence,
        timestamp: new Date().toISOString(),
        type,
        toolBatchId: context.toolBatchId,
        ...(call === undefined ? {} : call),
        ...fields,
      };
      const publish = async (): Promise<void> => {
        for (const sink of [this.options.eventSink, context.onEvent]) {
          try {
            await sink?.(event);
          } catch {
            // Observability must not change tool execution.
          }
        }
      };
      emissionTail = emissionTail.then(publish);
      return emissionTail;
    };
    await emit("batch_requested");
    if (calls.length > 16) {
      await emit("batch_preflight_failed");
      return {
        toolBatchId: context.toolBatchId,
        results: calls.map((call, index) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result:
            index === 16
              ? {
                  ok: false,
                  error: {
                    code: "batch_limit_exceeded",
                    message: "A tool batch may contain at most 16 calls",
                    retryable: false,
                  },
                }
              : {
                  ok: false,
                  error: {
                    code: "skipped",
                    message: "Tool call skipped because the batch limit was exceeded",
                    retryable: true,
                    details: { reason: "batch_limit_exceeded" },
                  },
                },
        })),
      };
    }
    const orchestrationCalls = calls.filter(({ toolName }) =>
      toolName === "use_skill" || toolName === "delegate_agent"
    );
    if (calls.length > 1 && orchestrationCalls.length > 0) {
      await emit("batch_preflight_failed");
      const orchestrationId = orchestrationCalls[0]!.toolCallId;
      return {
        toolBatchId: context.toolBatchId,
        results: calls.map((call) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: call.toolCallId === orchestrationId
            ? failure(
                "orchestration_tool_must_be_exclusive",
                `${call.toolName} must be the only call in its Tool Batch`,
                false
              )
            : skipped("batch_preflight_failed", orchestrationId, "orchestration_tool_must_be_exclusive"),
        })),
      };
    }
    const seenIds = new Set<string>();
    const duplicateIndexes = new Set<number>();
    calls.forEach((call, index) => {
      if (seenIds.has(call.toolCallId) || context.usedToolCallIds?.has(call.toolCallId)) {
        duplicateIndexes.add(index);
      }
      seenIds.add(call.toolCallId);
    });
    if (duplicateIndexes.size > 0) {
      await emit("batch_preflight_failed");
      return {
        toolBatchId: context.toolBatchId,
        results: calls.map((call, index) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: duplicateIndexes.has(index)
            ? {
                ok: false,
                error: {
                  code: "duplicate_tool_call_id",
                  message: `Duplicate tool-call ID: ${call.toolCallId}`,
                  retryable: false,
                },
              }
            : {
                ok: false,
                error: {
                  code: "skipped",
                  message: "Tool call skipped because batch preflight failed",
                  retryable: true,
                  details: {
                    reason: "batch_preflight_failed",
                    causedByToolCallId: calls[[...duplicateIndexes][0]!]?.toolCallId,
                    causedByErrorCode: "duplicate_tool_call_id",
                  },
                },
              },
        })),
      };
    }
    type PreparedEntry =
      | {
          call: ToolCall;
          tool: NonNullable<ReturnType<ToolRegistry["get"]>>;
          data: unknown;
          authorizationTarget?: AuthorizationTarget;
        }
      | { call: ToolCall; error: ToolResult<never> };
    const prepared = new Array<PreparedEntry>(calls.length);
    let nextPreparation = 0;
    const prepareWorker = async (): Promise<void> => {
      for (;;) {
        const index = nextPreparation++;
        if (index >= calls.length) return;
        const call = calls[index]!;
        await emit("requested", call, { submittedArgsHash: hashJson(call.input) });
        const tool = context.visibleToolNames?.has(call.toolName) === false
          ? undefined
          : this.registry.get(call.toolName);
        if (!tool) {
          await emit("validation_failed", call, { errorCode: "unknown_tool" });
          prepared[index] = {
            call,
            error: {
              ok: false,
              error: {
                code: "unknown_tool",
                message: `Unknown tool: ${call.toolName}`,
                retryable: false,
              },
            },
          };
          continue;
        }
        const validate = this.ajv.compile(tool.inputSchema);
        if (!validate(call.input)) {
          await emit("validation_failed", call, { errorCode: "invalid_input" });
          prepared[index] = {
            call,
            error: {
              ok: false,
              error: {
                code: "invalid_input",
                message: `Invalid input for tool: ${call.toolName}`,
                retryable: false,
                details: {
                  errors: (validate.errors ?? []).slice(0, 10).map((error) => ({
                    pointer: error.instancePath,
                    keyword: error.keyword,
                    message: error.message ?? "invalid value",
                  })),
                },
              },
            },
          };
          continue;
        }
        let preparation: ToolResult<unknown>;
        try {
          preparation = await withPreparationTimeout(tool, call.input, context);
        } catch (error) {
          preparation = {
            ok: false,
            error: {
              code: "internal_error",
              message: `Unexpected tool preparation failure: ${String(error)}`,
              retryable: true,
            },
          };
        }
        if (!preparation.ok) {
          await emit("validation_failed", call, { errorCode: preparation.error.code });
          prepared[index] = { call, error: preparation };
          continue;
        }
        let authorizationTarget: AuthorizationTarget | undefined;
        if (tool.authorizationTarget) {
          const target = await tool.authorizationTarget(preparation.data, {
            workspace: context.workspace,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          });
          if (!target.ok) {
            await emit("validation_failed", call, { errorCode: target.error.code });
            prepared[index] = { call, error: target };
            continue;
          }
          authorizationTarget = target.data;
        }
        await emit("validated", call, {
          submittedArgsHash: hashJson(call.input),
          preparedArgsHash: hashJson(preparation.data),
        });
        prepared[index] = {
          call,
          tool,
          data: preparation.data,
          ...(authorizationTarget === undefined ? {} : { authorizationTarget }),
        };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, calls.length) }, () => prepareWorker())
    );

    for (let index = 0; index < prepared.length; index++) {
      const entry = prepared[index]!;
      if ("error" in entry) continue;
      const { call, tool, data, authorizationTarget } = entry;
      const authorizationRequest: ToolAuthorizationRequest = {
        toolBatchId: context.toolBatchId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        effect: tool.effect,
        preparedInput: data,
        workspace: context.workspace,
        taskMode: context.taskMode ?? "execute",
        ...(authorizationTarget === undefined ? {} : { authorizationTarget }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      };
      const decision = await this.options.authorizer?.authorize(authorizationRequest) ?? "allow";
      if (decision === "deny" || (typeof decision === "object" && decision.kind === "deny")) {
        await emit("authorization_denied", call, { errorCode: "permission_denied" });
        prepared[index] = {
          call,
          error: failure(
            "permission_denied",
            typeof decision === "object" ? decision.reason : "Tool call was denied",
            false,
            {
              authorizationTarget,
              ...(typeof decision === "object"
                ? { source: decision.source, ...(decision.ruleId ? { ruleId: decision.ruleId } : {}) }
                : {}),
            }
          ),
        };
        continue;
      }
      if (decision === "require_approval" || (typeof decision === "object" && decision.kind === "ask")) {
        const sessionApprovalKey = approvalKey(authorizationRequest);
        if (
          typeof decision === "object"
          && decision.kind === "ask"
          && decision.allowedScopes.includes("session")
          && sessionApprovalSnapshot.has(sessionApprovalKey)
        ) {
          await emit("authorized", call);
          continue;
        }
        await emit("authorization_required", call);
        if (!this.options.approvalHandler) {
          prepared[index] = { call, error: failure("approval_required", "Tool call requires user approval") };
          continue;
        }
        await context.onApproval?.({ type: "requested", request: authorizationRequest });
        const approval = await this.options.approvalHandler.requestApproval(
          authorizationRequest,
          typeof decision === "object" && decision.kind === "ask" ? decision : undefined
        );
        let approved = typeof approval === "boolean"
          ? approval
          : approval.kind === "allow_once"
            ? typeof decision !== "object" || decision.kind !== "ask" || decision.allowedScopes.includes("once")
            : approval.kind === "allow_session"
              ? typeof decision === "object" && decision.kind === "ask" && decision.allowedScopes.includes("session")
              : approval.kind === "create_rule"
                ? typeof decision === "object"
                  && decision.kind === "ask"
                  && decision.allowedScopes.includes(
                    approval.scope === "local" ? "persistent_local" : "persistent_user"
                  )
                : false;
        if (approved && typeof approval !== "boolean" && approval.kind === "create_rule") {
          if (!this.options.persistentRuleWriter) {
            approved = false;
          } else {
            try {
              await this.options.persistentRuleWriter.add(approval.scope, approval.rule);
            } catch {
              approved = false;
            }
          }
        }
        if (approved && typeof approval !== "boolean" && approval.kind === "allow_session") {
          this.sessionApprovals.add(sessionApprovalKey);
        }
        await context.onApproval?.({ type: "resolved", request: authorizationRequest, approved });
        if (!approved) {
          await emit("authorization_denied", call, { errorCode: "approval_denied" });
          prepared[index] = {
            call,
            error: failure(
              "approval_denied",
              "User denied tool approval",
              false,
              { authorizationTarget }
            ),
          };
          continue;
        }
      }
      await emit("authorized", call);
    }

    const postAuthorizationGate = context.postAuthorizationGate ?? this.options.postAuthorizationGate;
    if (postAuthorizationGate) {
      for (let index = 0; index < prepared.length; index++) {
        const entry = prepared[index]!;
        if ("error" in entry) continue;
        const request: ToolAuthorizationRequest = {
          toolBatchId: context.toolBatchId,
          toolCallId: entry.call.toolCallId,
          toolName: entry.call.toolName,
          effect: entry.tool.effect,
          preparedInput: entry.data,
          workspace: context.workspace,
          taskMode: context.taskMode ?? "execute",
          ...(entry.authorizationTarget === undefined ? {} : { authorizationTarget: entry.authorizationTarget }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        };
        const decision = await postAuthorizationGate.authorize(request);
        if (decision === "deny" || decision === "require_approval" || (typeof decision === "object" && decision.kind !== "allow")) {
          const reason = typeof decision === "object" && "reason" in decision ? decision.reason : "Tool call was denied by an Agent Loop Hook";
          const ruleId = typeof decision === "object" && "ruleId" in decision ? decision.ruleId : undefined;
          prepared[index] = { call: entry.call, error: failure("hook_denied", reason, false, { authorizationTarget: entry.authorizationTarget, ...(ruleId ? { hookId: ruleId } : {}) }) };
          await emit("authorization_denied", entry.call, { errorCode: "hook_denied" });
        }
      }
    }

    const preflightFailed = prepared.some((entry) => "error" in entry);
    if (preflightFailed) {
      await emit("batch_preflight_failed");
      return {
        toolBatchId: context.toolBatchId,
        results: prepared.map((entry) => ({
          toolCallId: entry.call.toolCallId,
          toolName: entry.call.toolName,
          result: "error" in entry
            ? entry.error
            : skipped("batch_preflight_failed"),
        })),
      };
    }

    const executable = prepared as Array<{
      call: ToolCall;
      tool: NonNullable<ReturnType<ToolRegistry["get"]>>;
      data: unknown;
    }>;
    const results = new Array<ToolCallResult>(executable.length);
    let index = 0;
    let runtimeFailure: { callId: string; code: import("./types.js").ToolErrorCode } | undefined;
    const executeOne = async (entry: (typeof executable)[number]): Promise<ToolResult<unknown>> => {
      if (context.signal?.aborted) {
        await emit("cancelled", entry.call, { errorCode: "cancelled" });
        return failure("cancelled", "Tool call was cancelled");
      }
      await emit("started", entry.call);
      const started = performance.now();
      try {
        const executionController = new AbortController();
        let settleInterruption: ((result: ToolResult<unknown>) => void) | undefined;
        const interruption = new Promise<ToolResult<unknown>>((resolve) => {
          settleInterruption = resolve;
        });
        const onParentAbort = () => {
          settleInterruption?.(failure("cancelled", "Tool call was cancelled"));
          executionController.abort();
        };
        context.signal?.addEventListener("abort", onParentAbort, { once: true });
        const timeout = setTimeout(() => {
          settleInterruption?.({
            ok: false,
            error: {
              code: "timeout",
              message: `Tool exceeded its ${entry.tool.timeoutMs} ms timeout`,
              retryable: true,
            },
          });
          executionController.abort();
        }, entry.tool.timeoutMs);
        let result = await Promise.race([
          entry.tool.execute(entry.data, {
            workspace: context.workspace,
            signal: executionController.signal,
          }),
          interruption,
        ]);
        clearTimeout(timeout);
        context.signal?.removeEventListener("abort", onParentAbort);
        const encoded = Buffer.from(JSON.stringify(result), "utf8");
        if (!this.options.deferOutputBudget && encoded.byteLength > 64 * 1024) {
          result = {
            ok: false,
            error: {
              code: "output_limit_exceeded",
              message: "Tool result exceeded the 64 KiB output limit",
              retryable: false,
              details: {
                executionCompleted: true,
                originalBytes: encoded.byteLength,
                sha256: createHash("sha256").update(encoded).digest("hex"),
              },
            },
          };
        }
        await emit(result.ok ? "succeeded" : result.error.code === "cancelled" ? "cancelled" : "failed", entry.call, {
          durationMs: performance.now() - started,
          ...(result.ok ? {} : { errorCode: result.error.code }),
        });
        return result;
      } catch (error) {
        await emit("failed", entry.call, { durationMs: performance.now() - started, errorCode: "internal_error" });
        return {
          ok: false,
          error: {
            code: "internal_error",
            message: `Unexpected tool failure: ${String(error)}`,
            retryable: true,
          },
        };
      }
    };
    await emit("batch_started");
    while (index < executable.length) {
      if (runtimeFailure) {
        const entry = executable[index]!;
        results[index] = {
          toolCallId: entry.call.toolCallId,
          toolName: entry.call.toolName,
          result: skipped("earlier_runtime_failure", runtimeFailure.callId, runtimeFailure.code),
        };
        index++;
        continue;
      }
      const groupEnd = executable[index]!.tool.effect === "read"
        ? findReadGroupEnd(executable, index)
        : index + 1;
      const parallelReads = this.options.maxParallelReads ?? 4;
      for (let chunkStart = index; chunkStart < groupEnd; chunkStart += parallelReads) {
        const chunk = executable.slice(
          chunkStart,
          Math.min(groupEnd, chunkStart + parallelReads)
        );
        const chunkResults = await Promise.all(chunk.map(executeOne));
        chunkResults.forEach((result, offset) => {
          const resultIndex = chunkStart + offset;
          const entry = executable[resultIndex]!;
          results[resultIndex] = {
            toolCallId: entry.call.toolCallId,
            toolName: entry.call.toolName,
            result,
          };
        });
        const firstFailure = chunkResults.findIndex((result) => !result.ok);
        if (firstFailure >= 0) {
          const entry = chunk[firstFailure]!;
          const result = chunkResults[firstFailure]!;
          runtimeFailure = {
            callId: entry.call.toolCallId,
            code: result.ok ? "internal_error" : result.error.code,
          };
          for (let rest = chunkStart + chunk.length; rest < groupEnd; rest++) {
            const skippedEntry = executable[rest]!;
            results[rest] = {
              toolCallId: skippedEntry.call.toolCallId,
              toolName: skippedEntry.call.toolName,
              result: skipped("earlier_runtime_failure", runtimeFailure.callId, runtimeFailure.code),
            };
          }
          break;
        }
      }
      index = groupEnd;
    }
    await emit(context.signal?.aborted ? "batch_cancelled" : "batch_finished");
    return {
      toolBatchId: context.toolBatchId,
      results: this.options.deferOutputBudget ? results : applyBatchOutputBudget(results),
    };
  }
}

function approvalKey(request: ToolAuthorizationRequest): string {
  return canonicalJson({
    workspace: request.workspace,
    taskMode: request.taskMode,
    toolName: request.toolName,
    preparedInput: request.preparedInput,
    authorizationTarget: request.authorizationTarget,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function failure(
  code: import("./types.js").ToolErrorCode,
  message: string,
  retryable = false,
  details?: unknown
): ToolResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function skipped(
  reason: "batch_preflight_failed" | "earlier_runtime_failure" | "batch_cancelled",
  causedByToolCallId?: string,
  causedByErrorCode?: import("./types.js").ToolErrorCode
): ToolResult<never> {
  return {
    ok: false,
    error: {
      code: "skipped",
      message: "Tool call was skipped",
      retryable: true,
      details: {
        reason,
        ...(causedByToolCallId === undefined ? {} : { causedByToolCallId }),
        ...(causedByErrorCode === undefined ? {} : { causedByErrorCode }),
      },
    },
  };
}

function findReadGroupEnd(
  entries: ReadonlyArray<{ tool: { effect: "read" | "write" | "execute" } }>,
  start: number
): number {
  let end = start;
  while (end < entries.length && entries[end]!.tool.effect === "read") end++;
  return end;
}

function applyBatchOutputBudget(
  results: readonly ToolCallResult[]
): ToolCallResult[] {
  let usedBytes = 0;
  return results.map((entry) => {
    const encoded = Buffer.from(JSON.stringify(entry.result), "utf8");
    if (usedBytes + encoded.byteLength <= 128 * 1024) {
      usedBytes += encoded.byteLength;
      return entry;
    }
    const result: ToolResult<never> = {
      ok: false,
      error: {
        code: "output_limit_exceeded",
        message: "Tool result exceeded the remaining 128 KiB batch output budget",
        retryable: false,
        details: {
          executionCompleted: true,
          originalBytes: encoded.byteLength,
          sha256: createHash("sha256").update(encoded).digest("hex"),
        },
      },
    };
    usedBytes += Buffer.byteLength(JSON.stringify(result), "utf8");
    return { ...entry, result };
  });
}

async function withPreparationTimeout(
  tool: NonNullable<ReturnType<ToolRegistry["get"]>>,
  input: unknown,
  context: ToolBatchContext
): Promise<ToolResult<unknown>> {
  if (context.signal?.aborted) return failure("cancelled", "Tool preparation was cancelled");
  const controller = new AbortController();
  let interrupt: ((result: ToolResult<unknown>) => void) | undefined;
  const interrupted = new Promise<ToolResult<unknown>>((resolve) => {
    interrupt = resolve;
  });
  const onAbort = () => {
    interrupt?.(failure("cancelled", "Tool preparation was cancelled"));
    controller.abort();
  };
  context.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    interrupt?.({
      ok: false,
      error: {
        code: "timeout",
        message: "Tool preparation exceeded the 10 second timeout",
        retryable: true,
      },
    });
    controller.abort();
  }, 10_000);
  try {
    return await Promise.race([
      tool.prepare(input, { workspace: context.workspace, signal: controller.signal }),
      interrupted,
    ]);
  } finally {
    clearTimeout(timeout);
    context.signal?.removeEventListener("abort", onAbort);
  }
}

function hashJson(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;
    return createHash("sha256").update(json, "utf8").digest("hex");
  } catch {
    return undefined;
  }
}
