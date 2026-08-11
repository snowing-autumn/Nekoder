import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { load as parseYaml } from "js-yaml";
import { HookEngine, type HookRule } from "./hook-engine.js";

export type DefinitionSourceKind = "project" | "user" | "plugin" | "builtin";

export interface DefinitionSource {
  readonly kind: DefinitionSourceKind;
  readonly root: string;
  readonly path: string;
}

export interface DefinitionDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface SkillRuntimeConfig {
  readonly version: 1;
  readonly modes: readonly ("inline" | "delegated")[];
  readonly history: readonly ("none" | "summary" | "recent" | "full")[];
  readonly aliases: readonly string[];
  readonly toolAllowlist?: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly worker?: { readonly command: string; readonly args: readonly string[] };
  readonly secrets: readonly { readonly name: string; readonly purpose?: string }[];
}

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly profile: "portable" | "claude-compatible";
  readonly source: DefinitionSource;
  readonly contentHash: string;
  readonly runtime: SkillRuntimeConfig;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly shadowed: readonly Pick<SkillDefinition, "source" | "contentHash">[];
}

export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly source: DefinitionSource;
  readonly contentHash: string;
  readonly model: string;
  readonly maxSteps: number;
  readonly permissionMode: "inherit" | "strict" | "plan" | "default" | "acceptEdit" | "permissive";
  readonly tools?: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly isolation: readonly ("shared" | "worktree")[];
  readonly secrets: readonly string[];
  readonly shadowed: readonly Pick<AgentDefinition, "source" | "contentHash">[];
}

export interface DefinitionSnapshot {
  readonly skills: readonly SkillDefinition[];
  readonly agents: readonly AgentDefinition[];
  readonly hooks: readonly HookRule[];
  readonly diagnostics: readonly DefinitionDiagnostic[];
  skill(name: string): SkillDefinition | undefined;
  agent(name: string): AgentDefinition | undefined;
}

export interface DefinitionCatalogOptions {
  readonly workspace: string;
  readonly homeDir: string;
  readonly pluginRoots?: readonly string[];
  readonly builtinRoot?: string;
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PORTABLE_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const CLAUDE_FIELDS = new Set([
  ...PORTABLE_FIELDS,
  "disable-model-invocation", "user-invocable", "context", "agent", "paths",
  "argument-hint", "arguments", "model", "effort", "hooks", "shell",
]);
const AGENT_FIELDS = new Set(["version", "name", "description", "model", "max_steps", "permission_mode", "tools", "disallowed_tools", "isolation", "secrets"]);
const RUNTIME_FIELDS = new Set([
  "version", "modes", "history", "aliases", "tool_allowlist", "disallowed_tools", "worker", "secrets",
]);

export class DefinitionCatalog {
  private previous: DefinitionSnapshot | undefined;
  constructor(private readonly options: DefinitionCatalogOptions) {}

