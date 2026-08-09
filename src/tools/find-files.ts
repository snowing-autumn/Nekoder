import { readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { Tool } from "./types.js";
import {
  failure,
  prepareWorkspacePath,
  resolveExistingWorkspacePath,
  type PreparedPath,
} from "./workspace.js";

interface FindFilesInput {
  readonly pattern: string;
  readonly path?: string;
  readonly caseSensitive?: boolean;
}

interface PreparedFindFiles extends PreparedPath {
  readonly pattern: string;
  readonly caseSensitive: boolean;
}

const DEFAULT_SKIP_DIRS = ["node_modules", "dist", "build", "coverage"] as const;

export function createFindFilesTool(
  skipDirs: readonly string[] = DEFAULT_SKIP_DIRS
): Tool<FindFilesInput, PreparedFindFiles, unknown> {
  const excludedDirs = new Set([...skipDirs, ".git"]);
  return {
  name: "find_files",
  description: "Find workspace files whose relative paths match a glob.",
  effect: "read",
  timeoutMs: 30_000,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 1, maxLength: 4096 },
      path: { type: "string", minLength: 1 },
      caseSensitive: { type: "boolean" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async prepare(input, context) {
    if (!input.pattern.trim() || /[{}\\]/.test(input.pattern) || input.pattern.startsWith("!")) {
      return failure("invalid_input", "Unsupported or empty glob pattern");
    }
    const path = prepareWorkspacePath(context.workspace, input.path ?? ".");
    if (!path.ok) return path;
    return {
      ok: true,
      data: { ...path.data, pattern: input.pattern, caseSensitive: input.caseSensitive ?? true },
    };
  },
  async authorizationTarget(prepared, context) {
    const resolved = await resolveExistingWorkspacePath(context.workspace, prepared);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      data: {
        primary: resolved.data.resolvedPath,
        requestedPath: prepared.requestedPath,
        resolvedPath: resolved.data.resolvedPath,
      },
    };
  },
  async execute(prepared, context) {
    const start = await resolveExistingWorkspacePath(context.workspace, prepared);
    if (!start.ok) return start;
    try {
      const startInfo = await stat(start.data.absolutePath);
      if (!startInfo.isDirectory()) return failure("not_a_file", "Search path is not a directory");
      const matcher = new Bun.Glob(prepared.caseSensitive ? prepared.pattern : prepared.pattern.toLowerCase());
      const matches: Array<{ path: string; isSymlink: boolean }> = [];
      const warnings: Array<{ path: string; code: string }> = [];
      const visit = async (absoluteDir: string, localDir: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(absoluteDir, { withFileTypes: true });
        } catch {
          warnings.push({ path: localDir || ".", code: "unreadable" });
          return;
        }
        for (const entry of entries) {
          if (context.signal?.aborted) return;
          const local = localDir ? `${localDir}/${entry.name}` : entry.name;
          const absolute = join(absoluteDir, entry.name);
          if (entry.isDirectory()) {
            if (!excludedDirs.has(entry.name)) await visit(absolute, local);
            continue;
          }
          if (entry.isSymbolicLink()) {
            try {
              const target = await realpath(absolute);
              const targetRelative = relative(await realpath(context.workspace), target);
              if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`)) {
                warnings.push({ path: local, code: "path_outside_workspace" });
                continue;
              }
              if ((await stat(target)).isDirectory()) continue;
            } catch {
              warnings.push({ path: local, code: "unreadable" });
              continue;
            }
          } else if (!entry.isFile()) {
            continue;
          }
          const candidate = prepared.caseSensitive ? local : local.toLowerCase();
          if (matcher.match(candidate)) {
            matches.push({
              path: start.data.path === "." ? local : `${start.data.path}/${local}`,
              isSymlink: entry.isSymbolicLink(),
            });
          }
        }
      };
      await visit(start.data.absolutePath, "");
      matches.sort((a, b) => a.path.localeCompare(b.path));
      const limited = matches.slice(0, 1000);
      return {
        ok: true,
        data: {
          matches: limited,
          truncated: matches.length > limited.length,
          incomplete: warnings.length > 0,
          warnings: warnings.slice(0, 20),
          warningCount: warnings.length,
        },
      };
    } catch (error) {
      return failure("filesystem_error", `Unable to find files: ${String(error)}`, true);
    }
  },
  };
}

export const findFilesTool = createFindFilesTool();
