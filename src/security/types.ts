export type PermissionMode =
  | "strict"
  | "plan"
  | "default"
  | "acceptEdit"
  | "permissive";

export type ApprovalScope =
  | "once"
  | "session"
  | "persistent_local"
  | "persistent_user";

export type PermissionRuleSource = "session" | "local" | "project" | "user";

export interface PermissionRuleMatch {
  readonly command?: string;
  readonly cwd?: string;
  readonly path?: string;
}

import type { Condition } from "../extensions/condition-matcher.js";

export interface PermissionRule {
  readonly id: string;
  readonly tool: string;
  readonly match: string | PermissionRuleMatch | Condition;
  readonly decision: "allow" | "deny";
  readonly comment?: string;
}

export type DecisionSource =
  | "permission_mode"
  | "session_rule"
  | "local_rule"
  | "project_rule"
  | "user_rule"
  | "mandatory_approval"
  | "security_invariant";

export type AuthorizationDecision =
  | {
      readonly kind: "allow";
      readonly source: DecisionSource;
      readonly ruleId?: string;
    }
  | {
      readonly kind: "deny";
      readonly source: DecisionSource;
      readonly reason: string;
      readonly ruleId?: string;
    }
  | {
      readonly kind: "ask";
      readonly source: DecisionSource;
      readonly reason: string;
      readonly allowedScopes: readonly ApprovalScope[];
    };

export type ApprovalDecision =
  | { readonly kind: "deny" }
  | { readonly kind: "allow_once" }
  | { readonly kind: "allow_session" }
  | {
      readonly kind: "create_rule";
      readonly scope: "local" | "user";
      readonly rule: PermissionRule;
    };
