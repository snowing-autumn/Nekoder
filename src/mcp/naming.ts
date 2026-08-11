import { createHash } from "node:crypto";

const MAX_TOOL_NAME = 64;

export function mcpToolName(server: string, remoteTool: string): string {
  const serverSlug = slug(server, "server");
  const toolSlug = slug(remoteTool, "tool");
  const base = `mcp_${serverSlug}_${toolSlug}`;
  const lossy = serverSlug !== server || toolSlug !== remoteTool;
  if (!lossy && base.length <= MAX_TOOL_NAME) return base;

  const hash = createHash("sha256")
    .update(`${server}\0${remoteTool}`)
    .digest("hex")
    .slice(0, 8);
  const readableLength = MAX_TOOL_NAME - hash.length - 1;
  const readable = base.slice(0, readableLength).replace(/_+$/u, "");
  return `${readable}_${hash}`;
}

function slug(value: string, fallback: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "") || fallback;
}
