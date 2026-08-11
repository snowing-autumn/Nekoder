import {
  parseSlashInput,
  type SlashCommandContext,
  type SlashCommandResult,
  type SlashRegistry,
} from "./registry.js";

export class UserInputRouter {
  constructor(
    readonly registry: SlashRegistry,
    private readonly context: () => SlashCommandContext
  ) {}

  async submit(rawText: string, selectedCommand?: import("./registry.js").SlashCommand): Promise<SlashCommandResult> {
    const parsed = parseSlashInput(this.registry, rawText);
    if (parsed.kind === "blank") {
      return { kind: "usage_error", message: "User input must not be blank", usage: "Enter a message or /help" };
    }
    if (parsed.kind === "unknown") {
      return {
        kind: "usage_error",
        message: `Unknown Slash command: /${parsed.commandName}. Use /help to list commands.`,
        usage: "/help",
      };
    }
    if (parsed.kind === "ambiguous") {
      if (selectedCommand && parsed.candidates.includes(selectedCommand)) {
        const context = this.context();
        if (context.runActive && selectedCommand.allowDuringRun !== true) return runActive();
        return selectedCommand.handle(context, parsed.args);
      }
      return {
        kind: "usage_error",
        message: `Slash name /${parsed.commandName} is ambiguous. Choose in the TUI: ${parsed.candidates.map((command) => `${command.description} (${command.destination})`).join("; ")}`,
        usage: `/${parsed.commandName}`,
      };
    }
    const context = this.context();
    if (parsed.kind === "ordinary") {
      if (context.runActive) return runActive();
      return await context.startPrompt(parsed.text, parsed.text);
    }
    if (context.runActive && parsed.command.allowDuringRun !== true) return runActive();
    return await parsed.command.handle(context, parsed.args);
  }
}

function runActive(): SlashCommandResult {
  return {
    kind: "blocked",
    code: "run_active",
    message: "An agent run is already active",
  };
}
