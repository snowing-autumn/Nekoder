import type { Message, ToolResultBlock } from "./conversation.js";

// Anthropic 要求每个 tool_use 都有配对的 tool_result，缺一个整条请求就会被拒。
// 会话历史出现不配对的情况有几种来路：用户中断在工具执行途中、进程退出后从磁盘
// 恢复会话、并发写入交错。这里在发请求前统一补齐，各前端不必各写一遍。

/** 用于补上没有结果的工具调用。工具可能压根没启动，也可能跑到一半被打断，
 *  所以措辞上不能断言它没有产生任何副作用。 */
export const INTERRUPTED_TOOL_RESULT =
  "Tool execution was interrupted. The tool may or may not have completed; verify before relying on its effects.";

/** 用于用户明确拒绝授权的工具调用。这种情况可以断言什么都没改，必须讲清楚，
 *  否则模型会以为修改已经生效并继续往下走。 */
export const REJECTED_TOOL_RESULT =
  "The user rejected this tool use. Nothing was changed (for file edits, the new content was NOT written).";

/**
 * 返回一份修好配对关系的消息副本，输入不会被修改。
 *
 * 做两件事：给没有结果的 tool_use 补一条标记为错误的 tool_result（紧跟其后），
 * 丢掉找不到对应 tool_use 的孤儿 tool_result。补出来的内容不写回对话历史：
 * 历史应当如实记录发生过什么，补位只是为了让这一次请求合法。
 */
export function ensureToolPairing(messages: Message[]): Message[] {
  const resolved = new Set<string>();
  const issued = new Set<string>();
  for (const m of messages) {
    for (const tr of m.toolResults ?? []) resolved.add(tr.toolUseId);
    for (const tu of m.toolUses ?? []) issued.add(tu.toolUseId);
  }

  const out: Message[] = [];
  for (const m of messages) {
    let current = m;
    if ((m.toolResults?.length ?? 0) > 0) {
      const kept = (m.toolResults ?? []).filter((tr) => issued.has(tr.toolUseId));
      if (kept.length === 0 && !m.content && !(m.toolUses?.length ?? 0)) {
        continue; // 整条消息只剩空壳，丢掉以免破坏角色交替
      }
      current = { ...m, toolResults: kept };
    }
    out.push(current);

    const missing: ToolResultBlock[] = [];
    for (const tu of m.toolUses ?? []) {
      if (resolved.has(tu.toolUseId)) continue;
      missing.push({
        toolUseId: tu.toolUseId,
        content: INTERRUPTED_TOOL_RESULT,
        isError: true,
      });
      resolved.add(tu.toolUseId);
    }
    if (missing.length > 0) {
      out.push({ role: "user", content: "", toolResults: missing });
    }
  }
  return out;
}
