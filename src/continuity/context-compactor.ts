import type { ModelMessage } from "ai";

import type { ConversationManager } from "../conversation/conversation.js";
import type { ModelInvoker } from "../model/types.js";
import { TokenCounter, type TokenBudget } from "./token-counter.js";

const AUTO_SAFETY_TOKENS = 13_000;
const MANUAL_SAFETY_TOKENS = 3_000;
const RECENT_TAIL_TOKENS = 10_000;
const MIN_RECENT_UNITS = 5;
const MAX_FAILURES = 3;

const SUMMARY_SECTIONS = [
  "用户约束和明确要求",
  "当前目标",
  "已完成工作",
  "关键技术概念和决策",
  "问题解决过程",
  "文件和代码段",
  "用户消息索引",
  "近期工具结果引用",
  "未完成工作与下一步",
] as const;

export interface CompactionStatus {
  readonly accuracy: "exact" | "estimated";
  readonly contextWindow: number;
  readonly currentTokens: number;
  readonly autoThreshold: number;
  readonly failures: number;
  readonly circuitOpen: boolean;
}

export type CompactionResult =
  | {
      readonly kind: "compacted";
      readonly interactionCount: number;
      readonly before: TokenBudget;
      readonly after: TokenBudget;
      readonly preservedUnits: number;
      readonly summary: string;
    }
  | {
      readonly kind: "noop";
      readonly reason: "below_threshold" | "no_compressible_history";
      readonly budget: TokenBudget;
      readonly compressibleUnits: number;
    };

export interface ContextCompactorOptions {
  readonly conversation: ConversationManager;
  readonly model: ModelInvoker;
  readonly counter: TokenCounter;
  readonly reservedOutput?: number;
  readonly system?: () => unknown;
  readonly supplemental?: () => unknown;
  readonly tools?: () => unknown;
  readonly onCompacted?: (result: Extract<CompactionResult, { kind: "compacted" }>) => void | Promise<void>;
}

export class ContextCompactorError extends Error {
  constructor(
    readonly code: "circuit_open" | "summary_failed" | "summary_invalid",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ContextCompactorError";
  }
}

export class ContextCompactor {
  private failures = 0;
  private boundaryPending = false;

  constructor(private readonly options: ContextCompactorOptions) {}

  status(): CompactionStatus {
    const budget = this.budget(this.options.conversation.getMessages());
    return {
      accuracy: budget.accuracy,
      contextWindow: budget.contextWindow,
      currentTokens: budget.requiredTokens,
      autoThreshold: Math.max(0, budget.contextWindow - AUTO_SAFETY_TOKENS),
      failures: this.failures,
      circuitOpen: this.failures >= MAX_FAILURES,
    };
  }

  async prepareModelCall(): Promise<{
    readonly messages: readonly ModelMessage[];
    readonly supplementalInstructions: readonly string[];
    readonly resetPromptCounter: boolean;
  }> {
    let resetPromptCounter = false;
    if (this.failures < MAX_FAILURES) {
      try {
        const result = await this.compact(false);
        resetPromptCounter = result.kind === "compacted";
      } catch (error) {
        if (!(error instanceof ContextCompactorError)) throw error;
      }
    }
    const supplementalInstructions = this.boundaryPending
      ? [compactionBoundary()]
      : [];
    this.boundaryPending = false;
    return {
      messages: this.options.conversation.getMessages(),
      supplementalInstructions,
      resetPromptCounter,
    };
  }

