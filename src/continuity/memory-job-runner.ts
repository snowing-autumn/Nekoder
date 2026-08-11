import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { MemoryScope } from "./memory-catalog.js";

export type MemoryJobKind = "update" | "organize";
export type MemoryJobState = "pending" | "running" | "prepared" | "succeeded" | "failed";

export type MemoryOperation =
  | { readonly kind: "add"; readonly id: string; readonly markdown: string }
  | { readonly kind: "update"; readonly id: string; readonly markdown: string; readonly expectedHash?: string }
  | { readonly kind: "supersede"; readonly id: string; readonly supersededBy?: string; readonly expectedHash?: string }
  | { readonly kind: "conflict"; readonly ids: readonly string[] };

export interface MemoryProcessorRequest {
  readonly jobId: string;
  readonly kind: MemoryJobKind;
  readonly scope: MemoryScope;
  readonly input: JsonValue;
  readonly attempt: number;
}

/** Must be side-effect free: it may only propose operations. */
export interface MemoryJobProcessor {
  process(request: MemoryProcessorRequest): Promise<unknown>;
}

export interface MemoryOperationWrite {
  readonly jobId: string;
  readonly kind: MemoryJobKind;
  readonly scope: MemoryScope;
  readonly operations: readonly MemoryOperation[];
}

/** apply() must be idempotent for the same jobId and scope. */
export interface MemoryOperationWriter {
  apply(write: MemoryOperationWrite): Promise<void>;
}

export interface MemoryJobScheduler {
  schedule(task: () => Promise<void>, delayMs?: number): void;
}

export interface MemoryJobRunnerOptions {
  readonly workspace: string;
  readonly homeDir: string;
  readonly processor: MemoryJobProcessor;
  readonly writer: MemoryOperationWriter;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  readonly scheduler?: MemoryJobScheduler;
  readonly leaseMs?: number;
  readonly retryDelayMs?: number;
}

export interface MemoryUpdateRequest {
  readonly jobId?: string;
  readonly requests: readonly {
    readonly scope: MemoryScope;
    readonly input: unknown;
  }[];
}

export interface OrganizeRequest {
  readonly scope: MemoryScope;
  readonly input: unknown;
}

export type OrganizeDecision =
  | { readonly scheduled: true; readonly jobId: string }
  | { readonly scheduled: false; readonly reason: "no_memory" | "throttled" | "not_due" | "already_running" | "lease_busy" };

export interface MemoryJobReceipt {
  readonly jobId: string;
  readonly kind: MemoryJobKind;
  readonly state: MemoryJobState;
}

export interface MemoryJobKindStatus {
  readonly pending: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly lastError?: string;
}

