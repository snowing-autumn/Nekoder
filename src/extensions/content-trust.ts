import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillDefinition } from "./definition-catalog.js";

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

function key(workspace: string, definition: SkillDefinition): string {
  return JSON.stringify([workspace, definition.source.kind, definition.source.path, definition.contentHash]);
}
