import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";

import type { ModelInvoker } from "../model/types.js";
import type { MemoryCatalog, MemoryScope } from "./memory-catalog.js";
import type {
  MemoryJobProcessor,
  MemoryOperation,
  MemoryOperationWrite,
  MemoryOperationWriter,
  MemoryProcessorRequest,
} from "./memory-job-runner.js";

const MEMORY_PROMPT = `You maintain Nekoder's low-authority Memory Notes.
Return only JSON shaped as {"operations": [...]} and never call tools.
Memory Notes may capture stable user preferences, reusable correction feedback,
verified project knowledge, and reference pointers. Do not retain secrets,
credentials, permission approvals, hidden reasoning, transient task state, or
facts already obvious from an authoritative source. Never promote a note into
User Instructions or Project Instructions. Prefer no operation when uncertain.
Every add/update markdown value must be a complete Markdown file with YAML
frontmatter fields: id, type, scope, status, created_at, updated_at,
last_verified_at, optional review_after, sources, supersedes; followed by one
Markdown heading and a concise body. IDs begin with mem_.`;

export class ModelMemoryJobProcessor implements MemoryJobProcessor {
  constructor(private readonly model: ModelInvoker) {}

  async process(request: MemoryProcessorRequest): Promise<unknown> {
    const result = await this.model.collect({
      messages: [{ role: "user", content: JSON.stringify(request) }],
      tools: [],
      toolChoice: "none",
      systemInstructions: [MEMORY_PROMPT],
    });
    if (result.toolCalls.length > 0) throw new Error("Memory processor attempted to call a tool");
    const text = result.text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error("Memory processor did not return valid JSON"); }
  }
}

export class CatalogMemoryOperationWriter implements MemoryOperationWriter {
  constructor(
    private readonly workspace: string,
    private readonly homeDir: string,
    private readonly catalog: MemoryCatalog
  ) {}

  async apply(write: MemoryOperationWrite): Promise<void> {
    const marker = resolve(this.workspace, ".nekoder", "state", "memory-applied", `${write.jobId}-${write.scope}.json`);
    if (await exists(marker)) return;
    for (const operation of write.operations) await this.applyOperation(write.scope, operation);
    await atomicWrite(marker, `${JSON.stringify({ version: 1, jobId: write.jobId, scope: write.scope })}\n`);
    await this.catalog.refresh();
  }

  private async applyOperation(scope: MemoryScope, operation: MemoryOperation): Promise<void> {
    if (operation.kind === "conflict") return;
    await this.catalog.refresh();
    if (operation.kind === "add") {
      validateMarkdown(operation.markdown, operation.id, scope);
      const path = this.notePath(scope, operation.id);
      if (await exists(path)) {
        if (await readFile(path, "utf8") === operation.markdown) return;
        throw new Error(`Memory Note already exists: ${operation.id}`);
      }
      await atomicWrite(path, operation.markdown);
      return;
    }
    const note = this.catalog.show(operation.id);
    if (note.scope !== scope) throw new Error(`Memory Note scope mismatch: ${operation.id}`);
    if (operation.expectedHash && sha256(note.raw) !== operation.expectedHash) {
      if (operation.kind === "update" && note.raw === operation.markdown) return;
      throw new Error(`Memory Note changed since it was read: ${operation.id}`);
    }
    if (operation.kind === "update") {
      validateMarkdown(operation.markdown, operation.id, scope);
      if (note.raw !== operation.markdown) await atomicWrite(note.path, operation.markdown);
      return;
    }
    if (note.status === "superseded") return;
    const now = new Date().toISOString();
    const updated = note.raw
      .replace(/^status:\s*active\s*$/mu, "status: superseded")
      .replace(/^updated_at:\s*.*$/mu, `updated_at: ${now}`);
    validateMarkdown(updated, operation.id, scope);
    await atomicWrite(note.path, updated);
  }

  private notePath(scope: MemoryScope, id: string): string {
    const base = scope === "project" ? this.workspace : this.homeDir;
    return resolve(base, ".nekoder", "memory", "notes", `${id}.md`);
  }
}

function validateMarkdown(markdown: string, expectedId: string, expectedScope: MemoryScope): void {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(markdown);
  if (!match) throw new Error("Memory Note must start with YAML frontmatter");
  const data = parseYaml(match[1]!) as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Memory Note frontmatter");
  if (data.id !== expectedId || data.scope !== expectedScope) throw new Error("Memory Note id or scope does not match the operation");
  if (!["preference", "correction", "project_knowledge", "reference"].includes(String(data.type))) throw new Error("Invalid Memory Note type");
  if (!["active", "superseded"].includes(String(data.status))) throw new Error("Invalid Memory Note status");
  for (const field of ["created_at", "updated_at", "last_verified_at"] as const) {
    if (typeof data[field] !== "string" || !Number.isFinite(Date.parse(data[field]))) throw new Error(`Invalid Memory Note ${field}`);
  }
  if (!Array.isArray(data.sources) || data.sources.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Invalid Memory Note sources");
  if (data.supersedes !== undefined && (!Array.isArray(data.supersedes) || data.supersedes.some((item) => typeof item !== "string"))) throw new Error("Invalid Memory Note supersedes");
  if (!/^#{1,6}\s+\S/mu.test(match[2] ?? "")) throw new Error("Memory Note body requires a heading");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