export interface MemoryJobRunnerStatus {
  readonly update: MemoryJobKindStatus;
  readonly organize: MemoryJobKindStatus;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

interface PersistedRequest {
  readonly scope: MemoryScope;
  readonly input: JsonValue;
}

interface PreparedScope {
  readonly scope: MemoryScope;
  readonly operations: readonly MemoryOperation[];
  readonly applied: boolean;
}

interface PersistedJob {
  readonly version: 1;
  readonly id: string;
  readonly kind: MemoryJobKind;
  readonly state: MemoryJobState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: number;
  readonly requests: readonly PersistedRequest[];
  readonly prepared?: readonly PreparedScope[];
  readonly error?: string;
}

interface OrganizeState {
  readonly version: 1;
  readonly lastScannedAt?: string;
  readonly lastSucceededAt?: string;
  readonly activeJobId?: string;
  readonly lastError?: string;
}

interface Lease {
  readonly path: string;
  readonly owner: string;
}

const MAX_ERROR_CHARS = 500;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OPERATIONS = 128;
const MAX_MARKDOWN_BYTES = 32 * 1024;
const ORGANIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SCAN_THROTTLE_MS = 10 * 60 * 1000;
const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MEMORY_ID = /^mem_[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export class MemoryJobRunner {
  private readonly jobs = new Map<string, PersistedJob>();
  private readonly scheduled = new Set<string>();
  private readonly scopeTails = new Map<MemoryScope, Promise<void>>();
  private readonly scheduler: MemoryJobScheduler;
  private readonly instanceId: string;
  private started: Promise<void> | undefined;
  private startupError: string | undefined;

  constructor(private readonly options: MemoryJobRunnerOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.instanceId = safeId(options.idFactory?.() ?? randomUUID(), "instance");
  }

  static async open(options: MemoryJobRunnerOptions): Promise<MemoryJobRunner> {
    const runner = new MemoryJobRunner(options);
    await runner.start();
    return runner;
  }

  async start(): Promise<void> {
    this.started ??= this.loadPendingJobs();
    await this.started;
  }

  async enqueueUpdate(request: MemoryUpdateRequest): Promise<MemoryJobReceipt> {
    await this.start();
    if (request.requests.length === 0) throw new Error("Memory update requires at least one scope request");
    const scopes = new Set<MemoryScope>();
    const requests = request.requests.map((item) => {
      if (scopes.has(item.scope)) throw new Error(`Duplicate Memory update scope: ${item.scope}`);
      scopes.add(item.scope);
      return Object.freeze({ scope: item.scope, input: normalizeJson(item.input) });
    });
    const id = safeId(request.jobId ?? `memory-update-${this.nextId()}`, "job");
    const existing = this.jobs.get(id);
    if (existing) {
      if (existing.kind !== "update" || stableJson(existing.requests) !== stableJson(requests)) {
        throw new Error(`Memory job ID collision: ${id}`);
      }
      if (recoverable(existing.state)) this.scheduleJob(id);
      return receipt(existing);
    }
    const now = this.now();
    const job: PersistedJob = Object.freeze({
      version: 1,
      id,
      kind: "update",
      state: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      requests: Object.freeze(requests),
    });
    await this.saveJob(job);
    this.jobs.set(id, job);
    this.scheduleJob(id);
    return receipt(job);
  }

  async maybeOrganize(request: OrganizeRequest): Promise<OrganizeDecision> {
    await this.start();
    const memoryRoot = request.scope === "project"
      ? resolve(this.options.workspace, ".nekoder", "memory")
      : resolve(this.options.homeDir, ".nekoder", "memory");
    if (!(await isDirectory(memoryRoot))) return { scheduled: false, reason: "no_memory" };
    const lease = await this.acquireLease(`organize-${request.scope}`);
    if (!lease) return { scheduled: false, reason: "lease_busy" };
    try {
      const state = await this.readOrganizeState(request.scope);
      const nowMs = this.nowMs();
      if (state.lastScannedAt && nowMs - Date.parse(state.lastScannedAt) < SCAN_THROTTLE_MS) {
        return { scheduled: false, reason: "throttled" };
      }
      const active = [...this.jobs.values()].find((job) =>
        job.kind === "organize" &&
        job.requests[0]?.scope === request.scope &&
        recoverable(job.state)
      );
      const scannedAt = this.now();
      if (active) {
        await this.writeOrganizeState(request.scope, { ...state, lastScannedAt: scannedAt, activeJobId: active.id });
        this.scheduleJob(active.id);
        return { scheduled: false, reason: "already_running" };
      }
      if (state.lastSucceededAt && nowMs - Date.parse(state.lastSucceededAt) <= ORGANIZE_INTERVAL_MS) {
        await this.writeOrganizeState(request.scope, { ...state, lastScannedAt: scannedAt, activeJobId: undefined });
        return { scheduled: false, reason: "not_due" };
      }
      const id = safeId(`memory-organize-${request.scope}-${this.nextId()}`, "job");
      const job: PersistedJob = Object.freeze({
        version: 1,
        id,
        kind: "organize",
        state: "pending",
        createdAt: scannedAt,
        updatedAt: scannedAt,
        attempts: 0,
        requests: Object.freeze([{ scope: request.scope, input: normalizeJson(request.input) }]),
      });
      await this.saveJob(job);
      this.jobs.set(id, job);
      await this.writeOrganizeState(request.scope, {
        ...state,
        lastScannedAt: scannedAt,
        activeJobId: id,
        lastError: undefined,
      });
      this.scheduleJob(id);
      return { scheduled: true, jobId: id };
    } finally {
      await this.releaseLease(lease);
    }
  }

  status(): MemoryJobRunnerStatus {
    return Object.freeze({
      update: this.kindStatus("update"),
      organize: this.kindStatus("organize"),
    });
  }

  private async loadPendingJobs(): Promise<void> {
    await mkdir(this.jobsDirectory(), { recursive: true });
    let entries: string[] = [];
    try {
      entries = (await readdir(this.jobsDirectory())).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      this.startupError = boundedError(error);
      return;
    }
    for (const entry of entries) {
      try {
        const job = parseJob(JSON.parse(await readFile(resolve(this.jobsDirectory(), entry), "utf8")));
        this.jobs.set(job.id, job);
        if (recoverable(job.state)) this.scheduleJob(job.id);
      } catch (error) {
        this.startupError = boundedError(error);
      }
    }
  }

  private scheduleJob(id: string, delayMs = 0): void {
    if (this.scheduled.has(id)) return;
    const job = this.jobs.get(id);
    if (!job || !recoverable(job.state)) return;
    this.scheduled.add(id);
    this.scheduler.schedule(async () => {
      let retry = false;
      try {
        retry = await this.processJob(id);
      } catch (error) {
        await this.failJob(id, error);
      } finally {
        this.scheduled.delete(id);
      }
      if (retry) this.scheduleJob(id, this.options.retryDelayMs ?? 1_000);
    }, delayMs);
  }

  private async processJob(id: string): Promise<boolean> {
    let job = this.jobs.get(id);
    if (!job || !recoverable(job.state)) return false;
    const jobLease = await this.acquireLease(`job-${id}`);
    if (!jobLease) return true;
    let organizeLease: Lease | undefined;
    try {
      job = await this.readJob(id);
      this.jobs.set(id, job);
      if (!job || !recoverable(job.state)) return false;
      if (job.kind === "organize") {
        organizeLease = await this.acquireLease(`organize-${job.requests[0]!.scope}`) ?? undefined;
        if (!organizeLease) return true;
      }
      if (!job.prepared) {
        job = await this.transition(job, {
          state: "running",
          attempts: job.attempts + 1,
          error: undefined,
        });
        const prepared: PreparedScope[] = [];
        for (const request of job.requests) {
          const proposed = await this.options.processor.process({
            jobId: job.id,
            kind: job.kind,
            scope: request.scope,
            input: request.input,
            attempt: job.attempts,
          });
          prepared.push(Object.freeze({
            scope: request.scope,
            operations: Object.freeze(validateOperations(proposed)),
            applied: false,
          }));
        }
        job = await this.transition(job, {
          state: "prepared",
          prepared: Object.freeze(prepared),
        });
      }
      for (let index = 0; index < job.prepared!.length; index++) {
        const item = job.prepared![index]!;
        if (item.applied) continue;
        const written = await this.withScopeWriteLock(item.scope, async () => {
          await this.options.writer.apply({
            jobId: job!.id,
            kind: job!.kind,
            scope: item.scope,
            operations: item.operations,
          });
        });
        if (!written) return true;
        const prepared = job.prepared!.map((entry, current) =>
          current === index ? Object.freeze({ ...entry, applied: true }) : entry
        );
        job = await this.transition(job, { state: "prepared", prepared: Object.freeze(prepared) });
      }
      if (job.kind === "organize") {
        const scope = job.requests[0]!.scope;
        const state = await this.readOrganizeState(scope);
        await this.writeOrganizeState(scope, {
          ...state,
          lastSucceededAt: this.now(),
          activeJobId: undefined,
          lastError: undefined,
        });
      }
      await this.transition(job, { state: "succeeded", error: undefined });
      return false;
    } catch (error) {
      await this.failJob(id, error);
      return false;
    } finally {
      if (organizeLease) await this.releaseLease(organizeLease);
      await this.releaseLease(jobLease);
    }
  }

  private async failJob(id: string, error: unknown): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.state === "succeeded" || job.state === "failed") return;
    const message = boundedError(error);
    await this.transition(job, { state: "failed", error: message });
    if (job.kind === "organize") {
      const scope = job.requests[0]!.scope;
      const state = await this.readOrganizeState(scope);
      await this.writeOrganizeState(scope, {
        ...state,
        activeJobId: undefined,
        lastError: message,
      });
    }
  }

