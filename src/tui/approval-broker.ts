import type {
  ApprovalHandler,
  ToolAuthorizationRequest,
} from "../tools/runner.js";

export interface PendingApproval {
  readonly requestId: string;
  readonly request: ToolAuthorizationRequest;
}

interface PendingEntry extends PendingApproval {
  readonly finish: (approved: boolean) => void;
  readonly onAbort?: () => void;
}

export class ApprovalBroker implements ApprovalHandler {
  private pending: PendingEntry | undefined;
  private readonly listeners = new Set<(pending: PendingApproval | undefined) => void>();

  constructor(private readonly idFactory: () => string = () => crypto.randomUUID()) {}

  requestApproval(request: ToolAuthorizationRequest): Promise<boolean> {
    if (this.pending) throw new Error("An approval request is already pending");
    if (request.signal?.aborted) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const requestId = this.idFactory();
      const finish = (approved: boolean): void => {
        if (this.pending?.requestId !== requestId) return;
        if (this.pending.onAbort && request.signal) {
          request.signal.removeEventListener("abort", this.pending.onAbort);
        }
        this.pending = undefined;
        this.notify();
        resolve(approved);
      };
      const onAbort = request.signal ? () => finish(false) : undefined;
      this.pending = {
        requestId,
        request,
        finish,
        ...(onAbort ? { onAbort } : {}),
      };
      this.notify();
      if (onAbort) request.signal!.addEventListener("abort", onAbort, { once: true });
    });
  }

  getPending(): PendingApproval | undefined {
    if (!this.pending) return undefined;
    return { requestId: this.pending.requestId, request: this.pending.request };
  }

  resolve(requestId: string, approved: boolean): boolean {
    if (!this.pending || this.pending.requestId !== requestId) return false;
    this.pending.finish(approved);
    return true;
  }

  subscribe(listener: (pending: PendingApproval | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.pending?.finish(false);
  }

  private notify(): void {
    const pending = this.getPending();
    for (const listener of this.listeners) listener(pending);
  }
}