  async load(): Promise<DefinitionSnapshot> {
    const diagnostics: DefinitionDiagnostic[] = [];
    const pluginRoots = this.options.pluginRoots ?? await discoverPluginRoots(this.options.homeDir);
    const sources: Array<{ kind: DefinitionSourceKind; root: string }> = [
      { kind: "project", root: join(this.options.workspace, ".nekoder") },
      { kind: "user", root: join(this.options.homeDir, ".nekoder") },
      ...pluginRoots.map((root) => ({ kind: "plugin" as const, root })),
      ...(this.options.builtinRoot ? [{ kind: "builtin" as const, root: this.options.builtinRoot }] : []),
    ];
    const candidates: SkillDefinition[] = [];
    const agentCandidates: AgentDefinition[] = [];
    const hookCandidates: HookRule[] = [];
    for (const source of sources) {
      candidates.push(...await loadSkills(source, diagnostics));
      agentCandidates.push(...await loadAgents(source, diagnostics));
      hookCandidates.push(...await loadHooks(source, diagnostics));
    }
    agentCandidates.push(...builtinAgents());
    for (const diagnostic of diagnostics) {
      for (const skill of this.previous?.skills ?? []) {
        if (diagnostic.path === join(skill.source.path, "SKILL.md") && !candidates.some((candidate) => candidate.source.path === skill.source.path)) candidates.push(skill);
      }
      for (const agent of this.previous?.agents ?? []) {
        if (diagnostic.path === agent.source.path && !agentCandidates.some((candidate) => candidate.source.path === agent.source.path)) agentCandidates.unshift(agent);
      }
      for (const hook of this.previous?.hooks ?? []) {
        if (diagnostic.path === hook.path && !hookCandidates.some((candidate) => candidate.path === hook.path && candidate.id === hook.id)) hookCandidates.unshift(hook);
      }
    }
    const winners = new Map<string, SkillDefinition>();
    for (const candidate of candidates) {
      const existing = winners.get(candidate.name);
      if (!existing) {
        winners.set(candidate.name, candidate);
        continue;
      }
      const shadowed = Object.freeze([
        ...existing.shadowed,
        Object.freeze({ source: candidate.source, contentHash: candidate.contentHash }),
      ]);
      winners.set(existing.name, Object.freeze({ ...existing, shadowed }));
    }
    const skills = Object.freeze([...winners.values()].sort((a, b) => a.name.localeCompare(b.name)));
    const agentWinners = new Map<string, AgentDefinition>();
    for (const candidate of agentCandidates) {
      const existing = agentWinners.get(candidate.name);
      if (!existing) agentWinners.set(candidate.name, candidate);
      else agentWinners.set(existing.name, Object.freeze({ ...existing, shadowed: Object.freeze([...existing.shadowed, { source: candidate.source, contentHash: candidate.contentHash }]) }));
    }
    const agents = Object.freeze([...agentWinners.values()].sort((a, b) => a.name.localeCompare(b.name)));
    const hookWinners = new Map<string, HookRule>();
    for (const hook of hookCandidates) if (!hookWinners.has(hook.id)) hookWinners.set(hook.id, hook);
    const hooks = Object.freeze([...hookWinners.values()]);
    const frozenDiagnostics = Object.freeze(diagnostics.map((item) => Object.freeze(item)));
    const byName = new Map(skills.map((item) => [item.name, item]));
    const agentsByName = new Map(agents.map((item) => [item.name, item]));
    const snapshot = Object.freeze({ skills, agents, hooks, diagnostics: frozenDiagnostics, skill: (name: string) => byName.get(name), agent: (name: string) => agentsByName.get(name) });
    this.previous = snapshot;
    return snapshot;
  }
}

async function loadHooks(
  source: { kind: DefinitionSourceKind; root: string }, diagnostics: DefinitionDiagnostic[]
): Promise<HookRule[]> {
  const root = join(source.root, "hooks");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: HookRule[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name)) continue;
    const file = join(root, entry.name);
    try {
      const fileContent = await readFile(file, "utf8");
      const raw = parseYaml(fileContent);
      if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.hooks)) throw definitionError("hook_file_invalid", "Hook file requires version 1 and hooks array");
      const contentHash = createHash("sha256").update(fileContent).digest("hex");
      const fileRules = raw.hooks.map((value, order) => parseHookRule(value, source.kind, file, order, contentHash));
      const ids = new Set<string>();
      if (fileRules.some((rule) => ids.has(rule.id) || !ids.add(rule.id))) throw definitionError("hook_duplicate_id", "Hook file contains a duplicate ID");
      new HookEngine(fileRules);
      result.push(...fileRules);
    } catch (error) {
      const typed = error as Error & { code?: string };
      diagnostics.push({ code: typed.code ?? "hook_file_invalid", message: typed.message, path: file });
    }
  }
  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const rule of result) (seen.has(rule.id) ? duplicates : seen).add(rule.id);
  if (duplicates.size > 0) {
    for (const id of duplicates) diagnostics.push({ code: "hook_duplicate_id", message: `Duplicate Hook ID ${id} in one source`, path: root });
    return result.filter((rule) => !duplicates.has(rule.id));
  }
  return result;
}

