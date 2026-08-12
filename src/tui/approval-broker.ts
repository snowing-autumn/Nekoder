import type {
  ApprovalHandler,
  ToolAuthorizationRequest,
} from "../tools/runner.js";
import type { ApprovalDecision, AuthorizationDecision } from "../security/types.js";

type AskDecision = Extract<AuthorizationDecision, { readonly kind: "ask" }>;

export interface PendingApproval {
  readonly requestId: string;
  readonly request: ToolAuthorizationRequest;
  readonly authorizationDecision?: AskDecision;
}

interface PendingEntry extends PendingApproval {
  readonly finish: (decision: ApprovalDecision) => void;
  readonly onAbort?: () => void;
}

export class ApprovalBroker implements ApprovalHandler {
  private pending: PendingEntry | undefined;
  private readonly queue: PendingEntry[] = [];
  private readonly listeners = new Set<(pending: PendingApproval | undefined) => void>();

  constructor(private readonly idFactory: () => string = () => crypto.randomUUID()) {}

  requestApproval(
    request: ToolAuthorizationRequest,
    authorizationDecision?: AskDecision
  ): Promise<ApprovalDecision> {
    if (request.signal?.aborted) return Promise.resolve({ kind: "deny" });

    return new Promise<ApprovalDecision>((resolve) => {
      const requestId = this.idFactory();
      const finish = (decision: ApprovalDecision): void => this.finish(requestId, decision, resolve);
      const onAbort = request.signal ? () => finish({ kind: "deny" }) : undefined;
      const entry: PendingEntry = {
        requestId,
        request,
        finish,
        ...(authorizationDecision ? { authorizationDecision } : {}),
        ...(onAbort ? { onAbort } : {}),
      };
      if (onAbort) request.signal!.addEventListener("abort", onAbort, { once: true });
      if (this.pending) this.queue.push(entry);
      else {
        this.pending = entry;
        this.notify();
      }
    });
  }

  getPending(): PendingApproval | undefined {
    if (!this.pending) return undefined;
    return {
      requestId: this.pending.requestId,
      request: this.pending.request,
      ...(this.pending.authorizationDecision
        ? { authorizationDecision: this.pending.authorizationDecision }
        : {}),
    };
  }

  resolve(requestId: string, decision: boolean | ApprovalDecision): boolean {
    if (!this.pending || this.pending.requestId !== requestId) return false;
    this.pending.finish(
      typeof decision === "boolean"
        ? { kind: decision ? "allow_once" : "deny" }
        : decision
    );
    return true;
  }

  subscribe(listener: (pending: PendingApproval | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    while (this.pending) this.pending.finish({ kind: "deny" });
  }

  private finish(
    requestId: string,
    decision: ApprovalDecision,
    resolve: (decision: ApprovalDecision) => void
  ): void {
    const active = this.pending?.requestId === requestId;
    const queuedIndex = active ? -1 : this.queue.findIndex((entry) => entry.requestId === requestId);
    const entry = active ? this.pending : queuedIndex >= 0 ? this.queue[queuedIndex] : undefined;
    if (!entry) return;
    if (entry.onAbort && entry.request.signal) entry.request.signal.removeEventListener("abort", entry.onAbort);
    if (active) {
      this.pending = this.queue.shift();
      this.notify();
    } else {
      this.queue.splice(queuedIndex, 1);
    }
    resolve(decision);
  }

  private notify(): void {
    const pending = this.getPending();
    for (const listener of this.listeners) listener(pending);
  }
}
