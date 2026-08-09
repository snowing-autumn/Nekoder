import type { AgentSession } from "../agent/session.js";
import type { AgentEvent, AgentRunHandle, TaskMode } from "../agent/types.js";
import type { ApprovalBroker, PendingApproval } from "./approval-broker.js";
import type { PermissionMode } from "../security/types.js";
import type { ApprovalDecision } from "../security/types.js";

export interface SessionSnapshot {
  readonly taskMode: TaskMode;
  readonly permissionMode: PermissionMode;
  readonly runStatus: "idle" | "running";
  readonly activePlanId?: string;
  readonly pendingApproval?: PendingApproval;
}

export type ControllerResult =
  | {
      readonly ok: true;
      readonly action: "mode_changed";
      readonly taskMode: TaskMode;
    }
  | {
      readonly ok: true;
      readonly action: "run_started";
      readonly agentRunId: string;
    }
  | {
      readonly ok: false;
      readonly code: "blank_input" | "run_active" | "no_active_plan";
      readonly message: string;
    };

export class SessionController {
  private snapshot: SessionSnapshot;
  private activeHandle: AgentRunHandle | undefined;
  private activeTask: Promise<void> | undefined;
  private readonly eventListeners = new Set<(event: AgentEvent) => void>();
  private readonly snapshotListeners = new Set<(snapshot: SessionSnapshot) => void>();
  private readonly unsubscribeApproval?: () => void;

  constructor(
    private readonly session: AgentSession,
    private readonly approvalBroker?: ApprovalBroker,
    permissionMode: PermissionMode = "default"
  ) {
    this.snapshot = { taskMode: "execute", permissionMode, runStatus: "idle" };
    this.unsubscribeApproval = approvalBroker?.subscribe((pendingApproval) => {
      this.setSnapshot({
        ...this.snapshot,
        ...(pendingApproval ? { pendingApproval } : { pendingApproval: undefined }),
      });
    });
  }

  getSnapshot(): SessionSnapshot {
    return { ...this.snapshot };
  }

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  subscribeEvents(listener: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  submit(rawText: string): ControllerResult {
    const command = rawText.trim();
    if (!command) {
      return { ok: false, code: "blank_input", message: "User input must not be blank" };
    }
    if (this.activeHandle) {
      return { ok: false, code: "run_active", message: "An agent run is already active" };
    }
    if (command === "/plan") {
      this.setSnapshot({ ...this.snapshot, taskMode: "plan" });
      return { ok: true, action: "mode_changed", taskMode: "plan" };
    }
    if (command === "/do") {
      if (!this.snapshot.activePlanId) {
        return { ok: false, code: "no_active_plan", message: "No active plan" };
      }
      const handle = this.session.executeActivePlan();
      this.setSnapshot({ ...this.snapshot, taskMode: "execute", runStatus: "running" });
      this.track(handle);
      return { ok: true, action: "run_started", agentRunId: handle.agentRunId };
    }

    const handle = this.session.startUserRun(rawText, this.snapshot.taskMode);
    this.setSnapshot({ ...this.snapshot, taskMode: this.snapshot.taskMode, runStatus: "running" });
    this.track(handle);
    return { ok: true, action: "run_started", agentRunId: handle.agentRunId };
  }

  cancelActiveRun(): void {
    this.activeHandle?.cancel();
  }

  resolveApproval(approved: boolean): boolean {
    const pending = this.approvalBroker?.getPending();
    return pending ? this.approvalBroker!.resolve(pending.requestId, approved) : false;
  }

  resolveApprovalDecision(decision: ApprovalDecision): boolean {
    const pending = this.approvalBroker?.getPending();
    return pending ? this.approvalBroker!.resolve(pending.requestId, decision) : false;
  }

  dispose(): void {
    this.cancelActiveRun();
    this.approvalBroker?.dispose();
    this.unsubscribeApproval?.();
  }

  whenIdle(): Promise<void> {
    return this.activeTask ?? Promise.resolve();
  }

  private track(handle: AgentRunHandle): void {
    this.activeHandle = handle;
    const task = (async () => {
      for await (const event of handle.events) {
        for (const listener of this.eventListeners) listener(event);
      }
      const outcome = await handle.result;
      this.setSnapshot({
        permissionMode: this.snapshot.permissionMode,
        taskMode: this.snapshot.taskMode,
        runStatus: "idle",
        ...(outcome.status === "completed" && outcome.activePlanId
          ? { activePlanId: outcome.activePlanId }
          : {}),
      });
    })().finally(() => {
      this.activeHandle = undefined;
      if (this.activeTask === task) this.activeTask = undefined;
    });
    this.activeTask = task;
  }

  private setSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.snapshotListeners) listener(this.getSnapshot());
  }
}
