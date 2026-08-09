import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ToolResult } from "./types.js";

export interface PreparedPath {
  readonly requestedPath: string;
}

export function prepareWorkspacePath(
  workspace: string,
  inputPath: string
): ToolResult<PreparedPath> {
  const absolute = isAbsolute(inputPath) ? resolve(inputPath) : resolve(workspace, inputPath);
  const rel = relative(resolve(workspace), absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return pathOutside();
  }
  return {
    ok: true,
    data: { requestedPath: (rel || ".").split(sep).join("/") },
  };
}

export async function resolveExistingWorkspacePath(
  workspace: string,
  prepared: PreparedPath
): Promise<ToolResult<{ absolutePath: string; path: string; resolvedPath: string }>> {
  try {
    const realWorkspace = await realpath(workspace);
    const requested = resolve(workspace, prepared.requestedPath);
    const target = await realpath(requested);
    const rel = relative(realWorkspace, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return pathOutside();
    }
    return {
      ok: true,
      data: {
        absolutePath: target,
        path: prepared.requestedPath.split("\\").join("/"),
        resolvedPath: (rel || ".").split(sep).join("/"),
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return failure("not_found", "Path does not exist");
    return failure("filesystem_error", `Unable to resolve path: ${String(error)}`, true);
  }
}

export async function resolveWritableWorkspacePath(
  workspace: string,
  prepared: PreparedPath
): Promise<ToolResult<{ absolutePath: string; path: string; resolvedPath: string }>> {
  const requested = resolve(workspace, prepared.requestedPath);
  let existing = requested;
  const tail: string[] = [];
  for (;;) {
    try {
      const realWorkspace = await realpath(workspace);
      const realExisting = await realpath(existing);
      const target = tail.reduceRight((current, part) => join(current, part), realExisting);
      const rel = relative(realWorkspace, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return pathOutside();
      return {
        ok: true,
        data: {
          absolutePath: target,
          path: prepared.requestedPath.split("\\").join("/"),
          resolvedPath: (rel || ".").split(sep).join("/"),
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return failure("filesystem_error", `Unable to resolve path: ${String(error)}`, true);
      }
      const parent = dirname(existing);
      if (parent === existing) return pathOutside();
      tail.push(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      existing = parent;
    }
  }
}

export function failure(
  code: Parameters<typeof failureResult>[0],
  message: string,
  retryable = false,
  details?: unknown
): ToolResult<never> {
  return failureResult(code, message, retryable, details);
}

function failureResult(
  code: import("./types.js").ToolErrorCode,
  message: string,
  retryable: boolean,
  details?: unknown
): ToolResult<never> {
  return { ok: false, error: { code, message, retryable, ...(details === undefined ? {} : { details }) } };
}

function pathOutside(): ToolResult<never> {
  return failureResult(
    "path_outside_workspace",
    "Path resolves outside the workspace",
    false
  );
}
