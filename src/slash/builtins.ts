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
    {
      name: "compact", aliases: [], description: "Compact the current context", usage: "/compact",
      destination: "local", allowDuringRun: false,
      async handle(context, args) {
        if (args) return usage("/compact does not accept arguments", "/compact");
        return context.compact ? await context.compact() : unavailableResult("compact");
      },
    },
    {
      name: "clear", aliases: [], description: "Close this Session and start a clean Session", usage: "/clear",
      destination: "local", allowDuringRun: false,
      async handle(context, args) {
        if (args) return usage("/clear does not accept arguments", "/clear");
        return context.clearSession ? await context.clearSession() : unavailableResult("clear");
      },
    },
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
    {
      name: "session", aliases: [], description: "Manage persistent Sessions",
      usage: "/session [list|resume <id>|new|delete <id>]", argumentHint: "action",
      destination: "local", allowDuringRun: false,
      async handle(context, args) {
        if (!context.session) return unavailableResult("session");
        const parts = words(args);
        if (parts.length === 0) return await context.session({ kind: "current" });
        if (parts.length === 1 && parts[0] === "list") return await context.session({ kind: "list" });
        if (parts.length === 1 && parts[0] === "new") return await context.session({ kind: "new" });
        if (parts.length === 2 && parts[0] === "resume") {
          return await context.session({ kind: "resume", sessionId: parts[1] });
        }
        if (parts.length === 2 && parts[0] === "delete") {
          return await context.session({ kind: "delete", sessionId: parts[1] });
        }
        return usage("Invalid /session arguments", "/session [list|resume <id>|new|delete <id>]");
      },
    },
    {
      name: "memory", aliases: [], description: "Inspect persistent Memory Notes",
      usage: "/memory [list [scope] [type]|show <id>|forget <id>]", argumentHint: "action",
      destination: "local", allowDuringRun: true,
      async handle(context, args) {
        if (!context.memory) return unavailableResult("memory");
        const parts = words(args);
        if (parts.length === 0) return await context.memory({ kind: "status" });
        if (parts[0] === "show" && parts.length === 2) {
          return await context.memory({ kind: "show", memoryId: parts[1] });
        }
        if (parts[0] === "forget" && parts.length === 2) {
          if (context.runActive) return runActiveResult();
          return await context.memory({ kind: "forget", memoryId: parts[1] });
        }
        if (parts[0] === "list" && parts.length <= 3) {
          const scope = parts[1];
          const type = parts[2];
          if (scope !== undefined && scope !== "user" && scope !== "project") {
            return usage("Invalid Memory scope", "/memory list [user|project] [preference|correction|project_knowledge|reference]");
          }
          if (type !== undefined && !["preference", "correction", "project_knowledge", "reference"].includes(type)) {
            return usage("Invalid Memory type", "/memory list [user|project] [preference|correction|project_knowledge|reference]");
          }
          return await context.memory({
            kind: "list",
            ...(scope === undefined ? {} : { scope }),
            ...(type === undefined ? {} : { type: type as "preference" | "correction" | "project_knowledge" | "reference" }),
          });
        }
        return usage("Invalid /memory arguments", "/memory [list [scope] [type]|show <id>|forget <id>]");
      },
    },
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
      name: "skill-install", aliases: [], description: "Install a local or GitHub Agent Skill without running its code",
      usage: "/skill-install <path|github-url> [--project]", argumentHint: "source", destination: "local", allowDuringRun: false,
      async handle(context, args) {
        if (!context.skillInstall) return unavailableResult("skill-install");
        const parts = words(args); const project = parts.at(-1) === "--project"; if (project) parts.pop();
        if (parts.length !== 1) return usage("Invalid /skill-install arguments", "/skill-install <path|github-url> [--project]");
        return context.skillInstall(parts[0]!, project);
      },
    },
    {
      name: "skill-create", aliases: [], description: "Create a strict portable Agent Skill skeleton",
      usage: "/skill-create <name> [description] [--project]", argumentHint: "name", destination: "local", allowDuringRun: false,
      async handle(context, args) {
        if (!context.skillCreate) return unavailableResult("skill-create");
        const parts = words(args); const project = parts.at(-1) === "--project"; if (project) parts.pop();
        if (parts.length < 1) return usage("Invalid /skill-create arguments", "/skill-create <name> [description] [--project]");
        const name = parts.shift()!; return context.skillCreate(name, parts.join(" ") || `Use ${name}`, project);
      },
    },
    {
      name: "status", aliases: ["st"], description: "Show the current Nekoder status", usage: "/status",
      destination: "local", allowDuringRun: true,
      async handle(context, args) {
        if (args) return usage("/status does not accept arguments", "/status");
        return { kind: "info", message: await context.status() };
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

function unavailableResult(name: string): SlashCommandResult {
  return {
    kind: "blocked",
    code: "unavailable",
    message: `/${name} is not available in this runtime`,
  };
}

function runActiveResult(): SlashCommandResult {
  return { kind: "blocked", code: "run_active", message: "An agent run is already active" };
}

function words(args: string): string[] {
  return args.trim() ? args.trim().split(/\s+/u) : [];
}

function availability(command: SlashCommand, context: SlashCommandContext): string {
  if (command.available === false) return "unavailable";
  if (context.runActive && command.allowDuringRun !== true) return "blocked during active run";
  return "available";
}

function usage(message: string, commandUsage: string): SlashCommandResult {
  return { kind: "usage_error", message, usage: commandUsage };
}
