import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import type { WorktreeCommandExecutor } from "./worktree-manager.js";

export interface SkillInstallCandidate {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly files: readonly string[];
  readonly hasCode: boolean;
  readonly codePreview?: string;
  readonly license?: string;
  readonly compatible: boolean;
}

export interface SkillInstallerOptions {
  readonly workspace: string;
  readonly homeDir: string;
  readonly commandExecutor?: WorktreeCommandExecutor;
}

export class SkillInstaller {
  constructor(private readonly options: SkillInstallerOptions) {}

  async install(
    source: string,
    options: { readonly project?: boolean; readonly select?: (candidates: readonly SkillInstallCandidate[]) => readonly string[] | Promise<readonly string[]> } = {}
  ): Promise<readonly SkillInstallCandidate[]> {
    let root = resolve(source);
    let temporary: string | undefined;
    if (/^https:\/\/github\.com\//iu.test(source)) {
      if (!this.options.commandExecutor) throw new Error("GitHub Skill installation requires run_command");
      temporary = await mkdtemp(join(tmpdir(), "nekoder-skill-clone-"));
      const github = parseGitHubSource(source);
      const branch = github.ref ? ` --branch '${github.ref.replaceAll("'", "''")}'` : "";
      const result = await this.options.commandExecutor.execute({ command: `git clone --depth 1${branch} '${github.repository.replaceAll("'", "''")}' '${temporary.replaceAll("'", "''")}'`, cwd: this.options.workspace });
      if (result.code !== 0) throw new Error(`Skill clone failed: ${result.stderr || result.stdout}`);
      root = github.subdirectory ? resolve(temporary, github.subdirectory) : temporary;
    }
    try {
      const candidates = await discover(root);
      if (candidates.length === 0) throw new Error("No SKILL.md definitions were found");
      const selectedPaths = options.select ? await options.select(candidates) : candidates.length === 1 ? [candidates[0]!.path] : [];
      if (selectedPaths.length === 0) {
        if (options.select) return Object.freeze([]);
        throw new Error("Skill selection is required for a multi-Skill repository");
      }
      const selected = candidates.filter(({ path }) => selectedPaths.includes(path));
      if (selected.length !== new Set(selectedPaths).size) throw new Error("Skill selection contains an unknown path");
      const destinationRoot = options.project
        ? join(this.options.workspace, ".nekoder", "skills")
        : join(this.options.homeDir, ".nekoder", "skills");
      await mkdir(destinationRoot, { recursive: true });
      for (const candidate of selected) {
        const target = join(destinationRoot, candidate.name);
        try { await lstat(target); throw new Error(`Skill already exists: ${candidate.name}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await cp(candidate.path, target, { recursive: true, errorOnExist: true, force: false, dereference: false });
      }
      return Object.freeze(selected);
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  async create(name: string, description: string, options: { readonly project?: boolean; readonly nekoderExtension?: string } = {}): Promise<string> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) throw new Error("Invalid Skill name");
    if (!description.trim() || description.length > 1024 || /[\r\n]/u.test(description)) throw new Error("Invalid Skill description");
    const root = options.project ? join(this.options.workspace, ".nekoder", "skills") : join(this.options.homeDir, ".nekoder", "skills");
    const path = join(root, name);
    await mkdir(root, { recursive: true });
    await mkdir(path, { recursive: false });
    await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDescribe the portable workflow here.\n`, { flag: "wx" });
    if (options.nekoderExtension) await writeFile(join(path, "nekoder.yaml"), options.nekoderExtension, { flag: "wx" });
    return path;
  }
}

async function discover(root: string): Promise<SkillInstallCandidate[]> {
  const result: SkillInstallCandidate[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || result.length >= 256) return;
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const file = join(directory, "SKILL.md");
      const text = await readFile(file, "utf8");
      const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
      const frontmatter = match ? parseYaml(match[1] ?? "") : undefined;
      if (isRecord(frontmatter)) {
        const name = typeof frontmatter.name === "string" ? frontmatter.name : basename(directory);
        const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
        const files = await listFiles(directory);
        const codeFiles = files.filter((path) => /^(?:scripts|src)\//u.test(path) || /\.(?:js|ts|py|sh|ps1)$/iu.test(path));
        const codePreview = (await Promise.all(codeFiles.slice(0, 4).map(async (path) => {
          const content = await readFile(join(directory, path), "utf8");
          return `--- ${path} ---\n${content.slice(0, 2048)}`;
        }))).join("\n").slice(0, 8192);
        result.push(Object.freeze({ name, description, path: directory, files: Object.freeze(files), hasCode: codeFiles.length > 0,
          ...(codePreview ? { codePreview } : {}),
          ...(typeof frontmatter.license === "string" ? { license: frontmatter.license } : {}), compatible: /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && description.length > 0 }));
      }
      return;
    }
    for (const entry of entries) if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") await visit(join(directory, entry.name), depth + 1);
  };
  await visit(root, 0);
  return result;
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Skill package contains a symbolic link: ${join(directory, entry.name)}`);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  await visit(root, "");
  return files.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function parseGitHubSource(source: string): { repository: string; ref?: string; subdirectory?: string } {
  const url = new URL(source);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Invalid GitHub repository URL");
  const repository = `https://github.com/${parts[0]}/${parts[1]!.replace(/\.git$/u, "")}.git`;
  if (parts[2] !== "tree") return { repository };
  if (!parts[3]) throw new Error("GitHub tree URL is missing a ref");
  const subdirectory = parts.slice(4).map((part) => decodeURIComponent(part));
  if (subdirectory.some((part) => part === "." || part === ".." || /[\\\u0000]/u.test(part))) throw new Error("Invalid GitHub subdirectory");
  return { repository, ref: parts[3], ...(subdirectory.length > 0 ? { subdirectory: subdirectory.join("/") } : {}) };
}
