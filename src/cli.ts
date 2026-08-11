import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";

import { AgentSession } from "./agent/session.js";
import { loadConfig, resolveModelLimits, type McpServerConfig } from "./config/config.js";
import { AutomationInbox, ConversationManager } from "./conversation/conversation.js";
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
import { ContextCompactor } from "./continuity/context-compactor.js";
import { InstructionLoader } from "./continuity/instruction-loader.js";
import { MemoryCatalog } from "./continuity/memory-catalog.js";
import { MemoryJobRunner } from "./continuity/memory-job-runner.js";
import { CatalogMemoryOperationWriter, ModelMemoryJobProcessor } from "./continuity/memory-model-adapters.js";
import { SessionJournal } from "./continuity/session-journal.js";
import { TokenCounter } from "./continuity/token-counter.js";
import { ToolArtifactStore } from "./continuity/tool-artifact-store.js";
import { WorkspaceRuntime } from "./continuity/workspace-runtime.js";
import { DefinitionCatalog } from "./extensions/definition-catalog.js";
import { SkillRun } from "./extensions/skill-run.js";
import { HookEngine } from "./extensions/hook-engine.js";
import { DelegatedTaskManager, type DelegatedTaskExecutor } from "./extensions/delegated-task-manager.js";
import { TaskTools } from "./extensions/task-tools.js";
import { WorktreeManager } from "./extensions/worktree-manager.js";
import { HookContentTrustStore, SkillCodeTrustStore } from "./extensions/content-trust.js";
import { SkillInstaller } from "./extensions/skill-installer.js";
import { createBuiltinSlashRegistry } from "./slash/builtins.js";
import type { SlashCommand, SlashRegistry } from "./slash/registry.js";

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
    readonly runtime?: WorkspaceRuntime;
    readonly tasks?: () => readonly import("./extensions/delegated-task-manager.js").DelegatedTask[];
    readonly moveTaskToBackground?: (taskId: string) => void;
    readonly skillInstall?: (source: string, project: boolean) => Promise<string>;
    readonly skillCreate?: (name: string, description: string, project: boolean) => Promise<string>;
    readonly slashRegistry?: SlashRegistry;
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
    runtime: configured.runtime,
    tasks: configured.tasks,
    moveTaskToBackground: configured.moveTaskToBackground,
    skillInstall: configured.skillInstall,
    skillCreate: configured.skillCreate,
    slashRegistry: configured.slashRegistry,
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
  readonly runtime: WorkspaceRuntime;
  readonly tasks: () => readonly import("./extensions/delegated-task-manager.js").DelegatedTask[];
  readonly moveTaskToBackground: (taskId: string) => void;
  readonly skillInstall: (source: string, project: boolean) => Promise<string>;
  readonly skillCreate: (name: string, description: string, project: boolean) => Promise<string>;
  readonly slashRegistry: SlashRegistry;
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
  const conversation = new ConversationManager();
  const automationInbox = new AutomationInbox();
  const journal = new SessionJournal({ root: join(workspace, ".nekoder", "sessions") });
  const definitionCatalog = new DefinitionCatalog({ workspace, homeDir: homedir() });
  let definitions = await definitionCatalog.load();
  const hookTrust = new HookContentTrustStore(homedir());
  let effectiveHooks = await authorizeInitialProjectHooks(workspace, definitions.hooks, hookTrust, io);
  const slashRegistry = createBuiltinSlashRegistry();
  const refreshSkillSlash = (): void => slashRegistry.replaceDynamic(definitions.skills
    .filter((skill) => skill.frontmatter["user-invocable"] !== false)
    .map((skill): SlashCommand => ({
      name: skill.name,
      aliases: skill.runtime.aliases,
      description: `${skill.description} [Skill, ${skill.source.kind}:${skill.source.path}]`,
      usage: `/${skill.name} [arguments]`, argumentHint: "arguments", destination: "prompt", allowDuringRun: false,
      async handle(context, args) {
        const safeArgs = args.replaceAll("</skill-arguments>", "&lt;/skill-arguments&gt;");
        return context.startPrompt(
          `Activate and follow the ${JSON.stringify(skill.name)} Skill using use_skill in ${skill.runtime.modes[0] ?? "inline"} mode.\n<skill-arguments>${safeArgs}</skill-arguments>`,
          args ? `/${skill.name} ${args}` : `/${skill.name}`
        );
      },
    })));
  refreshSkillSlash();
  let skillRun!: SkillRun;
  let runner!: ToolRunner;
  let worktrees!: WorktreeManager;
  let registry!: ToolRegistry;
  let approvalBroker!: ApprovalBroker;
  let taskManager!: DelegatedTaskManager;
  let controller!: SessionController;
  const delegatedExecutor: DelegatedTaskExecutor = async (task, taskContext) => {
    const definition = task.agent ? definitions.agent(task.agent) : definitions.agent("general");
    if (!definition) throw new Error(`Unknown Agent Definition: ${task.agent ?? "general"}`);
    let childWorkspace = workspace;
    let worktreePath: string | undefined;
    let worktreeRegistration: import("./extensions/worktree-manager.js").WorktreeRegistration | undefined;
    if (task.isolation === "worktree") {
      const registration = await worktrees.create({ taskId: task.id, slug: definition.name, signal: taskContext.signal });
      childWorkspace = registration.path;
      worktreePath = registration.path;
      worktreeRegistration = registration;
    }
    const childRegistry = new ToolRegistry();
    const allowed = definition.tools ? new Set(definition.tools) : undefined;
    const denied = new Set([...definition.disallowedTools, "delegate_agent", "task_list", "task_cancel"]);
    for (const { name } of registry.definitions()) {
      if (name === "use_skill" || denied.has(name) || (allowed && !allowed.has(name))) continue;
      const candidate = registry.get(name);
      if (candidate) childRegistry.register(candidate);
    }
    const childSkills = new SkillRun(definitions, {
      registry: childRegistry,
      authorizeCode: (skill) => skillTrust.isTrusted(workspace, skill),
      trustCode: (skill) => skillTrust.trust(workspace, skill),
    });
    childRegistry.register(childSkills.tool());
    for (const tool of new TaskTools(taskManager).child(task.id)) childRegistry.register(tool);
    childRegistry.seal();
    const childConversation = new ConversationManager();
    if (task.kind === "fork" && taskContext.forkHistory) childConversation.replaceMessages(taskContext.forkHistory);
    const childHooks = new HookEngine(effectiveHooks);
    const childInstructions = await new InstructionLoader({ workspace: childWorkspace, homeDir: homedir() }).load();
    const childRunner = new ToolRunner(childRegistry, {
      authorizer: security.policy,
      approvalHandler: {
        requestApproval: (request, decision) => taskContext.waitForApproval(() => approvalBroker.requestApproval(request, decision)),
      },
      maxParallelReads: config.tools.max_parallel_reads,
    });
    const childSession = new AgentSession({
      model, registry: childRegistry, toolRunner: childRunner, conversation: childConversation,
      workspace: childWorkspace, maxSteps: Math.min(config.agent.max_steps, definition.maxSteps),
      skillRun: childSkills, hookEngine: childHooks, agentKind: "subagent",
      promptContext: {
        permissionMode: narrowPermissionMode(security.config.mode, definition.permissionMode),
        customInstructions: definition.instructions,
        ...(taskContext.inheritedSkills ? { skills: taskContext.inheritedSkills } : {}),
        longTermMemory: memory.snapshot().injectionText,
        environment: collectPromptEnvironment(childWorkspace, { model: provider.model, shell: config.tools.run_command?.shell?.kind ?? (process.platform === "win32" ? "powershell" : "sh") }),
      },
      continuity: {
        prepareModelCall: async (messages) => ({
          messages,
          supplementalInstructions: [
            childInstructions.trustedInstructions
              ? `<nekoder-supplement kind="project-instructions">\n${childInstructions.trustedInstructions}\n</nekoder-supplement>`
              : "",
            childInstructions.referenceData,
          ].filter(Boolean),
        }),
      },
    });
    const handle = childSession.startUserRun(task.prompt, "execute");
    taskContext.signal.addEventListener("abort", () => handle.cancel(), { once: true });
    for await (const _event of handle.events) { /* Child events are projected through the task record. */ }
    const outcome = await handle.result;
    if (outcome.status !== "completed") throw new Error(`SubAgent ended with ${outcome.status}`);
    const worktreeDetails = worktreeRegistration ? await worktrees.inspect(worktreeRegistration, taskContext.signal) : undefined;
    const cleanup = worktreeRegistration && worktreeDetails && !worktreeDetails.dirty && worktreeDetails.uniqueCommits === 0
      ? await worktrees.cleanup(worktreeRegistration, taskContext.signal)
      : undefined;
    return { summary: outcome.finalText, usage: outcome.usage as Record<string, number>, ...(worktreePath ? { worktree: worktreePath } : {}), ...(worktreeDetails ? { worktreeDetails } : {}), ...(cleanup ? { worktreeCleanedUp: cleanup.removed } : {}) };
  };
  taskManager = new DelegatedTaskManager({
    executor: delegatedExecutor,
    onTerminal: async (task) => {
      const content = `Task ${task.id} ${task.status}: ${task.result?.summary ?? task.error ?? "no summary"}`;
      if (controller?.getSnapshot().runStatus === "running") automationInbox.add({ origin: "task", id: task.id, content });
      else conversation.addAutomationMessage("task", task.id, content);
      const current = await journal.current();
      if (current) {
        await journal.append({ type: "delegated_task", task });
        if (controller?.getSnapshot().runStatus !== "running") {
          await journal.append({ type: "message", role: "user", content: `<nekoder-automation origin="task" id=${JSON.stringify(task.id)} authority="data">\n${content}\n</nekoder-automation>` });
        }
      }
    },
  });
  const hookEngine = new HookEngine(effectiveHooks, {
    createTask: async ({ agent, task }) => (await taskManager.create({ caller: "trusted_root_hook", kind: "defined", agent, prompt: task, mode: "background" })).id,
  });
  registry = new ToolRegistry();
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
  const skillTrust = new SkillCodeTrustStore(homedir());
  skillRun = new SkillRun(definitions, {
    registry,
    authorizeCode: (definition) => skillTrust.isTrusted(workspace, definition),
    trustCode: (definition) => skillTrust.trust(workspace, definition),
    delegate: async ({ definition, argumentsText }) => {
      const task = await taskManager.create({
        caller: "root", kind: "defined", agent: "general", mode: "background", isolation: "shared",
        prompt: `${definition.instructions}\n\nSkill arguments:\n${argumentsText}`,
      });
      return { taskId: task.id };
    },
  });
  registry.register(skillRun.tool());
  for (const tool of new TaskTools(taskManager, {
    forkHistoryProvider: () => conversation.getMessages(),
    inheritedSkillsProvider: () => skillRun.supplementalInstructions(),
    resolveIsolation: (agent, requested, kind) => {
      if (kind === "fork") return requested ?? "shared";
      const definition = definitions.agent(agent ?? "general");
      if (!definition) throw new Error(`Unknown Agent Definition: ${agent ?? "general"}`);
      const isolation = requested ?? definition.isolation[0] ?? "shared";
      if (!definition.isolation.includes(isolation)) throw new Error(`Agent ${definition.name} does not allow ${isolation} isolation`);
      return isolation;
    },
  }).root()) registry.register(tool);
  registry.seal();
  approvalBroker = new ApprovalBroker();
  const shell = config.tools.run_command?.shell?.kind
    ?? (process.platform === "win32" ? "powershell" : "sh");
  const environment = () => collectPromptEnvironment(workspace, {
    model: provider.model,
    shell,
  });
  runner = new ToolRunner(registry, {
    authorizer: security.policy,
    approvalHandler: approvalBroker,
    persistentRuleWriter: new PermissionRuleFileStore(workspace),
    maxParallelReads: config.tools.max_parallel_reads,
    deferOutputBudget: true,
  });
  const commandExecutor: import("./extensions/worktree-manager.js").WorktreeCommandExecutor = {
      async execute(request) {
        const result = await runner.runBatch(
          [{ toolCallId: crypto.randomUUID(), toolName: "run_command", input: { command: request.command, cwd: request.cwd } }],
          { toolBatchId: crypto.randomUUID(), workspace, taskMode: "execute", ...(request.signal ? { signal: request.signal } : {}) }
        );
        const output = result.results[0]?.result;
        if (!output?.ok) return { code: 1, stdout: "", stderr: output?.error.message ?? "run_command failed" };
        const data = output.data as { exitCode?: number; stdout?: string; stderr?: string };
        return { code: data.exitCode ?? 0, stdout: data.stdout ?? "", stderr: data.stderr ?? "" };
      },
  };
  worktrees = new WorktreeManager({ workspace, commandExecutor });
  const skillInstaller = new SkillInstaller({ workspace, homeDir: homedir(), commandExecutor });
  const memory = await MemoryCatalog.open({ workspace, homeDir: homedir() });
  const memoryJobs = await MemoryJobRunner.open({
    workspace,
    homeDir: homedir(),
    processor: new ModelMemoryJobProcessor(model),
    writer: new CatalogMemoryOperationWriter(workspace, homedir(), memory),
  });
  const instructions = new InstructionLoader({ workspace, homeDir: homedir() });
  const artifacts = new ToolArtifactStore(workspace);
  const counter = new TokenCounter({ contextWindow: limits.contextWindow });
  const compactor = new ContextCompactor({
    conversation,
    model,
    counter,
    tools: () => registry.definitions(),
    onCompacted: async (result) => {
      const current = await journal.current();
      if (!current) return;
      const lastSeq = Math.max(...current.events.map(({ seq }) => seq));
      await journal.append({
        type: "compacted",
        coveredThroughSeq: lastSeq,
        retainedFromSeq: Math.max(1, lastSeq - result.preservedUnits * 2),
        summary: result.summary,
        interactionCount: result.interactionCount,
        beforeTokens: result.before.requiredTokens,
        afterTokens: result.after.requiredTokens,
      });
    },
  });
  let runtime!: WorkspaceRuntime;
  const session = new AgentSession({
    model,
    registry,
    toolRunner: runner,
    conversation,
    workspace,
    maxSteps: config.agent.max_steps,
    skillRun,
    hookEngine,
    agentKind: "root",
    automationInbox,
    promptContext: {
      permissionMode: security.config.mode,
      ...(config.prompt.custom_instructions
        ? { customInstructions: config.prompt.custom_instructions }
        : {}),
      environment: environment(),
      environmentProvider: environment,
    },
    continuity: {
      prepareModelCall: (messages) => runtime.continuityHooks().prepareModelCall(messages),
      prepareToolResults: (results) => runtime.continuityHooks().prepareToolResults!(results),
      scheduleMemoryUpdate: (outcome) => runtime.continuityHooks().scheduleMemoryUpdate?.(outcome),
    },
  });
  controller = new SessionController(
    session,
    approvalBroker,
    security.config.mode,
    (mode) => security.policy.setMode(mode)
  );
  runtime = new WorkspaceRuntime({
    controller,
    conversation,
    journal,
    memory,
    instructions,
    compactor,
    artifacts,
    memoryJobs,
    prepareRun: async () => {
      const next = await definitionCatalog.load();
      definitions = next;
      effectiveHooks = await trustedHooks(workspace, next.hooks, hookTrust);
      refreshSkillSlash();
      skillRun.reload(next);
      hookEngine.reload(effectiveHooks);
    },
  });
  await runtime.initialize();
  for (const event of (await journal.current())?.events ?? []) {
    if (event.type === "delegated_task") taskManager.restoreTerminal(event.task);
  }
  const mcpDiagnostics = mcpManager.diagnostics();
  const connectedMcp = mcpDiagnostics.filter(({ status }) => status === "connected").length;
  const unavailableMcp = mcpDiagnostics.length - connectedMcp;
  return {
    controller,
    runtime,
    tasks: () => taskManager.list(),
    moveTaskToBackground: (taskId) => { taskManager.moveToBackground(taskId); },
    skillInstall: async (source, project) => {
      const installed = await skillInstaller.install(source, { project });
      return `Installed Skills: ${installed.map(({ name }) => name).join(", ")}`;
    },
    skillCreate: async (name, description, project) => `Created Skill: ${await skillInstaller.create(name, description, { project })}`,
    slashRegistry,
    toolNames: registry.definitions().map(({ name }) => name),
    permissionSources: Object.entries(security.config.rules)
      .filter(([, rules]) => rules.length > 0)
      .map(([source]) => source),
    mcpDiagnostics: () => mcpManager.diagnostics(),
    initialMessages: mcpDiagnostics.length === 0
      ? []
      : [`MCP startup: ${connectedMcp} connected, ${unavailableMcp} unavailable or skipped. Use /status for details.`],
    dispose: async () => {
      await taskManager.shutdown();
      await mcpManager.close();
    },
  };
}

