import { cp, mkdir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { load as parseYaml } from "js-yaml";

export interface WorktreeCommandRequest {
  readonly command: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface WorktreeCommandResult { readonly code: number; readonly stdout: string; readonly stderr: string }
export interface WorktreeCommandExecutor { execute(request: WorktreeCommandRequest): Promise<WorktreeCommandResult> }

export interface WorktreeRegistration {
  readonly version: 1;
  readonly repository: string;
  readonly taskId: string;
  readonly slug: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
}

export interface WorktreeManagerOptions {
  readonly workspace: string;
  readonly commandExecutor: WorktreeCommandExecutor;
}

export interface WorktreeInspection {
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly finalCommit: string;
  readonly dirty: boolean;
  readonly uniqueCommits: number;
  readonly diffSummary: string;
}

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const WINDOWS_DEVICES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export class WorktreeManager {
  constructor(private readonly options: WorktreeManagerOptions) {}

  async create(request: { taskId: string; slug: string; signal?: AbortSignal }): Promise<WorktreeRegistration> {
    validateSegment(request.taskId, "task ID");
    validateSegment(request.slug, "slug");
    const repository = await realpath(this.options.workspace);
    const root = resolve(repository, ".nekoder", "worktrees");
    const path = resolve(root, `${request.taskId}-${request.slug}`);
    assertContained(root, path);
    if (await exists(path)) throw new Error(`Managed Worktree path already exists: ${path}`);
    const branch = `nekoder/task/${request.taskId}-${request.slug}`;
    await mkdir(root, { recursive: true });
    await this.ensureIgnored(repository);
    const head = await this.execute("git rev-parse HEAD", repository, request.signal);
    const baseCommit = head.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/iu.test(baseCommit)) throw new Error("git rev-parse HEAD returned an invalid commit");
    await this.execute(
      `git worktree add -b ${quote(branch)} ${quote(path)} ${quote(baseCommit)}`,
      repository,
      request.signal
    );
    const resolvedPath = await realpath(path);
    assertContained(root, resolvedPath);
    const registration: WorktreeRegistration = Object.freeze({
      version: 1, repository, taskId: request.taskId, slug: request.slug,
      path: resolvedPath, branch, baseCommit,
    });
    await this.initializeResources(repository, resolvedPath);
    await this.writeRegistration(root, registration);
    return registration;
  }

  async recover(expected: WorktreeRegistration): Promise<WorktreeRegistration> {
    validateSegment(expected.taskId, "task ID");
    validateSegment(expected.slug, "slug");
    const repository = await realpath(this.options.workspace);
    const root = resolve(repository, ".nekoder", "worktrees");
    const expectedPath = resolve(root, `${expected.taskId}-${expected.slug}`);
    assertContained(root, expectedPath);
    const actualPath = await realpath(expectedPath);
    assertContained(root, actualPath);
    const file = registrationPath(root, expected.taskId);
    const raw = JSON.parse(await readFile(file, "utf8")) as WorktreeRegistration;
    const requested = { ...expected, repository, path: actualPath };
    for (const key of ["version", "repository", "taskId", "slug", "path", "branch", "baseCommit"] as const) {
      if (raw[key] !== requested[key]) throw new Error(`Worktree registration does not match ${key}`);
    }
    return Object.freeze({ ...raw });
  }

  async inspect(registration: WorktreeRegistration, signal?: AbortSignal): Promise<WorktreeInspection> {
    const recovered = await this.recover(registration);
    const [head, status, count, diff] = await Promise.all([
      this.execute("git rev-parse HEAD", recovered.path, signal),
      this.execute("git status --porcelain", recovered.path, signal),
      this.execute(`git rev-list --count ${quote(`${recovered.baseCommit}..HEAD`)}`, recovered.path, signal),
      this.execute(`git diff --stat ${quote(recovered.baseCommit)}`, recovered.path, signal),
    ]);
    return Object.freeze({
      path: recovered.path, branch: recovered.branch, baseCommit: recovered.baseCommit,
      finalCommit: head.stdout.trim(), dirty: status.stdout.trim().length > 0,
      uniqueCommits: Number.parseInt(count.stdout.trim(), 10) || 0,
      diffSummary: diff.stdout.trim().slice(0, 16 * 1024),
    });
  }

  async cleanup(registration: WorktreeRegistration, signal?: AbortSignal): Promise<{ removed: boolean; reason?: string }> {
    const inspection = await this.inspect(registration, signal);
    if (inspection.dirty) return { removed: false, reason: "dirty" };
    if (inspection.uniqueCommits > 0) return { removed: false, reason: "unique_commits" };
    await this.execute(`git worktree remove ${quote(registration.path)}`, registration.repository, signal);
    return { removed: true };
  }

  private async execute(command: string, cwd: string, signal?: AbortSignal): Promise<WorktreeCommandResult> {
    if (signal?.aborted) throw new Error("Worktree provisioning was cancelled");
    const result = await this.options.commandExecutor.execute({ command, cwd, ...(signal ? { signal } : {}) });
    if (result.code !== 0) throw new Error(`Worktree command failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  }

  private async writeRegistration(root: string, registration: WorktreeRegistration): Promise<void> {
    const file = registrationPath(root, registration.taskId);
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(registration, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, file);
  }

  private async ensureIgnored(repository: string): Promise<void> {
    const file = join(repository, ".gitignore");
    let content = "";
    try { content = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (content.split(/\r?\n/u).includes(".nekoder/worktrees/")) return;
    const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    await writeFile(file, `${content}${prefix}.nekoder/worktrees/\n`);
  }

  private async initializeResources(repository: string, worktree: string): Promise<void> {
    const file = join(repository, ".nekoder", "worktree.yaml");
    let raw: unknown;
    try { raw = parseYaml(await readFile(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!isRecord(raw) || raw.version !== 1) throw new Error(".nekoder/worktree.yaml must use version 1");
    const copy = pathList(raw.copy, "copy");
    const link = pathList(raw.link, "link");
    const required = pathList(raw.required, "required");
    const unknown = Object.keys(raw).find((key) => !["version", "copy", "link", "required"].includes(key));
    if (unknown) throw new Error(`Unknown Worktree initialization field: ${unknown}`);
    for (const item of [...copy, ...link, ...required]) validateResourcePath(item);
    for (const item of copy) {
      const source = resolve(repository, item); const target = resolve(worktree, item);
      assertContained(repository, source); assertContained(worktree, target);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false });
    }
    for (const item of link) {
      const source = await realpath(resolve(repository, item)); const target = resolve(worktree, item);
      assertContained(repository, source); assertContained(worktree, target);
      await mkdir(dirname(target), { recursive: true });
      const sourceInfo = await stat(source);
      await symlink(source, target, process.platform === "win32" && sourceInfo.isDirectory() ? "junction" : sourceInfo.isDirectory() ? "dir" : "file");
    }
    for (const item of required) {
      try { await stat(resolve(worktree, item)); }
      catch { throw new Error(`Required Worktree resource is missing: ${item}`); }
    }
  }
}

function validateSegment(value: string, label: string): void {
  if (!SAFE_ID.test(value) || value === "." || value === ".." || WINDOWS_DEVICES.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid Worktree ${label}: ${value}`);
  }
}

function assertContained(root: string, target: string): void {
  const child = relative(root, target);
  if (child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return;
  throw new Error(`Worktree path escapes the managed root: ${target}`);
}

function registrationPath(root: string, taskId: string): string {
  return join(root, ".registrations", `${taskId}.json`);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function pathList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`Worktree ${field} must be a string array`);
  return value;
}

function validateResourcePath(value: string): void {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!value || isAbsolute(value) || segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`Invalid Worktree resource path: ${value}`);
  if (/(?:^|\/)(?:\.git|\.nekoder)(?:\/|$)|(?:^|\/)(?:\.env(?:\.|$)|.*(?:secret|credential|token|password|api[-_]?key).*)/iu.test(normalized)) throw new Error(`Sensitive Worktree resource path is forbidden: ${value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
