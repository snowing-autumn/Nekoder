import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { load as parseYaml } from "js-yaml";

export type MemoryScope = "user" | "project";
export type MemoryType = "preference" | "correction" | "project_knowledge" | "reference";
export type MemoryStatusValue = "active" | "superseded";

export interface MemoryNote {
  readonly id: string;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  readonly status: MemoryStatusValue;
  readonly title: string;
  readonly body: string;
  readonly raw: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastVerifiedAt: string;
  readonly reviewAfter?: string;
  readonly sources: readonly string[];
  readonly supersedes: readonly string[];
  readonly path: string;
  readonly reviewDue: boolean;
}

export interface MemoryNoteSummary {
  readonly id: string;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  readonly status: MemoryStatusValue;
  readonly title: string;
  readonly updatedAt: string;
  readonly reviewDue: boolean;
  readonly conflict: boolean;
}

export interface MemoryDiagnostic {
  readonly code: "invalid_note" | "duplicate_id" | "index_truncated";
  readonly path?: string;
  readonly id?: string;
  readonly message: string;
}

export interface MemoryCatalogStatus {
  readonly loaded: number;
  readonly injectable: number;
  readonly user: number;
  readonly project: number;
  readonly conflicts: number;
  readonly reviewDue: number;
  readonly invalid: number;
  readonly indexTruncated: boolean;
}

export interface MemorySnapshot {
  readonly notes: readonly MemoryNote[];
  readonly injectableNotes: readonly MemoryNote[];
  readonly injectionText: string;
  readonly diagnostics: readonly MemoryDiagnostic[];
  readonly status: MemoryCatalogStatus;
}

export interface MemoryFilter {
  readonly scope?: MemoryScope;
  readonly type?: MemoryType;
  readonly limit?: number;
}

export interface MemoryCatalogOptions {
  readonly workspace: string;
  readonly homeDir: string;
  readonly clock?: () => Date;
}

export type MemoryCatalogErrorCode = "memory_not_found" | "memory_conflict" | "memory_path_invalid";

export class MemoryCatalogError extends Error {
  constructor(readonly code: MemoryCatalogErrorCode, message: string) {
    super(message);
    this.name = "MemoryCatalogError";
  }
}