function narrowPermissionMode(
  root: import("./security/types.js").PermissionMode,
  requested: import("./extensions/definition-catalog.js").AgentDefinition["permissionMode"]
): import("./security/types.js").PermissionMode {
  if (requested === "inherit") return root;
  if (root === "strict" || root === "plan") return root;
  const rank: Record<import("./security/types.js").PermissionMode, number> = {
    strict: 0, plan: 0, default: 1, acceptEdit: 2, permissive: 3,
  };
  return rank[requested] <= rank[root] ? requested : root;
}

async function trustedHooks(
  workspace: string,
  hooks: readonly import("./extensions/hook-engine.js").HookRule[],
  store: HookContentTrustStore
): Promise<readonly import("./extensions/hook-engine.js").HookRule[]> {
  return Promise.all(hooks.map(async (hook) => Object.freeze({
    ...hook,
    trusted: hook.trusted === true || await store.isTrusted(workspace, hook),
  })));
}

async function authorizeInitialProjectHooks(
  workspace: string,
  hooks: readonly import("./extensions/hook-engine.js").HookRule[],
  store: HookContentTrustStore,
  io: { readonly stdin: NodeJS.ReadStream; readonly stdout: NodeJS.WriteStream }
): Promise<readonly import("./extensions/hook-engine.js").HookRule[]> {
  const pending = hooks.filter((hook) => hook.source === "project" && !("deny" in hook.action) && hook.trusted !== true);
  if (pending.length === 0) return trustedHooks(workspace, hooks, store);
  const readline = createInterface({ input: io.stdin, output: io.stdout });
  try {
    for (const hook of pending) {
      if (await store.isTrusted(workspace, hook)) continue;
      const answer = await readline.question(`Project Hook ${hook.id} (${hook.path}) can inject automation content or create a SubAgent. Trust content ${hook.contentHash?.slice(0, 12)}? [y/N] `);
      if (/^(?:y|yes)$/iu.test(answer.trim())) await store.trust(workspace, hook);
    }
  } finally {
    readline.close();
  }
  return trustedHooks(workspace, hooks, store);
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
