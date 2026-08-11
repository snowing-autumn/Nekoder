import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillDefinition } from "./definition-catalog.js";
import type { HookRule } from "./hook-engine.js";

export class SkillCodeTrustStore {
  private readonly file: string;
  constructor(homeDir: string) { this.file = join(homeDir, ".nekoder", "trust", "skill-code.json"); }

  async isTrusted(workspace: string, definition: SkillDefinition): Promise<boolean> {
    if (definition.source.kind !== "project") return true;
    const values = await this.read();
    return values.includes(key(workspace, definition));
  }

  async trust(workspace: string, definition: SkillDefinition): Promise<void> {
    const values = await this.read();
    const value = key(workspace, definition);
    if (values.includes(value)) return;
    values.push(value);
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(values.sort(), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, this.file);
  }

  private async read(): Promise<string[]> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export class HookContentTrustStore {
  private readonly file: string;
  constructor(homeDir: string) { this.file = join(homeDir, ".nekoder", "trust", "hooks.json"); }
  async isTrusted(workspace: string, hook: HookRule): Promise<boolean> {
    if (hook.source !== "project" || "deny" in hook.action) return true;
    return (await readStringArray(this.file)).includes(hookKey(workspace, hook));
  }
  async trust(workspace: string, hook: HookRule): Promise<void> {
    const values = await readStringArray(this.file); const value = hookKey(workspace, hook);
    if (!values.includes(value)) values.push(value);
    await writeStringArray(this.file, values);
  }
}

function key(workspace: string, definition: SkillDefinition): string {
  return JSON.stringify([workspace, definition.source.kind, definition.source.path, definition.contentHash]);
}

function hookKey(workspace: string, hook: HookRule): string {
  return JSON.stringify([workspace, hook.path, hook.contentHash]);
}

async function readStringArray(file: string): Promise<string[]> {
  try { const value = JSON.parse(await readFile(file, "utf8")); return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function writeStringArray(file: string, values: string[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true }); const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify([...new Set(values)].sort(), null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}
