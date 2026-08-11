import type { ToolAuthorizationRequest } from "../tools/runner.js";
import type {
  ApprovalScope,
  AuthorizationDecision,
  DecisionSource,
  PermissionRule,
  PermissionRuleSource,
  PermissionMode,
} from "./types.js";

export interface SecurityPolicyOptions {
  readonly mode: PermissionMode;
  readonly rules?: Partial<Record<PermissionRuleSource, readonly PermissionRule[]>>;
}

export class SecurityPolicy {
  private mode: PermissionMode;

  constructor(private readonly options: SecurityPolicyOptions) {
    this.mode = options.mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  authorize(request: ToolAuthorizationRequest): AuthorizationDecision {
    if (request.authorizationTarget?.protectedWritePath === "permission_control_plane") {
      return {
        kind: "deny",
        source: "security_invariant",
        reason: "Permission Control Plane files cannot be modified by Agent file tools",
      };
    }
    if (request.authorizationTarget?.protectedWritePath === "git_metadata") {
      return {
        kind: "deny",
        source: "security_invariant",
        reason: "Git metadata cannot be modified by Agent file tools",
      };
    }
    if (request.authorizationTarget?.dangerous === true) {
      return {
        kind: "deny",
        source: "security_invariant",
        reason: "Dangerous Operation Blacklist denied the operation",
      };
    }
    if (request.authorizationTarget?.dynamic === true) {
      return ask(
        request,
        ["once"],
        "mandatory_approval",
        "Dynamic command requires one-time approval"
      );
    }
    if (request.authorizationTarget?.sensitive === true) {
      const scopes: readonly ApprovalScope[] =
        this.mode === "strict" || this.mode === "plan"
          ? ["once"]
          : ["once", "session"];
      return ask(request, scopes, "mandatory_approval", "Sensitive Read requires approval");
    }
    const ruleDecision = this.ruleDecision(request);
    if (request.taskMode === "plan") {
      if (request.effect === "write") {
        return {
          kind: "deny",
          source: "permission_mode",
          reason: "write operations are forbidden in Plan Task Mode",
        };
      }
      if (request.effect === "execute") {
        return ruleDecision?.kind === "deny" ? ruleDecision : ask(request, ["once"]);
      }
    }
    if (this.mode === "strict") {
      return ruleDecision?.kind === "deny" ? ruleDecision : ask(request, ["once"]);
    }
    if (this.mode === "plan") {
      if (request.effect === "write") {
        return {
          kind: "deny",
          source: "permission_mode",
          reason: "write operations are forbidden in plan permission mode",
        };
      }
      if (request.effect === "execute") {
        return ruleDecision?.kind === "deny" ? ruleDecision : ask(request, ["once"]);
      }
    }
    if (ruleDecision) return ruleDecision;
    switch (this.mode) {
      case "plan":
        return allow();
      case "default":
        return request.effect === "read" ? allow() : ask(request);
      case "acceptEdit":
        return request.effect === "execute" ? ask(request) : allow();
      case "permissive":
        return allow();
    }
  }

  private ruleDecision(request: ToolAuthorizationRequest): AuthorizationDecision | undefined {
    const primary = request.authorizationTarget?.primary;
    if (primary === undefined) return undefined;
    const targets = request.authorizationTarget?.commands ?? [primary];
    const decisions = targets.map((target) => this.ruleDecisionForTarget(request, target));
    const denied = decisions.find(
      (decision): decision is Extract<AuthorizationDecision, { readonly kind: "deny" }> =>
        decision?.kind === "deny"
    );
    if (denied) return denied;
    if (decisions.length > 0 && decisions.every((decision) => decision?.kind === "allow")) {
      return decisions[0];
    }
    return undefined;
  }

  private ruleDecisionForTarget(
    request: ToolAuthorizationRequest,
    target: string
  ): AuthorizationDecision | undefined {
    for (const source of ["session", "local", "project", "user"] as const) {
      const rule = bestRule(
        this.options.rules?.[source] ?? [],
        request.toolName,
        target,
        request.authorizationTarget?.cwd
      );
      if (!rule) continue;
      const decisionSource = `${source}_rule` as const;
      return rule.decision === "allow"
        ? { kind: "allow", source: decisionSource, ruleId: rule.id }
        : {
            kind: "deny",
            source: decisionSource,
            ruleId: rule.id,
            reason: `Permission Rule ${rule.id} denied the operation`,
          };
    }
    return undefined;
  }
}

function bestRule(
  rules: readonly PermissionRule[],
  toolName: string,
  target: string,
  cwd?: string
): PermissionRule | undefined {
  return rules
    .filter((rule) => rule.tool === toolName && ruleMatches(rule, toolName, target, cwd))
    .sort(compareSpecificity)[0];
}

function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  target: string,
  cwd?: string
): boolean {
  if (typeof rule.match === "string") {
    return toolName === "run_command"
      ? commandGlobMatches(rule.match, target)
      : pathGlobMatches(rule.match, target);
  }
  if (rule.match.command !== undefined && !commandGlobMatches(rule.match.command, target)) return false;
  if (rule.match.path !== undefined && !pathGlobMatches(rule.match.path, target)) return false;
  if (rule.match.cwd !== undefined && (cwd === undefined || !pathGlobMatches(rule.match.cwd, cwd))) return false;
  return true;
}

