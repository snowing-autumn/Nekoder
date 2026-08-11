export type TokenCountAccuracy = "exact" | "estimated";

export type TokenBudgetSection = "system" | "supplemental" | "tools" | "history";

export interface TokenCountSegment {
  readonly section: TokenBudgetSection;
  readonly value: unknown;
}

/** Adapter seam for a model tokenizer or a conservative local estimator. */
export interface TokenCountingAdapter {
  readonly accuracy: TokenCountAccuracy;
  count(segment: TokenCountSegment): number;
}

export interface TokenBudgetInput {
  readonly system: unknown;
  readonly supplemental: unknown;
  readonly tools: unknown;
  readonly history: unknown;
  readonly reservedOutput: number;
}

export interface TokenBudget {
  readonly accuracy: TokenCountAccuracy;
  readonly contextWindow: number;
  readonly sections: Readonly<Record<TokenBudgetSection, number>>;
  readonly inputTokens: number;
  readonly reservedOutput: number;
  readonly requiredTokens: number;
  readonly remainingTokens: number;
  readonly overflowTokens: number;
  readonly fits: boolean;
}

export type TokenCounterErrorCode = "invalid_configuration" | "invalid_input" | "count_failed";

export class TokenCounterError extends Error {
  constructor(
    readonly code: TokenCounterErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "TokenCounterError";
  }
}

export interface TokenCounterOptions {
  readonly contextWindow: number;
  /** When supplied, the exact Adapter always wins; runtime failures do not silently downgrade. */
  readonly exact?: TokenCountingAdapter;
  readonly estimator?: TokenCountingAdapter;
}

/**
 * Counts every context contributor and makes the fit decision in one place.
 * A count failure throws, so callers cannot accidentally proceed with a partial budget.
 */
export class TokenCounter {
  private readonly contextWindow: number;
  private readonly adapter: TokenCountingAdapter;

  constructor(options: TokenCounterOptions) {
    if (!isPositiveInteger(options.contextWindow)) {
      throw new TokenCounterError(
        "invalid_configuration",
        "TokenCounter contextWindow must be a positive integer"
      );
    }
    if (options.exact && options.exact.accuracy !== "exact") {
      throw new TokenCounterError(
        "invalid_configuration",
        "TokenCounter exact Adapter must report exact accuracy"
      );
    }
    if (options.estimator && options.estimator.accuracy !== "estimated") {
      throw new TokenCounterError(
        "invalid_configuration",
        "TokenCounter estimator Adapter must report estimated accuracy"
      );
    }
    this.contextWindow = options.contextWindow;
    this.adapter = options.exact ?? options.estimator ?? new ConservativeUtf8Estimator();
  }

  budget(input: TokenBudgetInput): TokenBudget {
    if (!isNonNegativeInteger(input.reservedOutput)) {
      throw new TokenCounterError(
        "invalid_input",
        "reservedOutput must be a non-negative integer"
      );
    }

    const sections = {
      system: this.count("system", input.system),
      supplemental: this.count("supplemental", input.supplemental),
      tools: this.count("tools", input.tools),
      history: this.count("history", input.history),
    } as const;
    const inputTokens = Object.values(sections).reduce((total, value) => total + value, 0);
    const requiredTokens = inputTokens + input.reservedOutput;
    const remaining = this.contextWindow - requiredTokens;
    return {
      accuracy: this.adapter.accuracy,
      contextWindow: this.contextWindow,
      sections,
      inputTokens,
      reservedOutput: input.reservedOutput,
      requiredTokens,
      remainingTokens: Math.max(0, remaining),
      overflowTokens: Math.max(0, -remaining),
      fits: remaining >= 0,
    };
  }

  private count(section: TokenBudgetSection, value: unknown): number {
    let count: number;
    try {
      count = this.adapter.count({ section, value });
    } catch (cause) {
      throw new TokenCounterError(
        "count_failed",
        `Unable to count ${section} tokens; context fit is unknown`,
        { cause }
      );
    }
    if (!isNonNegativeInteger(count)) {
      throw new TokenCounterError(
        "count_failed",
        `Token Adapter returned an invalid ${section} count; context fit is unknown`
      );
    }
    return count;
  }
}

/** Explicitly estimated fallback used because tokenlens does not expose tokenization. */
export class ConservativeUtf8Estimator implements TokenCountingAdapter {
  readonly accuracy = "estimated" as const;

  count(segment: TokenCountSegment): number {
    const serialized = serializeSegment(segment.value);
    if (!serialized) return 0;
    // Three UTF-8 bytes per token is deliberately more conservative than the common
    // four-character heuristic and behaves sensibly for CJK text.
    return Math.ceil(Buffer.byteLength(serialized, "utf8") / 3);
  }
}

function serializeSegment(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("value is not JSON-serializable");
    }
    return serialized;
  } catch (cause) {
    throw new TokenCounterError(
      "count_failed",
      "Token budget input is not JSON-serializable",
      { cause }
    );
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
