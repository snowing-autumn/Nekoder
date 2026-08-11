import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DelegatedTask } from "../extensions/delegated-task-manager.js";

export const SESSION_EVENT_VERSION = 1 as const;
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type SessionRole = "user" | "assistant" | "tool";

interface SessionEventBase {
  version: typeof SESSION_EVENT_VERSION;
  sessionId: string;
  seq: number;
  timestamp: string;
}

export type SessionEvent =
  | (SessionEventBase & { type: "session_started"; mode: string })
  | (SessionEventBase & { type: "session_resumed" })
  | (SessionEventBase & {
      type: "message";
      role: SessionRole;
      content: unknown;
      submittedToAgent?: boolean;
      rawSlashInput?: string;
      expandedText?: string;
    })
  | (SessionEventBase & { type: "mode_changed"; mode: string })
  | (SessionEventBase & {
      type: "compacted";
      coveredThroughSeq: number;
      retainedFromSeq: number;
      summary: string;
      interactionCount?: number;
      beforeTokens?: number;
      afterTokens?: number;
      artifactRefs?: string[];
    })
  | (SessionEventBase & { type: "delegated_task"; task: DelegatedTask })
  | (SessionEventBase & { type: "session_closed"; reason?: string });

export type SessionAppendEvent =
  | {
      type: "message";
      role: SessionRole;
      content: unknown;
      submittedToAgent?: boolean;
      rawSlashInput?: string;
      expandedText?: string;
    }
  | { type: "mode_changed"; mode: string }
  | {
      type: "compacted";
      coveredThroughSeq: number;
      retainedFromSeq: number;
      summary: string;
      interactionCount?: number;
      beforeTokens?: number;
      afterTokens?: number;
      artifactRefs?: string[];
    }
  | { type: "delegated_task"; task: DelegatedTask };

export type SessionDiagnosticCode = "trailing_corrupt_line" | "invalid_middle_line";

export interface SessionDiagnostic {
  code: SessionDiagnosticCode;
  line: number;
  reason: "invalid_json" | "invalid_event" | "non_monotonic_seq";
  message: string;
}

export interface SessionCleanupProjection {
  closed: boolean;
  lastEventAt: string;
  eligibleAt: string | null;
  expired: boolean;
}

export interface SessionProjection {
  id: string;
  title: string;
  messageCount: number;
  mode: string;
  compactionCount: number;
  lastCompactedThroughSeq: number | null;
  startedAt: string;
  updatedAt: string;
  closedAt: string | null;
  cleanup: SessionCleanupProjection;
  diagnostics: SessionDiagnostic[];
}

export interface SessionSnapshot {
  events: SessionEvent[];
  projection: SessionProjection;
}

export interface SessionJournalOptions {
  /** Directory containing the per-session JSONL files. */
  root?: string;
  clock?: () => Date;
  /** Produces the complete session ID, including its timestamp prefix. */
  idFactory?: (now: Date) => string;
}

export type SessionJournalErrorCode =
  | "active_session"
  | "invalid_session_id"
  | "no_active_session"
  | "session_exists"
  | "session_not_found";

export class SessionJournalError extends Error {
  constructor(
    readonly code: SessionJournalErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SessionJournalError";
  }
}

const SESSION_ID_PATTERN = /^\d{8}-\d{6}-[a-z0-9]{4}$/i;
const EVENT_TYPES = new Set<SessionEvent["type"]>([
  "session_started",
  "session_resumed",
  "message",
  "mode_changed",
  "compacted",
  "delegated_task",
  "session_closed",
]);
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function defaultIdFactory(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidEvent(value: unknown, sessionId: string): value is SessionEvent {
  if (!isRecord(value)) return false;
  if (
    value.version !== SESSION_EVENT_VERSION ||
    value.sessionId !== sessionId ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 1 ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.type !== "string" ||
    !EVENT_TYPES.has(value.type as SessionEvent["type"])
  ) {
    return false;
  }

  switch (value.type) {
    case "session_started":
    case "mode_changed":
      return typeof value.mode === "string";
    case "message":
      return (
        (value.role === "user" || value.role === "assistant" || value.role === "tool") &&
        Object.hasOwn(value, "content")
      );
    case "compacted":
      return (
        Number.isSafeInteger(value.coveredThroughSeq) &&
        (value.coveredThroughSeq as number) >= 0 &&
        Number.isSafeInteger(value.retainedFromSeq) &&
        (value.retainedFromSeq as number) >= 1 &&
        typeof value.summary === "string"
      );
    case "delegated_task":
      return isRecord(value.task) && typeof value.task.id === "string" && typeof value.task.status === "string";
    case "session_resumed":
    case "session_closed":
      return true;
    default:
      return false;
  }
}

function titleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join(" ");
}

function truncateTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  return Array.from(segmenter.segment(normalized), ({ segment }) => segment).slice(0, 60).join("");
}

function assertSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new SessionJournalError("invalid_session_id", `Invalid session ID: ${id}`);
  }
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export class SessionJournal {
  private readonly root: string;
  private readonly clock: () => Date;
  private readonly idFactory: (now: Date) => string;
  private activeId: string | null = null;

  constructor(options: SessionJournalOptions = {}) {
    this.root = options.root ?? join(process.cwd(), ".nekoder", "sessions");
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  async append(input: SessionAppendEvent): Promise<SessionEvent> {
    if (!this.activeId) {
      throw new SessionJournalError("no_active_session", "There is no active session.");
    }
    return this.appendTo(this.activeId, input);
  }

  async list(options: { limit?: number } = {}): Promise<SessionProjection[]> {
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError("Session list limit must be a non-negative integer.");
    }

    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }

    const now = this.clock();
    const projections = await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => name.slice(0, -".jsonl".length))
        .filter((id) => SESSION_ID_PATTERN.test(id))
        .map(async (id) => (await this.scan(id, now)).projection)
    );

    return projections
      .sort((left, right) => {
        const byUpdatedAt = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
        return byUpdatedAt || right.id.localeCompare(left.id);
      })
      .slice(0, limit);
  }

  async current(): Promise<SessionSnapshot | null> {
    return this.activeId ? this.scan(this.activeId, this.clock()) : null;
  }

  async new(mode = "execute"): Promise<SessionSnapshot> {
    if (this.activeId) await this.close("replaced");

    const now = this.clock();
    const id = this.idFactory(now);
    assertSessionId(id);
    await mkdir(this.root, { recursive: true });

    try {
      await readFile(this.fileFor(id));
      throw new SessionJournalError("session_exists", `Session already exists: ${id}`);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const event: SessionEvent = {
      version: SESSION_EVENT_VERSION,
      sessionId: id,
      seq: 1,
      timestamp: now.toISOString(),
      type: "session_started",
      mode,
    };
    await appendFile(this.fileFor(id), `${JSON.stringify(event)}\n`, "utf8");
    this.activeId = id;
    return this.scan(id, this.clock());
  }

  async resume(id: string): Promise<SessionSnapshot> {
    assertSessionId(id);
    await this.scan(id, this.clock());
    if (this.activeId === id) return this.scan(id, this.clock());
    if (this.activeId) await this.close("resumed_another");

    await this.appendTo(id, { type: "session_resumed" });
    this.activeId = id;
    return this.scan(id, this.clock());
  }

  async close(reason?: string): Promise<SessionSnapshot | null> {
    if (!this.activeId) return null;
    const id = this.activeId;
    await this.appendTo(id, { type: "session_closed", ...(reason ? { reason } : {}) });
    this.activeId = null;
    return this.scan(id, this.clock());
  }

  async delete(id: string): Promise<void> {
    assertSessionId(id);
    if (this.activeId === id) {
      throw new SessionJournalError("active_session", `Cannot delete active session: ${id}`);
    }
    try {
      await unlink(this.fileFor(id));
    } catch (error) {
      if (isMissingFile(error)) {
        throw new SessionJournalError("session_not_found", `Session not found: ${id}`);
      }
      throw error;
    }
  }

  async cleanupExpired(): Promise<readonly string[]> {
    const expired = (await this.list({ limit: Number.MAX_SAFE_INTEGER }))
      .filter(({ id, cleanup }) => id !== this.activeId && cleanup.expired)
      .map(({ id }) => id);
    for (const id of expired) await this.delete(id);
    return expired;
  }

  private fileFor(id: string): string {
    return join(this.root, `${id}.jsonl`);
  }

  private async appendTo(
    id: string,
    input:
      | SessionAppendEvent
      | { type: "session_resumed" }
      | { type: "session_closed"; reason?: string }
  ): Promise<SessionEvent> {
    const snapshot = await this.scan(id, this.clock());
    const raw = await readFile(this.fileFor(id), "utf8");
    const event = {
      version: SESSION_EVENT_VERSION,
      sessionId: id,
      seq: Math.max(0, ...snapshot.events.map(({ seq }) => seq)) + 1,
      timestamp: this.clock().toISOString(),
      ...input,
    } as SessionEvent;
    const separator = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
    await appendFile(this.fileFor(id), `${separator}${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  private async scan(id: string, now: Date): Promise<SessionSnapshot> {
    assertSessionId(id);
    let raw: string;
    try {
      raw = await readFile(this.fileFor(id), "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        throw new SessionJournalError("session_not_found", `Session not found: ${id}`);
      }
      throw error;
    }

    const lines = raw.split("\n");
    const contentIndexes = lines.flatMap((line, index) => (line.trim() ? [index] : []));
    const lastContentIndex = contentIndexes.at(-1) ?? -1;
    const events: SessionEvent[] = [];
    const diagnostics: SessionDiagnostic[] = [];
    let previousSeq = 0;

    for (const index of contentIndexes) {
      const line = lines[index]!.replace(/\r$/u, "");
      let parsed: unknown;
      let reason: SessionDiagnostic["reason"] | null = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        reason = "invalid_json";
      }

      if (!reason && !isValidEvent(parsed, id)) reason = "invalid_event";
      if (!reason && (parsed as SessionEvent).seq <= previousSeq) reason = "non_monotonic_seq";
      if (reason) {
        const trailing = index === lastContentIndex;
        diagnostics.push({
          code: trailing ? "trailing_corrupt_line" : "invalid_middle_line",
          line: index + 1,
          reason,
          message: trailing
            ? `Ignored corrupt trailing JSONL line ${index + 1}; it may be a crash remnant.`
            : `Skipped corrupt JSONL line ${index + 1}.`,
        });
        continue;
      }

      const event = parsed as SessionEvent;
      previousSeq = event.seq;
      events.push(event);
    }

    if (events.length === 0) {
      throw new SessionJournalError("session_not_found", `Session has no valid events: ${id}`);
    }

    return { events, projection: this.project(id, events, diagnostics, now) };
  }

  private project(
    id: string,
    events: SessionEvent[],
    diagnostics: SessionDiagnostic[],
    now: Date
  ): SessionProjection {
    let title = "";
    let mode = "execute";
    let messageCount = 0;
    let compactionCount = 0;
    let lastCompactedThroughSeq: number | null = null;
    let closedAt: string | null = null;

    for (const event of events) {
      if (event.type === "session_started" || event.type === "mode_changed") mode = event.mode;
      if (event.type === "session_started" || event.type === "session_resumed") closedAt = null;
      if (event.type === "session_closed") closedAt = event.timestamp;
      if (event.type === "compacted") {
        compactionCount += 1;
        lastCompactedThroughSeq = event.coveredThroughSeq;
      }
      if (event.type === "message") {
        messageCount += 1;
        if (!title && event.role === "user" && event.submittedToAgent !== false) {
          title = truncateTitle(event.rawSlashInput ?? titleText(event.content));
        }
      }
    }

    const startedAt = events[0]!.timestamp;
    const updatedAt = events.at(-1)!.timestamp;
    const eligibleAt = closedAt
      ? new Date(Date.parse(updatedAt) + SESSION_RETENTION_MS).toISOString()
      : null;

    return {
      id,
      title,
      messageCount,
      mode,
      compactionCount,
      lastCompactedThroughSeq,
      startedAt,
      updatedAt,
      closedAt,
      cleanup: {
        closed: closedAt !== null,
        lastEventAt: updatedAt,
        eligibleAt,
        expired: eligibleAt !== null && now.getTime() >= Date.parse(eligibleAt),
      },
      diagnostics,
    };
  }
}
