import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type TextStreamPart,
  type ToolSet,
} from "ai";

import type {
  ModelLimits,
  ProviderConfig,
  ReasoningEffort,
} from "../config/config.js";
import {
  resolveAPIKey,
  resolveModelLimits,
  resolveReasoning,
} from "../config/config.js";
import type { ConversationManager } from "../conversation/conversation.js";
import { ensureToolPairing } from "../conversation/pairing.js";
import {
  AuthenticationError,
  ContextTooLongError,
  LLMError,
  NetworkError,
  RateLimitError,
} from "./error.js";

// Anthropic prompt caching 的断点标记。打在某个内容块上时，该块之前的所有内容
// （system + 工具定义 + 历史消息）会作为前缀被缓存，下一轮命中前缀就只按缓存
// 读价计费。单次请求最多 4 个断点，所以只挑最稳定的三处：system 提示词末尾、
// 最后一个工具定义、最后一条 user 消息末尾。
const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };

export class LLMClient {
  private readonly model: LanguageModel;
  // cache_control 断点只有 Anthropic 原生协议支持
  private readonly isAnthropic: boolean;
  private readonly reasoning: ReasoningEffort | undefined;
  private readonly contextWindow: number;
  private systemPrompt: string;
  private maxOutputTokens: number;

  constructor(cfg: ProviderConfig, systemPrompt: string, limits: ModelLimits) {
    this.model = buildModel(cfg);
    this.isAnthropic = cfg.protocol === "anthropic";
    this.reasoning = resolveReasoning(cfg);
    this.contextWindow = limits.contextWindow;
    this.maxOutputTokens = limits.maxOutputTokens;
    this.systemPrompt = systemPrompt;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  setMaxOutputTokens(tokens: number): void {
    this.maxOutputTokens = tokens;
  }

  getContextWindow(): number {
    return this.contextWindow;
  }

  // 直接透传 AI SDK 的流式分片（text-delta / reasoning-delta / tool-input-* /
  // tool-call / finish 等），只把错误翻译成本项目的语义化异常。
  async *stream(
    conv: ConversationManager,
    tools: ToolSet = {},
    abortSignal?: AbortSignal
  ): AsyncGenerator<TextStreamPart<ToolSet>> {
    // 发请求前补齐工具调用与结果的配对：中断、恢复会话、并发交错都可能留下
    // 悬空的 tool-call，缺配对会被 API 直接拒掉。
    const messages = ensureToolPairing(conv.getMessages());
    const hasTools = Object.keys(tools).length > 0;

    const result = streamText({
      model: this.model,
      instructions: this.instructions(),
      messages: this.isAnthropic ? withLastUserCached(messages) : messages,
      maxOutputTokens: this.maxOutputTokens,
      ...(hasTools
        ? { tools: this.isAnthropic ? withLastToolCached(tools) : tools }
        : {}),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    });

    try {
      for await (const part of result.stream) {
        if (part.type === "error") throw classifyError(part.error);
        yield part;
      }
    } catch (err) {
      throw classifyError(err);
    }
  }

  private instructions(): SystemModelMessage {
    return {
      role: "system",
      content: this.systemPrompt,
      ...(this.isAnthropic ? { providerOptions: EPHEMERAL } : {}),
    };
  }
}

export async function createClient(
  cfg: ProviderConfig,
  systemPrompt: string
): Promise<LLMClient> {
  return new LLMClient(cfg, systemPrompt, await resolveModelLimits(cfg));
}

function buildModel(cfg: ProviderConfig): LanguageModel {
  const apiKey = resolveAPIKey(cfg);
  if (!apiKey) {
    throw new AuthenticationError(
      `未找到 provider "${cfg.name}" 的 API key。请在 .mewcode/config.yaml 里设置 api_key，或配置对应的环境变量。`
    );
  }

  switch (cfg.protocol) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL: cfg.base_url })(cfg.model);
    case "openai":
      return createOpenAI({ apiKey, baseURL: cfg.base_url })(cfg.model);
    case "openai-compat":
      return createOpenAICompatible({
        name: cfg.name,
        apiKey,
        baseURL: cfg.base_url,
        includeUsage: true,
      })(cfg.model);
  }
}

// Anthropic provider 会把消息级的 cacheControl 落到该消息的最后一个内容块，
// 等价于手工在块尾标 cache_control。返回副本，不改动 ConversationManager 里
// 存着的消息对象。
function withLastUserCached(messages: ModelMessage[]): ModelMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const copy = [...messages];
    copy[i] = { ...message, providerOptions: EPHEMERAL };
    return copy;
  }
  return messages;
}

// 工具定义整体是最稳定的前缀，只在最后一个工具上打断点，前面的一起进缓存。
function withLastToolCached(tools: ToolSet): ToolSet {
  const names = Object.keys(tools);
  const last = names[names.length - 1];
  if (last === undefined) return tools;
  return { ...tools, [last]: { ...tools[last], providerOptions: EPHEMERAL } };
}

function classifyError(err: unknown): Error {
  if (err instanceof LLMError) return err;

  if (APICallError.isInstance(err)) {
    const { statusCode, message } = err;
    if (statusCode === 413 || isContextLengthError(message)) {
      return new ContextTooLongError(`上下文超长：${message}`);
    }
    if (statusCode === 401 || statusCode === 403) {
      return new AuthenticationError(`API key 无效：${message}`);
    }
    if (statusCode === 429) {
      const retryAfter = err.responseHeaders?.["retry-after"];
      return new RateLimitError(
        retryAfter ? `触发限流，请 ${retryAfter}s 后重试。` : "触发限流，请稍候。",
        retryAfter
      );
    }
    return new LLMError(`API 错误 (${statusCode}): ${message}`);
  }

  return new NetworkError(`网络错误：${String(err)}`);
}

function isContextLengthError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("context_length_exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long")
  );
}
