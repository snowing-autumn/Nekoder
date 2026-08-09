export function isSensitiveWorkspacePath(
  path: string,
  configuredPatterns: readonly string[] = []
): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (configuredPatterns.some((pattern) => pathGlobMatches(pattern, normalized))) return true;
  const name = normalized.split("/").at(-1) ?? normalized;
  if (name === ".env.example" || name === ".env.sample") return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name === ".npmrc" || name === ".pypirc") return true;
  if (
    normalized === ".git/config"
    || normalized.endsWith("/.git/config")
    || normalized === ".git/credentials"
    || normalized.endsWith("/.git/credentials")
  ) return true;
  if (name === "id_rsa" || name === "id_ed25519") return true;
  if (name.endsWith(".key") || name.endsWith(".pem")) return true;
  return normalized === ".aws/credentials" ||
    normalized.endsWith("/.aws/credentials") ||
    normalized.startsWith(".azure/") ||
    normalized.includes("/.azure/") ||
    normalized.startsWith(".config/gcloud/") ||
    normalized.includes("/.config/gcloud/");
}

function pathGlobMatches(pattern: string, normalizedPath: string): boolean {
  const normalizedPattern = pattern.replaceAll("\\", "/").toLowerCase();
  const doubleStar = "\u0000";
  const source = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", doubleStar)
    .replaceAll("*", "[^/]*")
    .replaceAll(doubleStar, ".*");
  return new RegExp(`^${source}$`, "u").test(normalizedPath);
}