function parseHookRule(value: unknown, source: DefinitionSourceKind, path: string, order: number, contentHash: string): HookRule {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.event !== "string" || !isRecord(value.action)) throw definitionError("hook_rule_invalid", "Hook requires id, event, and action");
  const actionRaw = value.action;
  const actions = ["prompt", "deny", "subagent"].filter((key) => key in actionRaw);
  if (actions.length !== 1) throw definitionError("hook_action_invalid", "Hook action must contain exactly one action");
  let action: HookRule["action"];
  if ("prompt" in actionRaw) {
    const prompt = actionRaw.prompt;
    action = { prompt: { message: typeof prompt === "string" ? prompt : isRecord(prompt) && typeof prompt.message === "string" ? prompt.message : (() => { throw definitionError("hook_action_invalid", "prompt requires a message"); })() } };
  } else if ("deny" in actionRaw) {
    const deny = actionRaw.deny;
    if (!isRecord(deny) || typeof deny.reason !== "string") throw definitionError("hook_action_invalid", "deny requires a reason");
    action = { deny: { reason: deny.reason } };
  } else {
    const delegated = actionRaw.subagent;
    if (!isRecord(delegated) || typeof delegated.agent !== "string" || typeof delegated.task !== "string") throw definitionError("hook_action_invalid", "subagent requires agent and task");
    action = { subagent: { agent: delegated.agent, task: delegated.task } };
  }
  return Object.freeze({ id: value.id, event: value.event as HookRule["event"], ...(value.if === undefined ? {} : { if: value.if as import("./condition-matcher.js").Condition }), once: value.once === true,
    action, source, path, order, contentHash, trusted: source !== "project" || "deny" in action });
}

async function loadAgents(
  source: { kind: DefinitionSourceKind; root: string }, diagnostics: DefinitionDiagnostic[]
): Promise<AgentDefinition[]> {
  const root = join(source.root, "agents");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: AgentDefinition[] = [];
  const names = new Set<string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = join(root, entry.name);
    try {
      const parsed = parseMarkdownDefinition(await readFile(file, "utf8"), file);
      const raw = parsed.frontmatter;
      const unknown = Object.keys(raw).find((key) => !AGENT_FIELDS.has(key));
      if (unknown) throw definitionError("agent_field_unknown", `Unknown Agent field: ${unknown}`);
      if (raw.version !== 1 || typeof raw.name !== "string" || !SKILL_NAME.test(raw.name)) throw definitionError("agent_identity_invalid", "Agent definition requires version 1 and a valid name");
      if (basename(entry.name, ".md") !== raw.name) throw definitionError("agent_name_mismatch", "Agent name must match its filename");
      if (names.has(raw.name)) throw definitionError("agent_duplicate_name", `Duplicate Agent ${raw.name}`);
      names.add(raw.name);
      if (typeof raw.description !== "string" || raw.description.length > 1024) throw definitionError("agent_description_invalid", "Agent description is required");
      const maxSteps = raw.max_steps ?? 20;
      if (!Number.isInteger(maxSteps) || Number(maxSteps) < 1 || Number(maxSteps) > 50) throw definitionError("agent_steps_invalid", "max_steps must be 1-50");
      const permissionMode = raw.permission_mode ?? "inherit";
      if (!["inherit", "strict", "plan", "default", "acceptEdit", "permissive"].includes(String(permissionMode))) throw definitionError("agent_permission_invalid", "Invalid permission_mode");
      const isolation = enumArray(raw.isolation ?? ["shared"], ["shared", "worktree"], "isolation");
      const resolved = await realpath(file);
      const contentHash = createHash("sha256").update(await readFile(file)).digest("hex");
      result.push(Object.freeze({
        name: raw.name, description: raw.description, instructions: parsed.body,
        source: Object.freeze({ kind: source.kind, root: source.root, path: resolved }), contentHash,
        model: typeof raw.model === "string" ? raw.model : "inherit", maxSteps: Number(maxSteps),
        permissionMode: permissionMode as AgentDefinition["permissionMode"],
        ...(raw.tools === undefined ? {} : { tools: Object.freeze(stringArray(raw.tools, "tools")) }),
        disallowedTools: Object.freeze(stringArray(raw.disallowed_tools ?? [], "disallowed_tools")),
        isolation: Object.freeze(isolation), secrets: Object.freeze(stringArray(raw.secrets ?? [], "secrets")), shadowed: Object.freeze([]),
      }));
    } catch (error) {
      const typed = error as Error & { code?: string };
      diagnostics.push({ code: typed.code ?? "agent_invalid", message: typed.message, path: file });
    }
  }
  return result;
}

