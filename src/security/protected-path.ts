export type ProtectedWritePath = "permission_control_plane" | "git_metadata";

export function classifyProtectedWritePath(path: string): ProtectedWritePath | undefined {
  const normalized = path.replace(/\\/gu, "/").toLowerCase();
  if (
    normalized === ".nekoder/permissions.yaml"
    || normalized === ".nekoder/permissions.local.yaml"
  ) {
    return "permission_control_plane";
  }
  if (normalized === ".git" || normalized.startsWith(".git/")) {
    return "git_metadata";
  }
  return undefined;
}
