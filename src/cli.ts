import { AgentSession } from "./agent/session.js";
import { ModeToolAuthorizer } from "./agent/mode-authorizer.js";
import { loadConfig, resolveModelLimits } from "./config/config.js";
import { ConversationManager } from "./conversation/conversation.js";
import { LLMClient } from "./llm/client.js";
import { createCoreToolRegistry } from "./tools/core.js";
import { ToolRunner } from "./tools/runner.js";
import { ApprovalBroker } from "./tui/approval-broker.js";
import { createDemoApplication } from "./tui/demo.js";
import { SessionController } from "./tui/session-controller.js";
import { startTui } from "./tui/start.js";
import { sanitizeTerminalText } from "./tui/terminal-text.js";

export interface CliOptions {
  readonly demo: boolean;
  readonly debug: boolean;
  readonly plainIcons: boolean;
  readonly reduceMotion: boolean;
  readonly help: boolean;
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  const options = {
    demo: false,
    debug: false,
    plainIcons: false,
    reduceMotion: false,
    help: false,
  };
  for (const arg of args) {
    if (arg === "--demo") options.demo = true;
    else if (arg === "--debug") options.debug = true;
    else if (arg === "--plain-icons") options.plainIcons = true;
    else if (arg === "--reduce-motion") options.reduceMotion = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

const HELP = `Nekoder TUI\n\nUsage: bun run src/index.tsx [options]\n\n  --demo           Run without an API key\n  --debug          Show in-memory UI diagnostics\n  --plain-icons    Do not require Nerd Font glyphs\n  --reduce-motion  Disable non-essential animation\n  -h, --help       Show this help\n`;

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  io: {
    readonly stdin: NodeJS.ReadStream;
    readonly stdout: NodeJS.WriteStream;
    readonly stderr: NodeJS.WriteStream;
  } = process
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliOptions(args);
  } catch (error) {
    io.stderr.write(`${sanitizeTerminalText(String(error))}\n`);
    return 2;
  }
  if (options.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    io.stderr.write("Nekoder TUI requires an interactive terminal.\n");
    return 2;
  }

  const workspace = process.cwd();
  let controller: SessionController;
  try {
    controller = options.demo
      ? createDemoApplication(workspace).controller
      : await createConfiguredController(workspace);
  } catch (error) {
    io.stderr.write(`Unable to initialize Nekoder: ${sanitizeTerminalText(String(error))}\n`);
    return 1;
  }

  const app = startTui({
    ...io,
    workspace,
    taskMode: "execute",
    controller,
    debug: options.debug,
    plainIcons: options.plainIcons,
    reduceMotion: options.reduceMotion,
  });
  const stop = (): void => { void app.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await app.ready;
    await app.waitUntilExit();
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function createConfiguredController(workspace: string): Promise<SessionController> {
  const config = loadConfig(workspace);
  const provider = config.providers[0];
  if (!provider) throw new Error("No model provider is configured");
  const limits = await resolveModelLimits(provider);
  const model = new LLMClient(
    provider,
    "You are Nekoder, a terminal coding agent. Never reveal hidden reasoning.",
    limits
  );
  const registry = createCoreToolRegistry({
    skipDirs: config.tools.skip_dirs,
    ...(config.tools.run_command ? {
      runCommand: {
        ...(config.tools.run_command.env_passthrough
          ? { envPassthrough: config.tools.run_command.env_passthrough }
          : {}),
        ...(config.tools.run_command.shell
          ? { shell: config.tools.run_command.shell }
          : {}),
      },
    } : {}),
  });
  const approvalBroker = new ApprovalBroker();
  const runner = new ToolRunner(registry, {
    authorizer: new ModeToolAuthorizer(),
    approvalHandler: approvalBroker,
    maxParallelReads: config.tools.max_parallel_reads,
  });
  const session = new AgentSession({
    model,
    registry,
    toolRunner: runner,
    conversation: new ConversationManager(),
    workspace,
    maxSteps: config.agent.max_steps,
  });
  return new SessionController(session, approvalBroker);
}