  private async transition(
    job: PersistedJob,
    changes: Partial<Pick<PersistedJob, "state" | "attempts" | "prepared" | "error">>
  ): Promise<PersistedJob> {
    const next = Object.freeze({ ...job, ...changes, updatedAt: this.now() });
    await this.saveJob(next);
    this.jobs.set(next.id, next);
    return next;
  }

  private async withScopeWriteLock(scope: MemoryScope, work: () => Promise<void>): Promise<boolean> {
    const previous = this.scopeTails.get(scope) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const local = new Promise<void>((resolvePromise) => { releaseLocal = resolvePromise; });
    const tail = previous.then(() => local);
    this.scopeTails.set(scope, tail);
    await previous;
    try {
      const lease = await this.acquireLease(`scope-${scope}`);
      if (!lease) return false;
      try {
        await work();
        return true;
      } finally {
        await this.releaseLease(lease);
      }
    } finally {
      releaseLocal();
      if (this.scopeTails.get(scope) === tail) this.scopeTails.delete(scope);
    }
  }

  private async acquireLease(name: string): Promise<Lease | undefined> {
    const directory = resolve(this.stateDirectory(), "memory-locks");
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, `${safeFilename(name)}.lock`);
    const owner = `${this.instanceId}:${name}`;
    const content = () => JSON.stringify({ owner, expiresAt: this.nowMs() + (this.options.leaseMs ?? DEFAULT_LEASE_MS) });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, "wx");
        try {
          await handle.writeFile(content(), "utf8");
        } finally {
          await handle.close();
        }
        return { path, owner };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const current = JSON.parse(await readFile(path, "utf8")) as { expiresAt?: unknown };
          if (typeof current.expiresAt === "number" && current.expiresAt > this.nowMs()) return undefined;
          await unlink(path);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        }
      }
    }
    return undefined;
  }

  private async releaseLease(lease: Lease): Promise<void> {
    try {
      const current = JSON.parse(await readFile(lease.path, "utf8")) as { owner?: unknown };
      if (current.owner === lease.owner) await unlink(lease.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private kindStatus(kind: MemoryJobKind): MemoryJobKindStatus {
    const jobs = [...this.jobs.values()].filter((job) => job.kind === kind);
    const failures = jobs.filter((job) => job.state === "failed").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return Object.freeze({
      pending: jobs.filter((job) => job.state === "pending").length,
      running: jobs.filter((job) => job.state === "running" || job.state === "prepared").length,
      succeeded: jobs.filter((job) => job.state === "succeeded").length,
      failed: failures.length,
      ...(failures[0]?.error || this.startupError ? { lastError: failures[0]?.error ?? this.startupError } : {}),
    });
  }

  private async saveJob(job: PersistedJob): Promise<void> {
    await atomicWrite(resolve(this.jobsDirectory(), `${job.id}.json`), `${JSON.stringify(job)}\n`);
  }

  private async readJob(id: string): Promise<PersistedJob> {
    return parseJob(JSON.parse(await readFile(resolve(this.jobsDirectory(), `${id}.json`), "utf8")));
  }

  private async readOrganizeState(scope: MemoryScope): Promise<OrganizeState> {
    try {
      const value = JSON.parse(await readFile(this.organizeStatePath(scope), "utf8")) as OrganizeState;
      return value.version === 1 ? value : { version: 1 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
      throw error;
    }
  }

  private async writeOrganizeState(scope: MemoryScope, state: OrganizeState): Promise<void> {
    const clean = Object.fromEntries(Object.entries({ ...state, version: 1 }).filter(([, value]) => value !== undefined));
    await atomicWrite(this.organizeStatePath(scope), `${JSON.stringify(clean)}\n`);
  }

  private jobsDirectory(): string {
    return resolve(this.stateDirectory(), "memory-jobs");
  }

  private organizeStatePath(scope: MemoryScope): string {
    return resolve(this.stateDirectory(), `memory-organize-${scope}.json`);
  }

  private stateDirectory(): string {
    return resolve(this.options.workspace, ".nekoder", "state");
  }

  private now(): string {
    return (this.options.clock?.() ?? new Date()).toISOString();
  }

  private nowMs(): number {
    return (this.options.clock?.() ?? new Date()).getTime();
  }

  private nextId(): string {
    return safeId(this.options.idFactory?.() ?? randomUUID(), "generated");
  }
}

function validateOperations(value: unknown): MemoryOperation[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Memory processor result must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "operations") || !Array.isArray(record.operations)) {
    throw new Error("Memory processor result may only contain an operations array");
  }
  if (record.operations.length > MAX_OPERATIONS) throw new Error(`Memory processor returned more than ${MAX_OPERATIONS} operations`);
  return record.operations.map((operation) => validateOperation(operation));
}

function validateOperation(value: unknown): MemoryOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Memory operation must be an object");
  const item = value as Record<string, unknown>;
  const kind = item.kind;
  if (kind === "add") {
    exactKeys(item, ["kind", "id", "markdown"]);
    return Object.freeze({ kind, id: memoryId(item.id), markdown: markdown(item.markdown) });
  }
  if (kind === "update") {
    exactKeys(item, ["kind", "id", "markdown", "expectedHash"], ["expectedHash"]);
    return Object.freeze({
      kind,
      id: memoryId(item.id),
      markdown: markdown(item.markdown),
      ...(item.expectedHash === undefined ? {} : { expectedHash: hash(item.expectedHash) }),
    });
  }
  if (kind === "supersede") {
    exactKeys(item, ["kind", "id", "supersededBy", "expectedHash"], ["supersededBy", "expectedHash"]);
    return Object.freeze({
      kind,
      id: memoryId(item.id),
      ...(item.supersededBy === undefined ? {} : { supersededBy: memoryId(item.supersededBy) }),
      ...(item.expectedHash === undefined ? {} : { expectedHash: hash(item.expectedHash) }),
    });
  }
  if (kind === "conflict") {
    exactKeys(item, ["kind", "ids"]);
    if (!Array.isArray(item.ids) || item.ids.length < 2) throw new Error("Conflict operation requires at least two IDs");
    return Object.freeze({ kind, ids: Object.freeze(item.ids.map(memoryId)) });
  }
  throw new Error(`Unsupported Memory operation: ${String(kind)}`);
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Memory operation contains unsupported fields");
  for (const key of allowed) {
    if (!optional.includes(key) && record[key] === undefined) throw new Error(`Memory operation is missing ${key}`);
  }
}