function compareSpecificity(left: PermissionRule, right: PermissionRule): number {
  const a = specificity(left.match);
  const b = specificity(right.match);
  if (a.exact !== b.exact) return b.exact - a.exact;
  if (a.literalSegments !== b.literalSegments) {
    return b.literalSegments - a.literalSegments;
  }
  if (a.wildcards !== b.wildcards) return a.wildcards - b.wildcards;
  if (left.decision !== right.decision) return left.decision === "deny" ? -1 : 1;
  return left.id.localeCompare(right.id);
}

function specificity(pattern: PermissionRule["match"]): {
  exact: number;
  literalSegments: number;
  wildcards: number;
} {
  const patterns = typeof pattern === "string"
    ? [pattern]
    : Object.values(pattern).filter((value): value is string => value !== undefined);
  const wildcards = patterns.reduce(
    (total, value) => total + [...value].filter((character) => character === "*").length,
    0
  );
  return {
    exact: wildcards === 0 ? 1 : 0,
    literalSegments: patterns.reduce(
      (total, value) => total + value
        .split(/[\s/]+/u)
        .filter((segment) => segment.length > 0 && !segment.includes("*"))
        .length,
      0
    ),
    wildcards,
  };
}

function commandGlobMatches(pattern: string, target: string): boolean {
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${source}$`, "u").test(target);
}

function pathGlobMatches(pattern: string, target: string): boolean {
  const doubleStar = "\u0000";
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", doubleStar)
    .replaceAll("*", "[^/]*")
    .replaceAll(doubleStar, ".*");
  return new RegExp(`^${source}$`, process.platform === "win32" ? "iu" : "u").test(target);
}

function allow(): AuthorizationDecision {
  return { kind: "allow", source: "permission_mode" };
}

function ask(
  request: ToolAuthorizationRequest,
  allowedScopes: readonly ApprovalScope[] = [
    "once",
    "session",
    "persistent_local",
    "persistent_user",
  ],
  source: DecisionSource = "permission_mode",
  reason = `${request.effect} operations require approval in ${request.taskMode} task mode`
): AuthorizationDecision {
  return {
    kind: "ask",
    source,
    reason,
    allowedScopes: capApprovalScopes(allowedScopes, request.authorizationTarget?.maxApprovalScope),
  };
}

function capApprovalScopes(
  scopes: readonly ApprovalScope[],
  maximum: "once" | "session" | "persistent" | undefined
): readonly ApprovalScope[] {
  if (maximum === undefined || maximum === "persistent") return scopes;
  if (maximum === "session") {
    return scopes.filter((scope) => scope === "once" || scope === "session");
  }
  return scopes.filter((scope) => scope === "once");
}
