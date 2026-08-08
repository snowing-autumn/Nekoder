import type {
  AssistantContent,
  LanguageModelUsage,
  ModelMessage,
  ToolResultPart,
} from "ai";

// 会话历史直接以 AI SDK 的 ModelMessage 存储：它本身就是 provider 无关的抽象
// 消息格式，往 Anthropic / OpenAI / 各家中转站的具体线上格式的转换由 ai 包在
// 发请求时完成，这一层不需要自己维护一套中间结构。
export class ConversationManager {
  private history: ModelMessage[] = [];
  private ltmInjected = false;
  private baselineTokens = 0;
  private _anchorCount = 0;

  addUserMessage(content: string): void {
    this.history.push({ role: "user", content });
  }

  // content 可以是纯文本，也可以是 text / reasoning / tool-call part 的数组。
  // thinking 的签名放在 reasoning part 的 providerOptions.anthropic.signature
  // 上，provider 会在下一轮原样回传。
  addAssistantMessage(content: AssistantContent): void {
    this.history.push({ role: "assistant", content });
  }

  // ToolResultPart 自带 toolName 和 output，不需要再回溯 assistant 轮次去补
  addToolResults(results: ToolResultPart[]): void {
    if (results.length === 0) return;
    this.history.push({ role: "tool", content: results });
  }

  addSystemReminder(content: string): void {
    this.history.push({
      role: "user",
      content: `<system-reminder>\n${content}\n</system-reminder>`,
    });
  }

  injectLongTermMemory(instructions: string, memories: string): void {
    if (this.ltmInjected) return;
    const sections: string[] = [];
    if (instructions) {
      sections.push(
        "# mewcodeMd\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n" +
          instructions
      );
    }
    if (memories) {
      sections.push("# autoMemory\n" + memories);
    }
    if (sections.length === 0) return;

    const today = new Date().toISOString().split("T")[0];
    sections.push(`# currentDate\nToday's date is ${today}.`);

    const body = sections.join("\n\n");
    const wrapped =
      "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n" +
      body +
      "\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>";

    this.history.unshift({ role: "user", content: wrapped });
    this.ltmInjected = true;
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

  replaceWithCompacted(summaryContent: string, keep: ModelMessage[]): void {
    this.history = [{ role: "user", content: summaryContent }, ...keep];
    this.ltmInjected = false;
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
