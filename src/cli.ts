import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";

import { AgentSession } from "./agent/session.js";
import { loadConfig, resolveModelLimits, type McpServerConfig, type ProviderConfig } from "./config/config.js";
import { AutomationInbox, ConversationManager } from "./conversation/conversation.js";
import { LLMClient } from "./llm/client.js";
import { JsonlModelIoHook, withModelIoHook } from "./llm/model-io-hook.js";
import { buildStableSystemPrompt } from "./prompt/assembler.js";
import { collectPromptEnvironment } from "./prompt/environment.js";
import { loadWorkspaceSecurity } from "./security/runtime.js";
import { SecurityPolicy } from "./security/policy.js";
import { PermissionRuleFileStore } from "./security/permission-store.js";
import { registerCoreTools } from "./tools/core.js";
import { createRunCommandTool } from "./tools/run-command.js";
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
import { inheritParentToolsForSubagent, TaskTools } from "./extensions/task-tools.js";
import { WorktreeManager } from "./extensions/worktree-manager.js";
import { SkillCodeTrustStore } from "./extensions/content-trust.js";
import { SkillInstaller, type SkillInstallCandidate } from "./extensions/skill-installer.js";
import { grantedSecretEnvironment, requestTaskSecretGrants } from "./extensions/task-secret-grant.js";
import { createBuiltinSlashRegistry } from "./slash/builtins.js";
import type { ProviderSlashAction, SlashCommand, SlashCommandResult, SlashRegistry } from "./slash/registry.js";
import type { ModelInvoker } from "./model/types.js";

export interface CliOptions {
  readonly demo: boolean;
  readonly debug: boolean;
  readonly plainIcons: boolean;
  readonly reduceMotion: boolean;
  readonly help: boolean;
  readonly workspace?: string;
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  const options: {
    demo: boolean;
    debug: boolean;
    plainIcons: boolean;
    reduceMotion: boolean;
    help: boolean;
    workspace?: string;
  } = {
    demo: false,
    debug: false,
    plainIcons: false,
    reduceMotion: false,
    help: false,
  };
  const setWorkspace = (value: string, flag: string): void => {
    if (value === "") throw new Error(`Missing value for option: ${flag}`);
    options.workspace = value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--demo") options.demo = true;
    else if (arg === "--debug") options.debug = true;
    else if (arg === "--plain-icons") options.plainIcons = true;
    else if (arg === "--reduce-motion") options.reduceMotion = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--workspace" || arg === "--cwd" || arg === "-C") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`Missing value for option: ${arg}`);
      setWorkspace(value, arg);
      index += 1;
    } else if (arg.startsWith("--workspace=")) setWorkspace(arg.slice("--workspace=".length), "--workspace");
    else if (arg.startsWith("--cwd=")) setWorkspace(arg.slice("--cwd=".length), "--cwd");
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

const HELP = `Nekoder TUI\n\nUsage: bun run src/index.tsx [options]\n\n  --workspace <dir>  Set the workspace root (default: current directory)\n  --cwd <dir>, -C    Alias for --workspace\n  --demo             Run without an API key\n  --debug            Show in-memory UI diagnostics\n  --plain-icons      Do not require Nerd Font glyphs\n  --reduce-motion    Disable non-essential animation\n  -h, --help         Show this help\n`;

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