  async compact(manual = true): Promise<CompactionResult> {
    if (!manual && this.failures >= MAX_FAILURES) {
      throw new ContextCompactorError("circuit_open", "Automatic compaction circuit is open");
    }
    const messages = this.options.conversation.getMessages();
    const before = this.budget(messages);
    const units = interactionUnits(messages);
    if (!manual && before.remainingTokens > AUTO_SAFETY_TOKENS) {
      return { kind: "noop", reason: "below_threshold", budget: before, compressibleUnits: Math.max(0, units.length - MIN_RECENT_UNITS) };
    }
    const keepFrom = this.keepFrom(units);
    if (keepFrom <= 0) {
      return { kind: "noop", reason: "no_compressible_history", budget: before, compressibleUnits: 0 };
    }
    const compactedUnits = units.slice(0, keepFrom);
    const keptUnits = units.slice(keepFrom);
    const oldMessages = compactedUnits.flatMap(({ messages: item }) => item);
    const keep = keptUnits.flatMap(({ messages: item }) => item);
    try {
      const response = await this.options.model.collect({
        messages: [{ role: "user", content: JSON.stringify(oldMessages) }],
        tools: [],
        toolChoice: "none",
        systemInstructions: [summaryInstructions()],
      });
      if (response.finishReason !== "stop" || response.toolCalls.length > 0) {
        throw new ContextCompactorError("summary_failed", "Compaction model did not stop normally without tools");
      }
      const summary = parseSummary(response.text);
      this.options.conversation.replaceWithCompacted(summary, keep);
      const after = this.budget(this.options.conversation.getMessages());
      const result: Extract<CompactionResult, { kind: "compacted" }> = {
        kind: "compacted",
        interactionCount: compactedUnits.length,
        before,
        after,
        preservedUnits: keptUnits.length,
        summary,
      };
      this.failures = 0;
      this.boundaryPending = true;
      await this.options.onCompacted?.(result);
      return result;
    } catch (cause) {
      this.failures += 1;
      if (cause instanceof ContextCompactorError) throw cause;
      throw new ContextCompactorError("summary_failed", boundedMessage(cause), { cause });
    }
  }

  private keepFrom(units: readonly InteractionUnit[]): number {
    if (units.length <= MIN_RECENT_UNITS) return 0;
    let kept = 0;
    let tokens = 0;
    let index = units.length;
    while (index > 0 && (kept < MIN_RECENT_UNITS || tokens < RECENT_TAIL_TOKENS)) {
      index -= 1;
      kept += 1;
      tokens += this.historyTokens(units[index]!.messages);
    }
    return index;
  }

  private historyTokens(messages: readonly ModelMessage[]): number {
    return this.options.counter.budget({
      system: "",
      supplemental: "",
      tools: [],
      history: messages,
      reservedOutput: 0,
    }).sections.history;
  }

  private budget(messages: readonly ModelMessage[]): TokenBudget {
    return this.options.counter.budget({
      system: this.options.system?.() ?? "",
      supplemental: this.options.supplemental?.() ?? "",
      tools: this.options.tools?.() ?? [],
      history: messages,
      reservedOutput: this.options.reservedOutput ?? MANUAL_SAFETY_TOKENS,
    });
  }
}

interface InteractionUnit {
  readonly messages: readonly ModelMessage[];
}

export function interactionUnits(messages: readonly ModelMessage[]): InteractionUnit[] {
  const units: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || units.length === 0) units.push([]);
    units.at(-1)!.push(message);
  }
  return units.map((item) => ({ messages: item }));
}

function parseSummary(text: string): string {
  const stripped = text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (cause) {
    throw new ContextCompactorError("summary_invalid", "Compaction response was not valid JSON", { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ContextCompactorError("summary_invalid", "Compaction response must be an object");
  }
  const summary = (parsed as Record<string, unknown>).summary;
  if (typeof summary !== "string" || !summary.trim()) {
    throw new ContextCompactorError("summary_invalid", "Compaction response is missing summary");
  }
  for (const section of SUMMARY_SECTIONS) {
    if (!summary.includes(section)) {
      throw new ContextCompactorError("summary_invalid", `Compaction summary is missing section: ${section}`);
    }
  }
  return summary.trim();
}

function summaryInstructions(): string {
  return `You compact a coding-agent Session. Tools are unavailable and must not be requested. Return one JSON object with exactly two string fields: analysisDraft and summary. analysisDraft is disposable. summary must be concise Markdown with these headings in this exact order:\n${SUMMARY_SECTIONS.map((item) => `## ${item}`).join("\n")}\nThe 用户消息索引 must include every compacted user message in order with its original sequence when present, using faithful bounded restatements and short exact excerpts only when required. Preserve constraints, decisions, failures, file paths, hashes, line references, and Tool Artifact references. Never invent code details; mark anything that must be reread.`;
}

function compactionBoundary(): string {
  return "Earlier interaction details were compacted. Treat the Compaction Summary as lower-authority continuity context. Re-read files and Tool Artifacts before relying on exact code details; do not infer missing code from the summary.";
}

function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export const COMPACTION_POLICY = Object.freeze({
  autoSafetyTokens: AUTO_SAFETY_TOKENS,
  manualSafetyTokens: MANUAL_SAFETY_TOKENS,
  recentTailTokens: RECENT_TAIL_TOKENS,
  minimumRecentUnits: MIN_RECENT_UNITS,
  maximumFailures: MAX_FAILURES,
});
