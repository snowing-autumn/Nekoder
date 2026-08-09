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
  private readonly listeners = new Set<(pending: PendingApproval | undefined) => void>();

  constructor(private readonly idFactory: () => string = () => crypto.randomUUID()) {}

  requestApproval(
    request: ToolAuthorizationRequest,
    authorizationDecision?: AskDecision
  ): Promise<ApprovalDecision> {
    if (this.pending) throw new Error("An approval request is already pending");
    if (request.signal?.aborted) return Promise.resolve({ kind: "deny" });

    return new Promise<ApprovalDecision>((resolve) => {
      const requestId = this.idFactory();
      const finish = (decision: ApprovalDecision): void => {
        if (this.pending?.requestId !== requestId) return;
        if (this.pending.onAbort && request.signal) {
          request.signal.removeEventListener("abort", this.pending.onAbort);
        }
        this.pending = undefined;
        this.notify();
        resolve(decision);
      };
      const onAbort = request.signal ? () => finish({ kind: "deny" }) : undefined;
      this.pending = {
        requestId,
        request,
        finish,
        ...(authorizationDecision ? { authorizationDecision } : {}),
        ...(onAbort ? { onAbort } : {}),
      };
      this.notify();
      if (onAbort) request.signal!.addEventListener("abort", onAbort, { once: true });
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
    this.pending?.finish({ kind: "deny" });
  }

  private notify(): void {
    const pending = this.getPending();
    for (const listener of this.listeners) listener(pending);
  }
}