  let workspace: string;
  try {
    workspace = resolveWorkspace(options.workspace);
  } catch (error) {
    io.stderr.write(`${sanitizeTerminalText(String(error))}\n`);
    return 2;
  }
  let configured: {
    readonly controller: SessionController;
    readonly model?: string;
    readonly currentModel?: () => string;
    readonly contextUsage?: () => { readonly used: number; readonly total: number };
    readonly provider?: (action: ProviderSlashAction) => Promise<SlashCommandResult>;
    readonly toolNames?: readonly string[];
    readonly permissionSources?: readonly string[];
    readonly mcpDiagnostics?: () => ReturnType<McpManager["diagnostics"]>;
    readonly initialMessages?: readonly string[];
    readonly runtime?: WorkspaceRuntime;
    readonly tasks?: () => readonly import("./extensions/delegated-task-manager.js").DelegatedTask[];
    readonly moveTaskToBackground?: (taskId: string) => void;
    readonly skillInstall?: (source: string, project: boolean, select?: (candidates: readonly SkillInstallCandidate[]) => Promise<readonly string[]>) => Promise<string>;
    readonly skillCreate?: (name: string, description: string, project: boolean) => Promise<string>;
    readonly slashRegistry?: SlashRegistry;
    dispose(): Promise<void>;
  };
  try {
    if (options.demo) {
      const demo = createDemoApplication(workspace);
      configured = { controller: demo.controller, model: "demo", async dispose() {} };
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
    model: configured.model,
    currentModel: configured.currentModel,
    contextUsage: configured.contextUsage,
    provider: configured.provider,
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
  readonly model: string;
  readonly currentModel: () => string;
  readonly contextUsage: () => { readonly used: number; readonly total: number };
  readonly provider: (action: ProviderSlashAction) => Promise<SlashCommandResult>;
  readonly toolNames: readonly string[];
  readonly permissionSources: readonly string[];
  readonly mcpDiagnostics: () => ReturnType<McpManager["diagnostics"]>;
  readonly initialMessages: readonly string[];
  readonly runtime: WorkspaceRuntime;
  readonly tasks: () => readonly import("./extensions/delegated-task-manager.js").DelegatedTask[];
  readonly moveTaskToBackground: (taskId: string) => void;
  readonly skillInstall: (source: string, project: boolean, select?: (candidates: readonly SkillInstallCandidate[]) => Promise<readonly string[]>) => Promise<string>;
  readonly skillCreate: (name: string, description: string, project: boolean) => Promise<string>;
  readonly slashRegistry: SlashRegistry;
  dispose(): Promise<void>;
}> {
  const config = loadConfig(workspace);
  const security = loadWorkspaceSecurity(workspace);
  let activeProvider = config.providers[0];
  if (!activeProvider) throw new Error("No model provider is configured");
  const initialLimits = await resolveModelLimits(activeProvider);
  const stableSystemPrompt = buildStableSystemPrompt();
  const configuredLogPath = config.llm_io_hook?.path ?? join(".nekoder", "logs", "llm-io.jsonl");
  const modelIoHook = config.llm_io_hook?.enabled
    ? new JsonlModelIoHook({
        file: isAbsolute(configuredLogPath) ? configuredLogPath : resolve(workspace, configuredLogPath),
        stableSystemPrompt,
      })
    : undefined;
  const createModel = (provider: ProviderConfig, limits: Awaited<ReturnType<typeof resolveModelLimits>>): ModelInvoker => {
    const client = new LLMClient(provider, stableSystemPrompt, limits);
    return modelIoHook ? withModelIoHook(client, modelIoHook) : client;
  };
  let activeModel = createModel(activeProvider, initialLimits);
  const model: ModelInvoker = {
    collect: (request) => activeModel.collect(request),
  };
  const conversation = new ConversationManager();
  const automationInbox = new AutomationInbox();
  const journal = new SessionJournal({ root: join(workspace, ".nekoder", "sessions") });
  const definitionCatalog = new DefinitionCatalog({ workspace, homeDir: homedir() });
  let definitions = await definitionCatalog.load();
  let effectiveHooks = definitions.hooks;
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
    const grantedSecrets = new Set<string>();
    const requestSecrets = async (names: readonly string[]): Promise<readonly string[]> => {
      const undeclared = names.find((name) => !definition.secrets.includes(name));
      if (undeclared) throw new Error(`Task Secret was not declared by Agent ${definition.name}: ${undeclared}`);
      const pending = names.filter((name) => !grantedSecrets.has(name));
      const granted = await requestTaskSecretGrants({
        taskId: task.id, names: pending, workspace, signal: taskContext.signal,
        requestApproval: (request, decision) => taskContext.waitForApproval(() => approvalBroker.requestApproval(request, decision)),
      });
      for (const name of granted) grantedSecrets.add(name);
      return Object.freeze([...grantedSecrets]);
    };
    let childWorkspace = workspace;
    let worktreePath: string | undefined;
    let worktreeRegistration: import("./extensions/worktree-manager.js").WorktreeRegistration | undefined;
    if (task.isolation === "worktree") {
      const registration = await worktrees.create({ taskId: task.id, slug: definition.name, signal: taskContext.signal, waitForApproval: taskContext.waitForApproval });
      childWorkspace = registration.path;
      worktreePath = registration.path;
      worktreeRegistration = registration;
    }
    const childRegistry = new ToolRegistry();
    const allowed = definition.tools ? new Set(definition.tools) : undefined;
    const denied = new Set([...definition.disallowedTools, "delegate_agent", "task_list", "task_cancel"]);
    inheritParentToolsForSubagent(registry, childRegistry, { kind: task.kind, allowed, denied });
    if ((!allowed || allowed.has("run_command")) && !denied.has("run_command")) childRegistry.register(createRunCommandTool({
      envPassthroughProvider: () => [...grantedSecrets],
      ...(config.tools.run_command?.shell ? { shell: config.tools.run_command.shell } : {}),
    }));
    const childSkills = new SkillRun(definitions, {
      registry: childRegistry,
      authorizeCode: (skill) => skillTrust.isTrusted(workspace, skill),
      trustCode: (skill) => skillTrust.trust(workspace, skill),
      workerEnvironment: async () => grantedSecretEnvironment([...grantedSecrets]),
    });
    childRegistry.register(childSkills.tool());
    for (const tool of new TaskTools(taskManager, { requestSecrets }).child(task.id)) childRegistry.register(tool);
    childRegistry.seal();
    const childConversation = new ConversationManager();
    if (task.kind === "fork" && taskContext.forkHistory) childConversation.replaceMessages(taskContext.forkHistory);
    const childHooks = new HookEngine(effectiveHooks);
    const childInstructions = await new InstructionLoader({ workspace: childWorkspace, homeDir: homedir() }).load();
    const childPermissionMode = narrowPermissionMode(security.policy.getMode(), definition.permissionMode);
    const childRunner = new ToolRunner(childRegistry, {
      authorizer: new SecurityPolicy({ mode: childPermissionMode, rules: security.config.rules }),
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
        permissionMode: childPermissionMode,
        customInstructions: `${definition.instructions}${definition.secrets.length ? `\n\nAvailable Task Secret names: ${definition.secrets.join(", ")}. Request only those needed through task_update.request_secrets; values are never visible to you and become available only inside approved host execution.` : ""}`,
        ...(taskContext.inheritedSkills ? { skills: taskContext.inheritedSkills } : {}),
        longTermMemory: memory.snapshot().injectionText,
        environment: collectPromptEnvironment(childWorkspace, { model: activeProvider.model, shell: config.tools.run_command?.shell?.kind ?? (process.platform === "win32" ? "powershell" : "sh") }),
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
    const worktreeDetails = worktreeRegistration ? await worktrees.inspect(worktreeRegistration, taskContext.signal, taskContext.waitForApproval) : undefined;
    const cleanup = worktreeRegistration && worktreeDetails && !worktreeDetails.dirty && worktreeDetails.uniqueCommits === 0
      ? await worktrees.cleanup(worktreeRegistration, taskContext.signal, taskContext.waitForApproval)
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
    createTask: async ({ agent, task }) => (await taskManager.create({ caller: "hook", kind: "defined", agent, prompt: task, mode: "background" })).id,
  });
  const dispatchLifecycleHook = async (event: import("./extensions/hook-engine.js").HookEvent): Promise<void> => {
    const result = await hookEngine.handle(event);
    for (const message of result.messages) automationInbox.add({ origin: "hook", id: message.hookId, content: message.content });
    for (const diagnostic of result.diagnostics) {
      automationInbox.add({ origin: "hook", id: diagnostic.hookId, content: `Hook diagnostic (${diagnostic.code}): ${diagnostic.message}` });
    }
  };
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
  const rootTaskTools = (): readonly import("./tools/types.js").AnyTool[] => new TaskTools(taskManager, {
    forkHistoryProvider: () => conversation.getMessages(),
    inheritedSkillsProvider: () => skillRun.supplementalInstructions(),
    agentDefinitions: definitions.agents,
    resolveIsolation: (agent, requested, kind) => {
      if (kind === "fork") return requested ?? "shared";
      const definition = definitions.agent(agent ?? "general");
      if (!definition) throw new Error(`Unknown Agent Definition: ${agent ?? "general"}`);
      const isolation = requested ?? definition.isolation[0] ?? "shared";
      if (!definition.isolation.includes(isolation)) throw new Error(`Agent ${definition.name} does not allow ${isolation} isolation`);
      return isolation;
    },
  }).root();
  registry.seal();
  registry.registerDynamic("root-task-tools", rootTaskTools());
  approvalBroker = new ApprovalBroker();
  const shell = config.tools.run_command?.shell?.kind
    ?? (process.platform === "win32" ? "powershell" : "sh");
  const environment = () => collectPromptEnvironment(workspace, {
    model: activeProvider.model,
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
        const commandRunner = request.waitForApproval ? new ToolRunner(registry, {
          authorizer: security.policy,
          approvalHandler: { requestApproval: (approvalRequest, decision) => request.waitForApproval!(() => approvalBroker.requestApproval(approvalRequest, decision)) },
          maxParallelReads: config.tools.max_parallel_reads,
          deferOutputBudget: true,
        }) : runner;
        const result = await commandRunner.runBatch(
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
  let activeCounter = new TokenCounter({ contextWindow: initialLimits.contextWindow });
  const counter = {
    budget: (input: Parameters<TokenCounter["budget"]>[0]) => activeCounter.budget(input),
  };
  const compactor = new ContextCompactor({
    conversation,
    model,
    counter,
    tools: () => registry.definitions(),
    onCompacted: async (result, manual) => {
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
      await dispatchLifecycleHook({
        type: "context_compact",
        session: { id: current.projection.id },
        compaction: {
          manual,
          outcome: "compacted",
          before_tokens: result.before.requiredTokens,
          after_tokens: result.after.requiredTokens,
        },
      });
    },
    onError: async (error) => {
      const current = await journal.current();
      await dispatchLifecycleHook({
        type: "system_error",
        ...(current ? { session: { id: current.projection.id } } : {}),
        error: { source: "context_compact", message: error.message, code: error.code },
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
    onLifecycle: dispatchLifecycleHook,
    prepareRun: async () => {
      const next = await definitionCatalog.load();
      definitions = next;
      effectiveHooks = next.hooks;
      refreshSkillSlash();
      skillRun.reload(next);
      hookEngine.reload(effectiveHooks);
      registry.registerDynamic("root-task-tools", rootTaskTools());
    },
  });
  await dispatchLifecycleHook({ type: "system_start", system: { workspace } });
  await runtime.initialize();
  for (const event of (await journal.current())?.events ?? []) {
    if (event.type === "delegated_task") taskManager.restoreTerminal(event.task);
  }
  const mcpDiagnostics = mcpManager.diagnostics();
  const connectedMcp = mcpDiagnostics.filter(({ status }) => status === "connected").length;
  const unavailableMcp = mcpDiagnostics.length - connectedMcp;
  const providerCommand = async (action: ProviderSlashAction): Promise<SlashCommandResult> => {
    if (action.kind === "list") {
      return {
        kind: "info",
        message: config.providers.map((item) =>
          `${item === activeProvider ? "*" : " "} ${item.name} · ${item.protocol} · ${item.model}`
        ).join("\n"),
      };
    }
    const delegatedRunActive = taskManager.list().some(({ status }) =>
      !["completed", "failed", "cancelled", "interrupted"].includes(status)
    );
    if (delegatedRunActive) {
      return {
        kind: "blocked",
        code: "run_active",
        message: "Cannot switch Provider while a delegated Agent task is active",
      };
    }
    const nextProvider = config.providers.find(({ name }) => name === action.name);
    if (!nextProvider) {
      return {
        kind: "blocked",
        code: "not_found",
        message: `Unknown Provider: ${action.name}. Configured Providers: ${config.providers.map(({ name }) => name).join(", ")}`,
      };
    }
    if (nextProvider === activeProvider) {
      return { kind: "success", message: `Provider ${nextProvider.name} is already active (${nextProvider.model})` };
    }
    try {
      const nextLimits = await resolveModelLimits(nextProvider);
      const nextModel = createModel(nextProvider, nextLimits);
      activeProvider = nextProvider;
      activeModel = nextModel;
      activeCounter = new TokenCounter({ contextWindow: nextLimits.contextWindow });
      return { kind: "success", message: `Switched Provider to ${nextProvider.name} (${nextProvider.model}) for this process` };
    } catch (error) {
      return {
        kind: "blocked",
        code: "operation_failed",
        message: `Unable to switch Provider to ${nextProvider.name}: ${String(error)}`,
      };
    }
  };
  return {
    controller,
    model: activeProvider.model,
    currentModel: () => activeProvider.model,
    contextUsage: () => {
      const status = compactor.status();
      return { used: status.currentTokens, total: status.contextWindow };
    },
    provider: providerCommand,
    runtime,
    tasks: () => taskManager.list(),
    moveTaskToBackground: (taskId) => { taskManager.moveToBackground(taskId); },
    skillInstall: async (source, project, select) => {
      const installed = await skillInstaller.install(source, { project, ...(select ? { select } : {}) });
      return installed.length === 0 ? "Skill installation cancelled" : `Installed Skills: ${installed.map(({ name }) => name).join(", ")}`;
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
      await runtime.close("system_exit");
      await dispatchLifecycleHook({ type: "system_exit", system: { workspace, reason: "user_exit" } });
      await taskManager.shutdown();
      await mcpManager.close();
    },
  };
}

function resolveWorkspace(requested: string | undefined): string {
  if (requested === undefined) return process.cwd();
  const absolute = resolve(process.cwd(), requested);
  let stats: import("node:fs").Stats;
  try {
    stats = statSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Workspace directory does not exist: ${absolute}`);
    }
    throw new Error(`Unable to access workspace directory ${absolute}: ${String(error)}`);
  }
  if (!stats.isDirectory()) throw new Error(`Workspace path is not a directory: ${absolute}`);
  return absolute;
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
