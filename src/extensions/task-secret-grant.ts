import type { ApprovalDecision, AuthorizationDecision } from "../security/types.js";
import type { ToolAuthorizationRequest } from "../tools/runner.js";

type AskDecision = Extract<AuthorizationDecision, { readonly kind: "ask" }>;

export async function requestTaskSecretGrants(options: {
  readonly taskId: string;
  readonly names: readonly string[];
  readonly workspace: string;
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly requestApproval: (request: ToolAuthorizationRequest, decision: AskDecision) => Promise<boolean | ApprovalDecision>;
}): Promise<readonly string[]> {
  const environment = options.environment ?? process.env;
  const granted: string[] = [];
  for (const name of options.names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error(`Invalid Task Secret name: ${name}`);
    if (environment[name] === undefined) throw new Error(`Task Secret is unavailable in the host environment: ${name}`);
    const decision = await options.requestApproval({
      toolBatchId: `task-secret:${options.taskId}`,
      toolCallId: crypto.randomUUID(),
      toolName: "task_secret_grant",
      effect: "execute",
      preparedInput: { name },
      workspace: options.workspace,
      taskMode: "execute",
      authorizationTarget: { primary: `task-secret:${options.taskId}:${name}`, sensitive: true, maxApprovalScope: "once" },
      ...(options.signal ? { signal: options.signal } : {}),
    }, {
      kind: "ask",
      source: "mandatory_approval",
      reason: `SubAgent requests Task Secret '${name}' for host execution only`,
      allowedScopes: ["once"],
    });
    if (decision === false || (decision !== true && decision.kind !== "allow_once")) throw new Error(`Task Secret grant was denied: ${name}`);
    granted.push(name);
  }
  return Object.freeze(granted);
}

export function grantedSecretEnvironment(
  names: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(names.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]!]])));
}