function memoryId(value: unknown): string {
  if (typeof value !== "string" || !MEMORY_ID.test(value)) throw new Error(`Invalid Memory Note ID: ${String(value)}`);
  return value;
}

function markdown(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Memory operation markdown must be non-empty");
  if (Buffer.byteLength(value, "utf8") > MAX_MARKDOWN_BYTES) throw new Error("Memory operation markdown exceeds 32 KiB");
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("Memory operation expectedHash must be SHA-256 hex");
  return value;
}

function normalizeJson(value: unknown): JsonValue {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("Memory job input must be JSON serializable");
  }
  if (encoded === undefined) throw new Error("Memory job input must be JSON serializable");
  if (Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES) throw new Error("Memory job input exceeds 256 KiB");
  return JSON.parse(encoded) as JsonValue;
}

function parseJob(value: unknown): PersistedJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid persisted Memory job");
  const job = value as PersistedJob;
  if (job.version !== 1 || !JOB_ID.test(job.id) || !["update", "organize"].includes(job.kind)) {
    throw new Error("Invalid persisted Memory job header");
  }
  if (!["pending", "running", "prepared", "succeeded", "failed"].includes(job.state) || !Array.isArray(job.requests)) {
    throw new Error("Invalid persisted Memory job state");
  }
  return job;
}

function recoverable(state: MemoryJobState): boolean {
  return state === "pending" || state === "running" || state === "prepared";
}

function receipt(job: PersistedJob): MemoryJobReceipt {
  return Object.freeze({ jobId: job.id, kind: job.kind, state: job.state });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeId(value: string, label: string): string {
  if (!JOB_ID.test(value)) throw new Error(`Invalid Memory ${label} ID: ${value}`);
  return value;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_CHARS);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
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

const defaultScheduler: MemoryJobScheduler = {
  schedule(task, delayMs = 0) {
    setTimeout(() => { void task().catch(() => undefined); }, delayMs);
  },
};
