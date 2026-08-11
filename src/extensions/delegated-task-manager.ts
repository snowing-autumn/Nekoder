export type DelegatedTaskStatus =
  | "queued" | "provisioning" | "running" | "waiting_approval"
  | "completed" | "failed" | "cancelled" | "interrupted";
export type DelegatedTaskTerminalStatus = "completed" | "failed" | "cancelled" | "interrupted";

export interface DelegatedTaskRequest {
  readonly caller: "root" | "trusted_root_hook" | "subagent";
  readonly kind: "defined" | "fork";
  readonly agent?: string;
  readonly prompt: string;
  readonly mode?: "foreground" | "background";
  readonly isolation?: "shared" | "worktree";
  readonly parentSessionId?: string;
  readonly forkHistory?: readonly import("ai").ModelMessage[];
  readonly inheritedSkills?: readonly string[];
}

export interface DelegatedTaskResult {
  readonly summary: string;
  readonly usage?: Readonly<Record<string, number>>;
  readonly artifacts?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly tests?: readonly string[];
  readonly worktree?: string;
  readonly worktreeDetails?: import("./worktree-manager.js").WorktreeInspection;
  readonly worktreeCleanedUp?: boolean;
}

export interface DelegatedTask {
  readonly id: string;
  readonly kind: "defined" | "fork";
  readonly agent?: string;
  readonly prompt: string;
  readonly mode: "foreground" | "background";
  readonly isolation: "shared" | "worktree";
  readonly parentSessionId?: string;
  readonly status: DelegatedTaskStatus;
  readonly version: number;
  readonly progress?: string;
  readonly phase?: string;
  readonly artifacts: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: DelegatedTaskResult;
  readonly error?: string;
}

export interface DelegatedTaskContext {
  readonly signal: AbortSignal;
  readonly forkHistory?: readonly import("ai").ModelMessage[];
  readonly inheritedSkills?: readonly string[];
  update(request: TaskUpdate): DelegatedTask;
  waitForApproval<T>(request: () => Promise<T>): Promise<T>;
}

export type DelegatedTaskExecutor = (task: DelegatedTask, context: DelegatedTaskContext) => Promise<DelegatedTaskResult>;

export interface DelegatedTaskManagerOptions {
  readonly executor: DelegatedTaskExecutor;
  readonly maxRunning?: number;
  readonly maxQueued?: number;
  readonly idFactory?: () => string;
  readonly clock?: () => number;
  readonly onTerminal?: (task: DelegatedTask) => void | Promise<void>;
}

export interface TaskUpdate {
  readonly expectedVersion: number;
  readonly progress?: string;
  readonly phase?: string;
  readonly artifacts?: readonly string[];
}

interface MutableTask {
  id: string; kind: "defined" | "fork"; agent?: string; prompt: string;
  mode: "foreground" | "background"; isolation: "shared" | "worktree"; parentSessionId?: string;
  status: DelegatedTaskStatus; version: number; progress?: string; phase?: string; artifacts: string[];
  createdAt: string; updatedAt: string; result?: DelegatedTaskResult; error?: string;
  controller: AbortController; lastModelUpdate?: number; suspended?: boolean; resume?: () => void;
  forkHistory?: readonly import("ai").ModelMessage[]; inheritedSkills?: readonly string[];
}

const TERMINAL = new Set<DelegatedTaskStatus>(["completed", "failed", "cancelled", "interrupted"]);

