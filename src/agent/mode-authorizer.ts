import type {
  AuthorizationDecision,
  ToolAuthorizationRequest,
  ToolAuthorizer,
} from "../tools/runner.js";

export class ModeToolAuthorizer implements ToolAuthorizer {
  authorize(request: ToolAuthorizationRequest): AuthorizationDecision {
    if (request.taskMode === "execute") return "allow";
    if (request.effect === "read") return "allow";
    if (request.toolName === "run_command") return "require_approval";
    return "deny";
  }
}
