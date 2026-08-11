import { homedir } from "node:os";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";

import { AgentSession } from "./agent/session.js";
import { loadConfig, resolveModelLimits, type McpServerConfig } from "./config/config.js";
import { ConversationManager } from "./conversation/conversation.js";
import { LLMClient } from "./llm/client.js";
import { buildStableSystemPrompt } from "./prompt/assembler.js";
import { collectPromptEnvironment } from "./prompt/environment.js";
import { loadWorkspaceSecurity } from "./security/runtime.js";
import { PermissionRuleFileStore } from "./security/permission-store.js";
import { registerCoreTools } from "./tools/core.js";
import { ToolRegistry } from "./tools/registry.js";
import { ToolRunner } from "./tools/runner.js";
import { McpManager, type McpTrustController } from "./mcp/manager.js";
import { SdkMcpConnector } from "./mcp/sdk-connector.js";
import { McpTrustStore } from "./mcp/trust.js";
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
  let configured: {
    readonly controller: SessionController;
    readonly toolNames?: readonly string[];
    readonly permissionSources?: readonly string[];
    readonly mcpDiagnostics?: () => ReturnType<McpManager["diagnostics"]>;
    readonly initialMessages?: readonly string[];
    dispose(): Promise<void>;
  };
  try {
    if (options.demo) {
      const demo = createDemoApplication(workspace);
      configured = { controller: demo.controller, async dispose() {} };
    } else {
      configured = await createConfiguredApplication(workspace, io);
    }
  } catch (error) {
    io.stderr.write(`Unable to initialize Nekoder: ${sanitizeTerminalText(String(error))}\n`);
    return 1;
  }

  const app = startTui({
    ...io,
    workspace,
    taskMode: "execute",
    controller: configured.controller,
    debug: options.debug,
    plainIcons: options.plainIcons,
    reduceMotion: options.reduceMotion,
    onDispose: () => configured.dispose(),
    toolNames: configured.toolNames,
    permissionSources: configured.permissionSources,
    mcpDiagnostics: configured.mcpDiagnostics,
    initialMessages: configured.initialMessages,
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

async function createConfiguredApplication(
  workspace: string,
  io: { readonly stdin: NodeJS.ReadStream; readonly stdout: NodeJS.WriteStream }
): Promise<{
  readonly controller: SessionController;
  readonly toolNames: readonly string[];
  readonly permissionSources: readonly string[];
  readonly mcpDiagnostics: () => ReturnType<McpManager["diagnostics"]>;
  readonly initialMessages: readonly string[];
  dispose(): Promise<void>;
}> {
  const config = loadConfig(workspace);
  const security = loadWorkspaceSecurity(workspace);
  const provider = config.providers[0];
  if (!provider) throw new Error("No model provider is configured");
  const limits = await resolveModelLimits(provider);
  const model = new LLMClient(
    provider,
    buildStableSystemPrompt(),
    limits
  );
  const registry = new ToolRegistry();
  registerCoreTools(registry, {
    skipDirs: config.tools.skip_dirs,
    sensitiveReads: security.config.sensitiveReads,
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
  const mcpManager = new McpManager(new SdkMcpConnector());
  const trustStore = new McpTrustStore({ homeDir: homedir() });
  let readline: ReadlineInterface | undefined;
  const trust: McpTrustController = {
    isTrusted: (root, server, serverConfig) => trustStore.isTrusted(root, server, serverConfig),
    async requestTrust(request) {
      readline ??= createInterface({ input: io.stdin, output: io.stdout });
      const answer = await readline.question(formatMcpTrustPrompt(request.server, request.config));
      return /^(?:y|yes)$/i.test(answer.trim());
    },
    trust: (root, server, serverConfig) => trustStore.trust(root, server, serverConfig),
  };
  try {
    await mcpManager.start(config.mcp_servers, registry, { workspace, trust });
  } finally {
    readline?.close();
  }
  registry.seal();
  const approvalBroker = new ApprovalBroker();
  const shell = config.tools.run_command?.shell?.kind
    ?? (process.platform === "win32" ? "powershell" : "sh");
  const environment = () => collectPromptEnvironment(workspace, {
    model: provider.model,
    shell,
  });
  const runner = new ToolRunner(registry, {
    authorizer: security.policy,
    approvalHandler: approvalBroker,
    persistentRuleWriter: new PermissionRuleFileStore(workspace),
    maxParallelReads: config.tools.max_parallel_reads,
  });
  const session = new AgentSession({
    model,
    registry,
    toolRunner: runner,
    conversation: new ConversationManager(),
    workspace,
    maxSteps: config.agent.max_steps,
    promptContext: {
      permissionMode: security.config.mode,
      ...(config.prompt.custom_instructions
        ? { customInstructions: config.prompt.custom_instructions }
        : {}),
      environment: environment(),
      environmentProvider: environment,
    },
  });
  const controller = new SessionController(
    session,
    approvalBroker,
    security.config.mode,
    (mode) => security.policy.setMode(mode)
  );
  const mcpDiagnostics = mcpManager.diagnostics();
  const connectedMcp = mcpDiagnostics.filter(({ status }) => status === "connected").length;
  const unavailableMcp = mcpDiagnostics.length - connectedMcp;
  return {
    controller,
    toolNames: registry.definitions().map(({ name }) => name),
    permissionSources: Object.entries(security.config.rules)
      .filter(([, rules]) => rules.length > 0)
      .map(([source]) => source),
    mcpDiagnostics: () => mcpManager.diagnostics(),
    initialMessages: mcpDiagnostics.length === 0
      ? []
      : [`MCP startup: ${connectedMcp} connected, ${unavailableMcp} unavailable or skipped. Use /status for details.`],
    dispose: () => mcpManager.close(),
  };
}

function formatMcpTrustPrompt(
  server: string,
  config: Exclude<McpServerConfig, { readonly enabled: false }>
): string {
  const referencedVariables = new Set<string>();
  const values = config.transport === "stdio"
    ? Object.values(config.env ?? {})
    : Object.values(config.headers ?? {});
  for (const value of values) {
    for (const match of value.matchAll(/(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      referencedVariables.add(match[1]!);
    }
  }
  const target = config.transport === "stdio"
    ? [config.command, ...(config.args ?? [])].join(" ")
    : redactedHttpTarget(config.url);
  const headerNames = config.transport === "http" ? Object.keys(config.headers ?? {}) : [];
  return [
    `Workspace MCP Server '${server}' requests trust.`,
    `Transport: ${config.transport}; target: ${target}`,
    referencedVariables.size > 0 ? `Environment variables: ${[...referencedVariables].sort().join(", ")}` : undefined,
    headerNames.length > 0 ? `HTTP headers: ${headerNames.sort().join(", ")}` : undefined,
    config.transport === "stdio"
      ? "This command runs with your user permissions and is not OS-sandboxed."
      : "The remote Server receives the explicitly configured headers.",
    "Trust this exact Workspace configuration? [y/N] ",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function redactedHttpTarget(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}