export class DelegatedTaskManager {
  private readonly tasks = new Map<string, MutableTask>();
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();
  private readonly terminalWaiters = new Map<string, Array<(task: DelegatedTask) => void>>();
  private readonly terminalEffects = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly options: DelegatedTaskManagerOptions) {
    const maxRunning = options.maxRunning ?? 5;
    const maxQueued = options.maxQueued ?? 20;
    if (!Number.isInteger(maxRunning) || maxRunning < 1) throw new Error("maxRunning must be positive");
    if (!Number.isInteger(maxQueued) || maxQueued < 0) throw new Error("maxQueued must be non-negative");
  }

  async create(request: DelegatedTaskRequest): Promise<DelegatedTask> {
    if (this.closed) throw new Error("Delegated Task Manager is closed");
    if (request.caller !== "root" && request.caller !== "trusted_root_hook") throw new Error("Only Root Agent or a trusted Root Hook may create a SubAgent");
    if (request.kind === "defined" && !request.agent) throw new Error("Defined delegation requires an agent name");
    const capacity = this.options.maxRunning ?? 5;
    if (this.running.size >= capacity && this.queue.length >= (this.options.maxQueued ?? 20)) throw new Error("Delegated Task queue is full");
    const now = this.isoNow();
    const id = this.options.idFactory?.() ?? crypto.randomUUID();
    const task: MutableTask = {
      id, kind: request.kind, ...(request.agent ? { agent: request.agent } : {}), prompt: request.prompt,
      mode: request.kind === "fork" ? "background" : request.mode ?? "foreground",
      isolation: request.isolation ?? "shared", ...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {}),
      status: "queued", version: 1, artifacts: [], createdAt: now, updatedAt: now, controller: new AbortController(),
      ...(request.forkHistory ? { forkHistory: request.forkHistory } : {}),
      ...(request.inheritedSkills ? { inheritedSkills: request.inheritedSkills } : {}),
    };
    this.tasks.set(id, task);
    this.queue.push(id);
    this.pump();
    return snapshot(task);
  }

  list(): readonly DelegatedTask[] {
    return Object.freeze([...this.tasks.values()].map(snapshot));
  }

  get(id: string): DelegatedTask | undefined {
    const task = this.tasks.get(id);
    return task ? snapshot(task) : undefined;
  }

  restoreTerminal(value: DelegatedTask): void {
    if (!TERMINAL.has(value.status)) throw new Error("Only terminal delegated tasks can be restored");
    if (this.tasks.has(value.id)) return;
    this.tasks.set(value.id, {
      id: value.id, kind: value.kind, ...(value.agent ? { agent: value.agent } : {}), prompt: value.prompt,
      mode: value.mode, isolation: value.isolation, ...(value.parentSessionId ? { parentSessionId: value.parentSessionId } : {}),
      status: value.status, version: value.version, ...(value.progress === undefined ? {} : { progress: value.progress }),
      ...(value.phase === undefined ? {} : { phase: value.phase }), artifacts: [...value.artifacts], createdAt: value.createdAt,
      updatedAt: value.updatedAt, ...(value.result ? { result: value.result } : {}), ...(value.error ? { error: value.error } : {}),
      controller: new AbortController(),
    });
  }

  wait(id: string): Promise<DelegatedTask> {
    const task = this.require(id);
    if (TERMINAL.has(task.status)) return Promise.resolve(snapshot(task));
    return new Promise((resolve) => {
      const waiters = this.terminalWaiters.get(id) ?? [];
      waiters.push(resolve);
      this.terminalWaiters.set(id, waiters);
    });
  }

  update(id: string, request: TaskUpdate): DelegatedTask {
    const task = this.require(id);
    if (TERMINAL.has(task.status)) throw new Error("Cannot update a terminal task");
    if (request.expectedVersion !== task.version) throw new Error(`Task version conflict: expected ${request.expectedVersion}, current ${task.version}`);
    const now = this.now();
    if (task.lastModelUpdate !== undefined && now - task.lastModelUpdate < 1000) throw new Error("task_update rate limit is one update per second");
    for (const value of [request.progress, request.phase]) {
      if (value !== undefined && Buffer.byteLength(value, "utf8") > 4 * 1024) throw new Error("task_update text exceeds 4 KiB");
    }
    if (request.artifacts && request.artifacts.length > 16) throw new Error("task_update accepts at most 16 artifact references");
    if (request.progress !== undefined) task.progress = request.progress;
    if (request.phase !== undefined) task.phase = request.phase;
    if (request.artifacts !== undefined) task.artifacts = [...request.artifacts];
    task.version++;
    task.lastModelUpdate = now;
    task.updatedAt = new Date(now).toISOString();
    return snapshot(task);
  }

  cancel(id: string): DelegatedTask {
    const task = this.require(id);
    if (TERMINAL.has(task.status)) return snapshot(task);
    task.controller.abort();
    this.removeQueued(id);
    this.running.delete(id);
    this.terminal(task, "cancelled");
    task.resume?.();
    this.pump();
    return snapshot(task);
  }

  moveToBackground(id: string): DelegatedTask {
    const task = this.require(id);
    if (TERMINAL.has(task.status)) return snapshot(task);
    task.mode = "background";
    task.version++;
    task.updatedAt = this.isoNow();
    return snapshot(task);
  }

  async cancelAll(): Promise<void> {
    for (const task of this.tasks.values()) if (!TERMINAL.has(task.status)) this.cancel(task.id);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks.values()) {
      if (TERMINAL.has(task.status)) continue;
      task.controller.abort();
      this.removeQueued(task.id);
      this.running.delete(task.id);
      this.terminal(task, "interrupted");
      task.resume?.();
    }
    await Promise.allSettled([...this.terminalEffects]);
  }

  private pump(): void {
    const capacity = this.options.maxRunning ?? 5;
    while (!this.closed && this.running.size < capacity && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const task = this.tasks.get(id);
      if (!task || TERMINAL.has(task.status)) continue;
      this.running.add(id);
      task.status = "running";
      task.updatedAt = this.isoNow();
      if (task.suspended) {
        task.suspended = false;
        const resume = task.resume;
        task.resume = undefined;
        resume?.();
      } else {
        task.status = "provisioning";
        queueMicrotask(() => this.execute(task));
      }
    }
  }

  private async execute(task: MutableTask): Promise<void> {
    if (TERMINAL.has(task.status)) return;
    task.status = "running";
    task.updatedAt = this.isoNow();
    try {
      const result = await this.options.executor(snapshot(task), {
        signal: task.controller.signal,
        ...(task.forkHistory ? { forkHistory: task.forkHistory } : {}),
        ...(task.inheritedSkills ? { inheritedSkills: task.inheritedSkills } : {}),
        update: (request) => this.update(task.id, request),
        waitForApproval: (request) => this.waitForApproval(task, request),
      });
      if (TERMINAL.has(task.status)) return;
      task.result = Object.freeze({ ...result, artifacts: result.artifacts ? Object.freeze([...result.artifacts]) : undefined });
      task.artifacts = [...new Set([...task.artifacts, ...(result.artifacts ?? [])])].slice(0, 16);
      this.terminal(task, "completed");
    } catch (error) {
      if (TERMINAL.has(task.status)) return;
      task.error = String(error);
      this.terminal(task, task.controller.signal.aborted ? "cancelled" : "failed");
    } finally {
      this.running.delete(task.id);
      this.pump();
    }
  }

  private async waitForApproval<T>(task: MutableTask, request: () => Promise<T>): Promise<T> {
    if (TERMINAL.has(task.status)) throw new Error("Task is terminal");
    task.status = "waiting_approval";
    task.updatedAt = this.isoNow();
    this.running.delete(task.id);
    this.pump();
    const decision = await request();
    if (TERMINAL.has(task.status)) return decision;
    task.status = "queued";
    task.suspended = true;
    const reacquired = new Promise<void>((resolve) => { task.resume = resolve; });
    this.queue.push(task.id);
    this.pump();
    await reacquired;
    return decision;
  }

  private terminal(task: MutableTask, status: DelegatedTaskTerminalStatus): void {
    if (TERMINAL.has(task.status)) return;
    task.status = status;
    task.version++;
    task.updatedAt = this.isoNow();
    const value = snapshot(task);
    for (const resolve of this.terminalWaiters.get(task.id) ?? []) resolve(value);
    this.terminalWaiters.delete(task.id);
    const effect = Promise.resolve(this.options.onTerminal?.(value)).then(() => undefined);
    this.terminalEffects.add(effect);
    void effect.finally(() => this.terminalEffects.delete(effect));
  }

  private require(id: string): MutableTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  private removeQueued(id: string): void {
    let index;
    while ((index = this.queue.indexOf(id)) >= 0) this.queue.splice(index, 1);
  }

  private now(): number { return this.options.clock?.() ?? Date.now(); }
  private isoNow(): string { return new Date(this.now()).toISOString(); }
}

function snapshot(task: MutableTask): DelegatedTask {
  return Object.freeze({
    id: task.id, kind: task.kind, ...(task.agent ? { agent: task.agent } : {}), prompt: task.prompt,
    mode: task.mode, isolation: task.isolation, ...(task.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
    status: task.status, version: task.version, ...(task.progress === undefined ? {} : { progress: task.progress }),
    ...(task.phase === undefined ? {} : { phase: task.phase }), artifacts: Object.freeze([...task.artifacts]),
    createdAt: task.createdAt, updatedAt: task.updatedAt, ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.error === undefined ? {} : { error: task.error }),
  });
}