const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25 * 1024;
const DEFAULT_REVIEW_MS = 90 * 24 * 60 * 60 * 1000;
const NOTE_FIELDS = new Set([
  "id", "type", "scope", "status", "created_at", "updated_at", "last_verified_at",
  "review_after", "sources", "supersedes",
]);
const MEMORY_ID = /^mem_[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const MEMORY_TYPES = new Set<MemoryType>(["preference", "correction", "project_knowledge", "reference"]);
const MEMORY_SCOPES = new Set<MemoryScope>(["user", "project"]);
const MEMORY_STATUSES = new Set<MemoryStatusValue>(["active", "superseded"]);

interface ScopeLayout {
  readonly scope: MemoryScope;
  readonly root: string;
  readonly notes: string;
  readonly index: string;
}

export class MemoryCatalog {
  private current: MemorySnapshot = emptySnapshot();

  constructor(private readonly options: MemoryCatalogOptions) {}

  static async open(options: MemoryCatalogOptions): Promise<MemoryCatalog> {
    const catalog = new MemoryCatalog(options);
    await catalog.refresh();
    return catalog;
  }

  snapshot(): MemorySnapshot {
    return this.current;
  }

  status(): MemoryCatalogStatus {
    return this.current.status;
  }

  list(filter: MemoryFilter = {}): readonly MemoryNoteSummary[] {
    const limit = filter.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("memory list limit must be a positive integer");
    const conflicts = conflictingIds(this.current.notes);
    return this.current.notes
      .filter((note) => filter.scope === undefined || note.scope === filter.scope)
      .filter((note) => filter.type === undefined || note.type === filter.type)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((note) => Object.freeze({
        id: note.id,
        type: note.type,
        scope: note.scope,
        status: note.status,
        title: note.title,
        updatedAt: note.updatedAt,
        reviewDue: note.reviewDue,
        conflict: conflicts.has(note.id),
      }));
  }

  show(id: string): MemoryNote {
    const matches = this.current.notes.filter((note) => note.id === id);
    if (matches.length === 0) throw new MemoryCatalogError("memory_not_found", `Memory Note not found: ${id}`);
    if (matches.length > 1) throw new MemoryCatalogError("memory_conflict", `Memory Note ID is duplicated: ${id}`);
    return matches[0]!;
  }

  async forget(id: string): Promise<MemoryNote> {
    await this.refresh();
    const note = this.show(id);
    const layout = this.layouts().find((item) => item.scope === note.scope)!;
    const resolved = resolve(note.path);
    assertContained(layout.notes, resolved);
    const info = await lstat(resolved);
    if (!info.isFile()) throw new MemoryCatalogError("memory_path_invalid", `${note.path} is not a regular file`);
    await unlink(resolved);
    await this.refresh();
    return note;
  }

  async refresh(): Promise<MemorySnapshot> {
    const diagnostics: MemoryDiagnostic[] = [];
    const notes: MemoryNote[] = [];
    const existingLayouts: ScopeLayout[] = [];
    for (const layout of this.layouts()) {
      if (!(await exists(layout.root))) continue;
      existingLayouts.push(layout);
      await mkdir(layout.notes, { recursive: true });
      const entries = await readdir(layout.notes, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.name.toLowerCase().endsWith(".md")) continue;
        const path = resolve(layout.notes, entry.name);
        if (!entry.isFile()) {
          diagnostics.push({ code: "invalid_note", path, message: "Memory Note is not a regular file" });
          continue;
        }
        try {
          notes.push(await this.readNote(path, layout.scope));
        } catch (error) {
          diagnostics.push({ code: "invalid_note", path, message: boundedMessage(error) });
        }
      }
    }

    const conflicts = conflictingIds(notes);
    for (const id of [...conflicts].sort()) {
      diagnostics.push({ code: "duplicate_id", id, message: `Duplicate Memory Note ID: ${id}` });
    }
    const injectable = notes.filter((note) =>
      note.status === "active" && !note.reviewDue && !conflicts.has(note.id)
    );
    let truncated = false;
    const injectionByScope = new Map<MemoryScope, string>();
    for (const layout of existingLayouts) {
      const built = buildIndex(injectable.filter((note) => note.scope === layout.scope));
      truncated ||= built.truncated;
      injectionByScope.set(layout.scope, built.content);
      await atomicWrite(layout.index, built.content);
    }
    if (truncated) diagnostics.push({
      code: "index_truncated",
      message: `Memory index was limited to ${MAX_INDEX_LINES} lines and ${MAX_INDEX_BYTES} bytes`,
    });
    const orderedNotes = [...notes].sort(noteOrder);
    const orderedInjectable = [...injectable].sort(noteOrder);
    const status = Object.freeze({
      loaded: notes.length,
      injectable: injectable.length,
      user: notes.filter(({ scope }) => scope === "user").length,
      project: notes.filter(({ scope }) => scope === "project").length,
      conflicts: conflicts.size,
      reviewDue: notes.filter(({ reviewDue }) => reviewDue).length,
      invalid: diagnostics.filter(({ code }) => code === "invalid_note").length,
      indexTruncated: truncated,
    });
    this.current = Object.freeze({
      notes: Object.freeze(orderedNotes),
      injectableNotes: Object.freeze(orderedInjectable),
      injectionText: (["project", "user"] as const)
        .map((scope) => injectionByScope.get(scope))
        .filter((text): text is string => Boolean(text?.trim()))
        .join("\n\n"),
      diagnostics: Object.freeze(diagnostics.map((item) => Object.freeze(item))),
      status,
    });
    return this.current;
  }

  private layouts(): readonly ScopeLayout[] {
    return [
      {
        scope: "user",
        root: resolve(this.options.homeDir, ".nekoder", "memory"),
        notes: resolve(this.options.homeDir, ".nekoder", "memory", "notes"),
        index: resolve(this.options.homeDir, ".nekoder", "memory", "index.md"),
      },
      {
        scope: "project",
        root: resolve(this.options.workspace, ".nekoder", "memory"),
        notes: resolve(this.options.workspace, ".nekoder", "memory", "notes"),
        index: resolve(this.options.workspace, ".nekoder", "memory", "index.md"),
      },
    ];
  }

  private async readNote(path: string, expectedScope: MemoryScope): Promise<MemoryNote> {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
    const parsed = parseFrontmatter(raw);
    for (const key of Object.keys(parsed.data)) {
      if (!NOTE_FIELDS.has(key)) throw new Error(`Unknown Memory Note field: ${key}`);
    }
    const id = requiredString(parsed.data.id, "id");
    if (!MEMORY_ID.test(id)) throw new Error("Memory Note id must start with mem_ and contain only letters, numbers, _ or -");
    const type = requiredString(parsed.data.type, "type") as MemoryType;
    if (!MEMORY_TYPES.has(type)) throw new Error(`Invalid Memory Note type: ${type}`);
    const scope = requiredString(parsed.data.scope, "scope") as MemoryScope;
    if (!MEMORY_SCOPES.has(scope) || scope !== expectedScope) {
      throw new Error(`Memory Note scope ${scope} does not match its ${expectedScope} directory`);
    }
    const status = requiredString(parsed.data.status, "status") as MemoryStatusValue;
    if (!MEMORY_STATUSES.has(status)) throw new Error(`Invalid Memory Note status: ${status}`);
    const createdAt = timestamp(parsed.data.created_at, "created_at");
    const updatedAt = timestamp(parsed.data.updated_at, "updated_at");
    const lastVerifiedAt = timestamp(parsed.data.last_verified_at, "last_verified_at");
    const reviewAfter = parsed.data.review_after === undefined
      ? undefined
      : timestamp(parsed.data.review_after, "review_after");
    const sources = stringArray(parsed.data.sources, "sources", true);
    const supersedes = parsed.data.supersedes === undefined
      ? []
      : stringArray(parsed.data.supersedes, "supersedes", false);
    const title = titleFromBody(parsed.body);
    if (!title) throw new Error("Memory Note body must contain a Markdown heading");
    const reviewDue = await this.isReviewDue({
      type, scope, lastVerifiedAt, reviewAfter, sources,
    });
    return Object.freeze({
      id, type, scope, status, title, body: parsed.body.trim(), raw,
      createdAt, updatedAt, lastVerifiedAt,
      ...(reviewAfter === undefined ? {} : { reviewAfter }),
      sources: Object.freeze(sources),
      supersedes: Object.freeze(supersedes),
      path,
      reviewDue,
    });
  }

  private async isReviewDue(note: {
    readonly type: MemoryType;
    readonly scope: MemoryScope;
    readonly lastVerifiedAt: string;
    readonly reviewAfter?: string;
    readonly sources: readonly string[];
  }): Promise<boolean> {
    const now = (this.options.clock?.() ?? new Date()).getTime();
    if (note.reviewAfter && Date.parse(note.reviewAfter) <= now) return true;
    if (
      note.reviewAfter === undefined &&
      (note.type === "project_knowledge" || note.type === "reference") &&
      Date.parse(note.lastVerifiedAt) + DEFAULT_REVIEW_MS <= now
    ) return true;
    const verified = Date.parse(note.lastVerifiedAt);
    for (const source of note.sources) {
      const path = localSourcePath(source, note.scope === "project" ? this.options.workspace : this.options.homeDir);
      if (!path) continue;
      try {
        if ((await stat(path)).mtimeMs > verified) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      }
    }
    return false;
  }
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const normalized = raw.replace(/^\uFEFF/u, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(normalized);
  if (!match) throw new Error("Memory Note must start with YAML frontmatter");
  const value = parseYaml(match[1]!) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Memory Note frontmatter must be a mapping");
  }
  return { data: value as Record<string, unknown>, body: match[2] ?? "" };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Memory Note ${field} must be a non-empty string`);
  return value.trim();
}

function timestamp(value: unknown, field: string): string {
  const text = value instanceof Date ? value.toISOString() : requiredString(value, field);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Error(`Memory Note ${field} must be an ISO timestamp`);
  return new Date(time).toISOString();
}

function stringArray(value: unknown, field: string, nonEmpty: boolean): string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new Error(`Memory Note ${field} must be ${nonEmpty ? "a non-empty" : "an"} array`);
  }
  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Memory Note ${field} entries must be non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

function titleFromBody(body: string): string {
  for (const line of body.split(/\r?\n/u)) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match) return match[1]!.trim();
  }
  return "";
}

function noteSummary(note: MemoryNote): string {
  const lines = note.body.split(/\r?\n/u);
  const text = lines
    .filter((line) => !/^#{1,6}\s/u.test(line))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return (text || note.title).slice(0, 400);
}

function buildIndex(notes: readonly MemoryNote[]): { content: string; truncated: boolean } {
  const lines = ["# Memory Index", ""];
  let truncated = false;
  for (const note of [...notes].sort(noteOrder)) {
    const line = `- [${note.id}] (${note.scope}/${note.type}) ${note.title}: ${noteSummary(note)}`;
    const candidate = `${[...lines, line].join("\n")}\n`;
    if (lines.length + 1 > MAX_INDEX_LINES || Buffer.byteLength(candidate, "utf8") > MAX_INDEX_BYTES) {
      truncated = true;
      continue;
    }
    lines.push(line);
  }
  return { content: `${lines.join("\n")}\n`, truncated };
}

function conflictingIds(notes: readonly MemoryNote[]): Set<string> {
  const counts = new Map<string, number>();
  for (const note of notes) counts.set(note.id, (counts.get(note.id) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

function noteOrder(left: MemoryNote, right: MemoryNote): number {
  if (left.scope !== right.scope) return left.scope === "project" ? -1 : 1;
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function localSourcePath(source: string, base: string): string | undefined {
  if (isAbsolute(source)) return source;
  if (/^file:/iu.test(source)) return resolve(base, source.slice(5));
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source)) return undefined;
  if (source.startsWith("http://") || source.startsWith("https://")) return undefined;
  return resolve(base, source);
}

function assertContained(boundary: string, target: string): void {
  const path = relative(boundary, target);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new MemoryCatalogError("memory_path_invalid", `${target} is outside the Memory Note directory`);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function emptySnapshot(): MemorySnapshot {
  const status = Object.freeze({
    loaded: 0, injectable: 0, user: 0, project: 0,
    conflicts: 0, reviewDue: 0, invalid: 0, indexTruncated: false,
  });
  return Object.freeze({
    notes: Object.freeze([]),
    injectableNotes: Object.freeze([]),
    injectionText: "",
    diagnostics: Object.freeze([]),
    status,
  });
}

export const MEMORY_INDEX_LIMITS = Object.freeze({
  lines: MAX_INDEX_LINES,
  bytes: MAX_INDEX_BYTES,
});
