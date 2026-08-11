import {
  SlashRegistry,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./registry.js";

const REVIEW_PROMPT = `Review the current uncommitted changes in this Workspace. This is a read-only review: do not modify files.

First inspect the repository's documented standards and the relevant diff and surrounding code. Report only concrete, actionable defects introduced by the current changes. Prioritize correctness, security, data loss, concurrency, compatibility, and missing tests that could allow a regression. Do not report stylistic preferences unless a repository rule makes them mandatory.

List findings in descending severity. Each finding must identify the file and the smallest useful line range, explain the failure scenario, and state why it matters. Do not pad the response with a generic summary presented as a finding. If there are no findings, say so explicitly and mention any residual risks or tests you could not run.

Additional review scope from the user:
<review-scope>
{{scope}}
</review-scope>`;

export function createBuiltinSlashRegistry(): SlashRegistry {
  const registry = new SlashRegistry();
  const commands: SlashCommand[] = [
    {
      name: "help", aliases: ["?", "h"], description: "Show Slash command help",
      usage: "/help [command]", argumentHint: "command", destination: "local", allowDuringRun: true,
      async handle(context, args) {
        if (!args) {
          const lines = registry.visibleCommands().map((command) =>
            `/${command.name} [${availability(command, context)}] - ${command.description}`
          );
          return { kind: "info", message: lines.join("\n") };
        }
        if (/\s/u.test(args)) return usage("Too many arguments", "/help [command]");
        const command = registry.resolve(args.replace(/^\//u, ""));
        if (!command) return usage(`Unknown Slash command: ${args}`, "/help [command]");
        const aliases = command.aliases.length > 0
          ? command.aliases.map((alias) => `/${alias}`).join(", ")
          : "none";
        return {
          kind: "info",
          message: [
            `/${command.name}`,
            command.description,
            `Usage: ${command.usage}`,
            `Aliases: ${aliases}`,
            `Availability: ${availability(command, context)}`,
            command.argumentHint ? `Arguments: ${command.argumentHint}` : undefined,
          ].filter((line): line is string => line !== undefined).join("\n"),
        };
      },
    },
    unavailable("compact", "Compact the current context", "/compact"),
    unavailable("clear", "Close this Session and start a clean Session", "/clear"),
    {
      name: "cls", aliases: [], description: "Clear the visible timeline only", usage: "/cls",
      destination: "local", allowDuringRun: false,
      async handle(context, args) {
        if (args) return usage("/cls does not accept arguments", "/cls");
        context.clearTranscript();
        return { kind: "success", clearTranscript: true };
      },
    },
    {
      name: "plan", aliases: [], description: "Enter Plan Mode", usage: "/plan",
      destination: "local", allowDuringRun: false,
      async handle(context, args) {
        if (args) return usage("/plan does not accept arguments", "/plan");
        return await context.enterPlanMode();
      },
    },
    {
      name: "do", aliases: [], description: "Execute the active Plan", usage: "/do",
      destination: "local", allowDuringRun: false,
      async handle(context, args) {
        if (args) return usage("/do does not accept arguments", "/do");
        return await context.executeActivePlan();
      },
    },
    unavailable("session", "Manage persistent Sessions", "/session [list|resume <id>|new|delete <id>]", "action"),
    unavailable("memory", "Inspect or manage memory", "/memory"),
    {
      name: "permission", aliases: ["perm"], description: "Show or change the session Permission Mode",
      usage: "/permission [strict|plan|default|accept-edit|permissive]", argumentHint: "mode",
      destination: "local", allowDuringRun: false,
      async handle(context, args) {
        if (!args) {
          const state = context.permission();
          return {
            kind: "info",
            message: `Base permission: ${state.base}\nEffective permission: ${state.effective}\nSources: ${state.sources.join(", ") || "none"}`,
          };
        }
        const modes = {
          strict: "strict",
          plan: "plan",
          default: "default",
          "accept-edit": "acceptEdit",
          permissive: "permissive",
        } as const;
        if (/\s/u.test(args) || !(args in modes)) return usage("Invalid Permission Mode", "/permission [strict|plan|default|accept-edit|permissive]");
        const mode = modes[args as keyof typeof modes];
        if (mode === "permissive") return await context.confirmPermissive();
        context.setPermission(mode);
        return { kind: "success", message: `Permission Mode changed to ${args} for this session` };
      },
    },
    {
      name: "status", aliases: ["st"], description: "Show the current Nekoder status", usage: "/status",
      destination: "local", allowDuringRun: true,
      async handle(context, args) {
        if (args) return usage("/status does not accept arguments", "/status");
        return { kind: "info", message: context.status() };
      },
    },
    {
      name: "review", aliases: [], description: "Review current uncommitted changes", usage: "/review [scope]",
      argumentHint: "scope", destination: "prompt", allowDuringRun: false,
      async handle(context, args) {
        const escaped = (args || "(none)").replaceAll("</review-scope>", "&lt;/review-scope&gt;");
        const modelText = REVIEW_PROMPT.replace("{{scope}}", escaped);
        const displayText = args ? `/review ${args}` : "/review";
        return await context.startPrompt(modelText, displayText);
      },
    },
  ];
  for (const command of commands) registry.register(command);
  registry.seal();
  return registry;
}

function unavailable(
  name: string,
  description: string,
  commandUsage: string,
  argumentHint?: string
): SlashCommand {
  return {
    name,
    aliases: [],
    description,
    usage: commandUsage,
    ...(argumentHint === undefined ? {} : { argumentHint }),
    destination: "local",
    available: false,
    allowDuringRun: false,
    async handle() {
      return {
        kind: "blocked",
        code: "unavailable",
        message: `/${name} is not available in this version`,
      };
    },
  };
}

function availability(command: SlashCommand, context: SlashCommandContext): string {
  if (command.available === false) return "unavailable";
  if (context.runActive && command.allowDuringRun !== true) return "blocked during active run";
  return "available";
}

function usage(message: string, commandUsage: string): SlashCommandResult {
  return { kind: "usage_error", message, usage: commandUsage };
}
