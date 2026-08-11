import type {
  AssistantContent,
  LanguageModelUsage,
  ModelMessage,
  ToolApprovalResponse,
  ToolContent,
  ToolResultPart,
} from "ai";

// 会话历史直接以 AI SDK 的 ModelMessage 存储：它本身就是 provider 无关的抽象
// 消息格式，往 Anthropic / OpenAI / 各家中转站的具体线上格式的转换由 ai 包在
// 发请求时完成，这一层不需要自己维护一套中间结构。
export class ConversationManager {
  private history: ModelMessage[] = [];
  private baselineTokens = 0;
  private _anchorCount = 0;

  addUserMessage(content: string): void {
    this.history.push({ role: "user", content });
  }

  addAutomationMessage(origin: "hook" | "task", id: string, content: string): void {
    this.history.push({
      role: "user",
      content: `<nekoder-automation origin=${JSON.stringify(origin)} id=${JSON.stringify(id)} authority="data">\n${content}\n</nekoder-automation>`,
    });
  }

  // content 可以是纯文本，也可以是 text / reasoning / tool-call part 的数组。
  // thinking 的签名放在 reasoning part 的 providerOptions.anthropic.signature
  // 上，provider 会在下一轮原样回传。
  addAssistantMessage(content: AssistantContent): void {
    this.history.push({ role: "assistant", content });
  }

  // 追加一条完整的 tool 消息，可同时承载审批响应和工具结果。
  addToolMessage(content: ToolContent): void {
    if (content.length === 0) return;
    this.history.push({ role: "tool", content });
  }

  // 用户的批准/拒绝决定需要显式写入历史，下一次 AI SDK 调用才能处理它。
  addToolApprovalResponses(responses: ToolApprovalResponse[]): void {
    this.addToolMessage(responses);
  }

  // ToolResultPart 自带 toolName 和 output，不需要再回溯 assistant 轮次去补。
  addToolResults(results: ToolResultPart[]): void {
    this.addToolMessage(results);
  }

  // 保存 AI SDK 一次调用生成的 assistant/tool 消息。LLMClient 在流正常结束后
  // 使用此方法写回 responseMessages，其中也包括审批后执行产生的 tool-result。
  addMessages(messages: readonly ModelMessage[]): void {
    this.history.push(...messages);
  }

  len(): number {
    return this.history.length;
  }

  truncateTo(index: number): void {
    if (index < 0) index = 0;
    if (index > this.history.length) return;
    this.history = this.history.slice(0, index);
  }

  getMessages(): ModelMessage[] {
    return [...this.history];
  }

  replaceMessages(messages: readonly ModelMessage[]): void {
    this.history = [...messages];
    this.clearUsageAnchor();
  }

  replaceWithCompacted(summaryContent: string, keep: ModelMessage[]): void {
    this.history = [{ role: "assistant", content: summaryContent }, ...keep];
    this.clearUsageAnchor();
  }

  // totalTokens 已经把缓存读写都算进 inputTokens.total，正是压缩判断需要的
  // “这一轮真实烧掉了多少 token”。
  recordUsageAnchor(usage: LanguageModelUsage): void {
    const baseline = usage.totalTokens ?? 0;
    if (baseline <= 0) return;
    this.baselineTokens = baseline;
    this._anchorCount = this.history.length;
  }

  clearUsageAnchor(): void {
    this.baselineTokens = 0;
    this._anchorCount = 0;
  }

  usageAnchorState(): { baselineTokens: number; anchorCount: number } | null {
    if (this.baselineTokens <= 0) return null;
    return {
      baselineTokens: this.baselineTokens,
      anchorCount: this._anchorCount,
    };
  }
}

export interface AutomationEnvelope { readonly origin: "hook" | "task"; readonly id: string; readonly content: string }

export class AutomationInbox {
  private pending: AutomationEnvelope[] = [];
  add(message: AutomationEnvelope): void { this.pending.push(Object.freeze({ ...message })); }
  drain(): readonly AutomationEnvelope[] { const messages = this.pending; this.pending = []; return messages; }
}
