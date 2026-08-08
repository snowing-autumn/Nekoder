import type {
  ModelMessage,
  ToolCallPart,
  ToolResultPart,
} from "ai";

// AI SDK 会校验历史中的每个 tool-call 是否有对应的 tool-result，但不会为传入的
// 历史记录自动补齐结果。中断工具执行、从磁盘恢复会话等情况都可能留下悬空调用，
// 因此在请求模型前统一修复，避免各个调用方重复处理。

/**
 * 用于补上没有结果的工具调用。
 *
 * 工具可能根本没有启动，也可能执行到一半后被中断，所以不能断言它没有产生副作用。
 */
export const INTERRUPTED_TOOL_RESULT =
  "Tool execution was interrupted. The tool may or may not have completed; verify before relying on its effects.";

/**
 * 用于用户明确拒绝授权的工具调用。
 */
export const REJECTED_TOOL_RESULT =
  "The user rejected this tool use. Nothing was changed (for file edits, the new content was NOT written).";

/**
 * 返回一份修复好工具调用配对关系的消息副本，不修改输入。
 *
 * - 给没有结果的本地 tool-call 补一条 error-text tool-result；
 * - 丢弃没有对应、且位于调用之前的孤儿或重复 tool-result；
 * - providerExecuted 调用由 provider 自己管理，不要求本地 tool-result；
 * - 在下一条非 tool 消息之前补齐结果，以满足 AI SDK 的历史校验规则。
 *
 * 补出的结果只用于当前请求合法化，不应写回真实会话历史。
 */
export function ensureToolPairing(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  // pending 只表示“如果到边界仍未处理，就需要补中断结果”。审批响应可以解除
  // pending，但不代表真实 tool-result 已经出现。
  const pending = new Map<string, ToolCallPart>();
  // 已出现过的本地调用，用于判断 tool-result 是合法结果还是孤儿结果。
  const knownToolCalls = new Set<string>();
  // 每个调用只保留一个结果；与 pending 分开，避免审批响应使合法结果被误删。
  const resultSeen = new Set<string>();
  const approvalToolCalls = new Map<string, string>();

  const appendMissingResults = (): void => {
    if (pending.size === 0) return;

    const content: ToolResultPart[] = Array.from(
      pending.values(),
      (toolCall): ToolResultPart => ({
        type: "tool-result",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        output: {
          type: "error-text",
          value: INTERRUPTED_TOOL_RESULT,
        },
      })
    );

    out.push({ role: "tool", content });
    for (const toolCallId of pending.keys()) resultSeen.add(toolCallId);
    pending.clear();
  };

  for (const message of messages) {
    if (message.role !== "tool") {
      // AI SDK 在遇到 user/system 消息时要求前面的调用已全部得到结果；同时将
      // 结果紧邻调用放置，也兼容对消息顺序要求更严格的 provider。
      appendMissingResults();
    }

    if (message.role === "assistant") {
      out.push(message);
      if (!Array.isArray(message.content)) continue;

      for (const part of message.content) {
        if (part.type === "tool-call" && !part.providerExecuted) {
          knownToolCalls.add(part.toolCallId);
          pending.set(part.toolCallId, part);
        } else if (part.type === "tool-approval-request") {
          approvalToolCalls.set(part.approvalId, part.toolCallId);
        }
      }
      continue;
    }

    if (message.role === "tool") {
      const content = message.content.filter((part) => {
        // AI SDK 将审批响应也视为该调用已有后续处理，不再要求 tool-result。
        if (part.type === "tool-approval-response") {
          const toolCallId = approvalToolCalls.get(part.approvalId);
          if (toolCallId !== undefined) pending.delete(toolCallId);
          return true;
        }
        if (part.type !== "tool-result") return true;

        // 结果是否合法取决于是否存在对应调用，而不是该调用是否仍在 pending。
        // 审批响应会提前解除 pending，但随后由 SDK 产生的真实结果仍必须保留。
        if (!knownToolCalls.has(part.toolCallId)) return false;
        if (resultSeen.has(part.toolCallId)) return false;

        resultSeen.add(part.toolCallId);
        pending.delete(part.toolCallId);
        return true;
      });

      if (content.length > 0) {
        out.push({ ...message, content });
      }
      continue;
    }

    out.push(message);
  }

  appendMissingResults();
  return out;
}
