import { loadPermissionConfig, type LoadedPermissionConfig } from "./permission-config.js";
import { SecurityPolicy } from "./policy.js";

export interface WorkspaceSecurity {
  readonly config: LoadedPermissionConfig;
  readonly policy: SecurityPolicy;
}

export function loadWorkspaceSecurity(
  workspace: string,
  options: { readonly homeDir?: string } = {}
): WorkspaceSecurity {
  const config = loadPermissionConfig(workspace, options);
  return {
    config,
    policy: new SecurityPolicy({ mode: config.mode, rules: config.rules }),
  };
}

export function createWorkspaceSecurityPolicy(
  workspace: string,
  options: { readonly homeDir?: string } = {}
): SecurityPolicy {
  return loadWorkspaceSecurity(workspace, options).policy;
}
