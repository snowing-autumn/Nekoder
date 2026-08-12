export type SlashDestination = "local" | "prompt";

export type SlashCommandResult =
  | { readonly kind: "info"; readonly message: string }
  | { readonly kind: "success"; readonly message?: string; readonly clearTranscript?: boolean }
  | { readonly kind: "usage_error"; readonly message: string; readonly usage: string }
  | { readonly kind: "confirmation_required"; readonly message: string; readonly confirmationId: string }
  | { readonly kind: "run_started"; readonly agentRunId: string; readonly displayText: string }
  | {
      readonly kind: "blocked";
      readonly code: "run_active" | "no_active_plan" | "unavailable" | "not_found" | "operation_failed";
      readonly message: string;
    };

export type ProviderSlashAction =
  | { readonly kind: "list" }
  | { readonly kind: "switch"; readonly name: string };

export interface SlashCommandContext {
  readonly runActive: boolean;
  enterPlanMode(): SlashCommandResult | Promise<SlashCommandResult>;
  enterExecuteMode(): SlashCommandResult | Promise<SlashCommandResult>;
  executeActivePlan(): SlashCommandResult | Promise<SlashCommandResult>;
  startPrompt(modelText: string, displayText: string): SlashCommandResult | Promise<SlashCommandResult>;
  clearTranscript(): void;
  status(): string | Promise<string>;
  provider?(action: ProviderSlashAction): SlashCommandResult | Promise<SlashCommandResult>;
  permission(): { readonly base: string; readonly effective: string; readonly sources: readonly string[] };
  setPermission(mode: "strict" | "plan" | "default" | "acceptEdit" | "permissive"): void;
  confirmPermissive(): SlashCommandResult | Promise<SlashCommandResult>;
  compact?(): SlashCommandResult | Promise<SlashCommandResult>;
  clearSession?(): SlashCommandResult | Promise<SlashCommandResult>;
  session?(action: {
    readonly kind: "current" | "list" | "resume" | "new" | "delete";
    readonly sessionId?: string;
  }): SlashCommandResult | Promise<SlashCommandResult>;
  memory?(action: {
    readonly kind: "status" | "list" | "show" | "forget";
    readonly memoryId?: string;
    readonly scope?: "user" | "project";
    readonly type?: "preference" | "correction" | "project_knowledge" | "reference";
  }): SlashCommandResult | Promise<SlashCommandResult>;
  skillInstall?(source: string, project: boolean): SlashCommandResult | Promise<SlashCommandResult>;
  skillCreate?(name: string, description: string, project: boolean): SlashCommandResult | Promise<SlashCommandResult>;
}

export interface SlashCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly usage: string;
  readonly destination: SlashDestination;
  readonly argumentHint?: string;
  readonly hidden?: boolean;
  readonly available?: boolean;
  readonly allowDuringRun?: boolean;
  handle(context: SlashCommandContext, args: string): Promise<SlashCommandResult>;
}

export interface SlashCompletion {
  readonly token: string;
  readonly command: SlashCommand;
}

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;
const ALIAS_NAME = /^(?:\?|[a-z0-9][a-z0-9-]*)$/;

export class SlashRegistry {
  private readonly byCanonical = new Map<string, SlashCommand>();
  private readonly byToken = new Map<string, SlashCommand>();
  private sealed = false;
  private dynamic: SlashCommand[] = [];

  register(command: SlashCommand): void {
    if (this.sealed) throw new Error("SlashRegistry is sealed");
    if (!COMMAND_NAME.test(command.name)) throw new Error(`Invalid Slash command name: ${command.name}`);
    const tokens = [command.name, ...command.aliases];
    const ownTokens = new Set<string>();
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      const normalized = normalizeToken(token);
      const valid = index === 0 ? COMMAND_NAME.test(token) : ALIAS_NAME.test(token);
      if (!valid) throw new Error(`Invalid Slash command token: ${token}`);
      if (ownTokens.has(normalized) || this.byToken.has(normalized)) {
        throw new Error(`Duplicate Slash command token: ${token}`);
      }
      ownTokens.add(normalized);
    }
    this.byCanonical.set(command.name, command);
    for (const token of tokens) this.byToken.set(normalizeToken(token), command);
  }

  seal(): void {
    this.sealed = true;
  }

  isSealed(): boolean {
    return this.sealed;
  }

  resolve(token: string): SlashCommand | undefined {
    this.assertSealed();
    const candidates = this.candidates(token);
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  candidates(token: string): readonly SlashCommand[] {
    this.assertSealed();
    const normalized = normalizeToken(token);
    return Object.freeze([
      ...(this.byToken.get(normalized) ? [this.byToken.get(normalized)!] : []),
      ...this.dynamic.filter((command) => [command.name, ...command.aliases].some((item) => normalizeToken(item) === normalized)),
    ]);
  }

  replaceDynamic(commands: readonly SlashCommand[]): void {
    this.assertSealed();
    for (const command of commands) {
      if (!COMMAND_NAME.test(command.name) || command.aliases.some((alias) => !ALIAS_NAME.test(alias))) throw new Error(`Invalid dynamic Slash command: ${command.name}`);
    }
    this.dynamic = [...commands];
  }

  commands(): SlashCommand[] {
    this.assertSealed();
    return [...this.byCanonical.values(), ...this.dynamic].sort((left, right) => left.name.localeCompare(right.name));
  }

  visibleCommands(): SlashCommand[] {
    return this.commands().filter((command) => command.hidden !== true);
  }

  complete(prefix: string): SlashCompletion[] {
    this.assertSealed();
    const normalizedPrefix = normalizeToken(prefix);
    const candidates: SlashCompletion[] = [];
    for (const command of this.visibleCommands()) {
      for (const token of [command.name, ...command.aliases]) {
        if (normalizeToken(token).startsWith(normalizedPrefix)) candidates.push({ token, command });
      }
    }
    return candidates.sort((left, right) => left.token.localeCompare(right.token));
  }

  private assertSealed(): void {
    if (!this.sealed) throw new Error("SlashRegistry must be sealed before use");
  }
}

export type ParsedSlashInput =
  | { readonly kind: "blank" }
  | { readonly kind: "ordinary"; readonly text: string }
  | { readonly kind: "unknown"; readonly commandName: string }
  | { readonly kind: "ambiguous"; readonly commandName: string; readonly candidates: readonly SlashCommand[]; readonly args: string }
  | {
      readonly kind: "command";
      readonly command: SlashCommand;
      readonly invokedAs: string;
      readonly args: string;
    };

export function parseSlashInput(registry: SlashRegistry, rawText: string): ParsedSlashInput {
  const trimmed = rawText.trim();
  if (!trimmed) return { kind: "blank" };
  if (!trimmed.startsWith("/")) return { kind: "ordinary", text: rawText };
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(trimmed);
  const invokedAs = match?.[1] ?? "";
  const candidates = registry.candidates(invokedAs);
  if (candidates.length === 0) return { kind: "unknown", commandName: invokedAs };
  if (candidates.length > 1) return { kind: "ambiguous", commandName: invokedAs, candidates, args: match?.[2] ?? "" };
  const command = candidates[0]!;
  return {
    kind: "command",
    command,
    invokedAs,
    args: match?.[2] ?? "",
  };
}

function normalizeToken(token: string): string {
  return token.replace(/^\//u, "").toLowerCase();
}