function builtinAgents(): AgentDefinition[] {
  const roles = [
    ["explore", "Explore a codebase without modifying it", ["shared"]],
    ["plan", "Investigate and produce a plan", ["shared"]],
    ["general", "Complete a bounded implementation task", ["worktree", "shared"]],
    ["verification", "Verify an implementation without modifying it", ["shared"]],
  ] as const;
  return roles.map(([name, description, isolation]) => Object.freeze({
    name, description, instructions: description, source: Object.freeze({ kind: "builtin" as const, root: "builtin", path: `builtin:agents/${name}` }),
    contentHash: createHash("sha256").update(`${name}:${description}`).digest("hex"), model: "inherit", maxSteps: 20,
    permissionMode: "inherit" as const, disallowedTools: Object.freeze(["delegate_agent", "task_list", "task_cancel"]),
    isolation: Object.freeze([...isolation]), secrets: Object.freeze([]), shadowed: Object.freeze([]),
  }));
}

async function loadSkills(
  source: { kind: DefinitionSourceKind; root: string },
  diagnostics: DefinitionDiagnostic[]
): Promise<SkillDefinition[]> {
  const skillsRoot = join(source.root, "skills");
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: SkillDefinition[] = [];
  const names = new Set<string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(skillsRoot, entry.name);
    const file = join(directory, "SKILL.md");
    try {
      const parsed = parseMarkdownDefinition(await readFile(file, "utf8"), file);
      const name = typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name : entry.name;
      if (!SKILL_NAME.test(name) || name.length > 64) throw definitionError("skill_name_invalid", "Skill name is invalid");
      if (name !== entry.name) throw definitionError("skill_name_mismatch", "Skill name must match its directory");
      if (names.has(name)) throw definitionError("skill_duplicate_name", `Duplicate Skill ${name} in one source`);
      names.add(name);
      const description = parsed.frontmatter.description;
      if (typeof description !== "string" || description.length < 1 || description.length > 1024) {
        throw definitionError("skill_description_invalid", "Skill description must be 1-1024 characters");
      }
      const profile = [...Object.keys(parsed.frontmatter)].every((key) => PORTABLE_FIELDS.has(key))
        ? "portable" as const
        : [...Object.keys(parsed.frontmatter)].every((key) => CLAUDE_FIELDS.has(key))
          ? "claude-compatible" as const
          : (() => { throw definitionError("skill_frontmatter_unknown", "Skill frontmatter contains unsupported fields"); })();
      const runtime = await loadRuntime(directory, parsed.frontmatter);
      const resolvedRoot = await realpath(directory);
      const contentHash = await hashDirectory(resolvedRoot);
      const definitionSource = Object.freeze({ kind: source.kind, root: source.root, path: resolvedRoot });
      result.push(Object.freeze({
        name, description, instructions: parsed.body, profile, source: definitionSource,
        contentHash, runtime, frontmatter: Object.freeze({ ...parsed.frontmatter }), shadowed: Object.freeze([]),
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      const typed = error as Error & { code?: string };
      diagnostics.push({ code: typed.code ?? "skill_invalid", message: typed.message, path: file });
    }
  }
  return result;
}

function parseMarkdownDefinition(content: string, file: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(content.replace(/^\uFEFF/u, ""));
  if (!match) throw definitionError("skill_frontmatter_missing", `${file} must start with YAML frontmatter`);
  const value = parseYaml(match[1] ?? "");
  if (!isRecord(value)) throw definitionError("skill_frontmatter_invalid", `${file} frontmatter must be an object`);
  return { frontmatter: value, body: match[2] ?? "" };
}

async function loadRuntime(directory: string, frontmatter: Readonly<Record<string, unknown>>): Promise<SkillRuntimeConfig> {
  const file = join(directory, "nekoder.yaml");
  let raw: unknown;
  try { raw = parseYaml(await readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return freezeRuntime({
      version: 1,
      modes: frontmatter.context === "fork" ? ["delegated"] : ["inline"],
      history: ["none"], aliases: [], disallowedTools: [], secrets: [],
    });
    throw error;
  }
  if (!isRecord(raw)) throw definitionError("skill_runtime_invalid", "nekoder.yaml must be an object");
  const unknown = Object.keys(raw).find((key) => !RUNTIME_FIELDS.has(key));
  if (unknown) throw definitionError("skill_runtime_unknown", `Unknown nekoder.yaml field: ${unknown}`);
  if (raw.version !== 1) throw definitionError("skill_runtime_version", "nekoder.yaml version must be 1");
  const modes = enumArray(raw.modes ?? ["inline"], ["inline", "delegated"], "modes");
  const history = enumArray(raw.history ?? ["none"], ["none", "summary", "recent", "full"], "history");
  const aliases = stringArray(raw.aliases ?? [], "aliases");
  const disallowedTools = stringArray(raw.disallowed_tools ?? [], "disallowed_tools");
  const toolAllowlist = raw.tool_allowlist === undefined ? undefined : stringArray(raw.tool_allowlist, "tool_allowlist");
  const secrets = parseSecrets(raw.secrets ?? []);
  let worker: SkillRuntimeConfig["worker"];
  if (raw.worker !== undefined) {
    if (!isRecord(raw.worker) || typeof raw.worker.command !== "string") throw definitionError("skill_worker_invalid", "worker.command is required");
    worker = Object.freeze({ command: raw.worker.command, args: Object.freeze(stringArray(raw.worker.args ?? [], "worker.args")) });
  }
  return freezeRuntime({ version: 1, modes, history, aliases, disallowedTools, secrets, ...(toolAllowlist ? { toolAllowlist } : {}), ...(worker ? { worker } : {}) });
}

function freezeRuntime(value: SkillRuntimeConfig): SkillRuntimeConfig {
  return Object.freeze({ ...value, modes: Object.freeze([...value.modes]), history: Object.freeze([...value.history]), aliases: Object.freeze([...value.aliases]), disallowedTools: Object.freeze([...value.disallowedTools]), secrets: Object.freeze([...value.secrets]), ...(value.toolAllowlist ? { toolAllowlist: Object.freeze([...value.toolAllowlist]) } : {}) });
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (["node_modules", ".git", ".venv", "vendor"].includes(entry.name) || entry.name.startsWith(".tmp")) continue;
      const path = join(directory, entry.name);
      const info = await stat(path);
      if (info.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) continue;
      hash.update(relative(root, path).split(sep).join("/"));
      hash.update("\0");
      hash.update(await readFile(path));
      hash.update("\0");
    }
  };
  await visit(root);
  return hash.digest("hex");
}

function parseSecrets(value: unknown): readonly { name: string; purpose?: string }[] {
  if (!Array.isArray(value)) throw definitionError("skill_secrets_invalid", "secrets must be an array");
  return value.map((entry) => {
    if (typeof entry === "string") return Object.freeze({ name: entry });
    if (!isRecord(entry) || typeof entry.name !== "string" || (entry.purpose !== undefined && typeof entry.purpose !== "string")) throw definitionError("skill_secrets_invalid", "secret entries require a name and optional purpose");
    return Object.freeze({ name: entry.name, ...(entry.purpose === undefined ? {} : { purpose: entry.purpose }) });
  });
}

function enumArray<T extends string>(value: unknown, allowed: readonly T[], field: string): readonly T[] {
  const list = stringArray(value, field);
  if (list.some((item) => !allowed.includes(item as T))) throw definitionError("skill_runtime_invalid", `${field} contains an invalid value`);
  return list as T[];
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw definitionError("skill_runtime_invalid", `${field} must be a string array`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function definitionError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function discoverPluginRoots(homeDir: string): Promise<string[]> {
  const root = join(homeDir, ".nekoder", "plugins");
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
