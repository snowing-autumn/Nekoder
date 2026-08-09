import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Tool } from "./types.js";
import {
  failure,
  prepareWorkspacePath,
  resolveWritableWorkspacePath,
  type PreparedPath,
} from "./workspace.js";

interface WriteFileInput {
  readonly path: string;
  readonly content: string;
  readonly overwrite?: boolean;
  readonly expectedHash?: string;
}

interface PreparedWriteFile extends PreparedPath {
  readonly content: string;
  readonly overwrite: boolean;
  readonly expectedHash?: string;
}

export const writeFileTool: Tool<WriteFileInput, PreparedWriteFile, unknown> = {
  name: "write_file",
  description: "Create or atomically replace a UTF-8 text file in the workspace.",
  effect: "write",
  timeoutMs: 10_000,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      content: { type: "string", maxLength: 1_048_576 },
      overwrite: { type: "boolean" },
      expectedHash: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async prepare(input, context) {
    const path = prepareWorkspacePath(context.workspace, input.path);
    if (!path.ok) return path;
    if (input.overwrite === true && input.expectedHash === undefined) {
      return failure("invalid_input", "expectedHash is required when overwrite is true");
    }
    return {
      ok: true,
      data: {
        ...path.data,
        content: input.content,
        overwrite: input.overwrite ?? false,
        ...(input.expectedHash === undefined ? {} : { expectedHash: input.expectedHash.toLowerCase() }),
      },
    };
  },
  async execute(prepared, context) {
    const resolved = await resolveWritableWorkspacePath(context.workspace, prepared);
    if (!resolved.ok) return resolved;
    const target = resolved.data.absolutePath;
    let existed = false;
    let mode: number | undefined;
    try {
      const info = await stat(target);
      if (!info.isFile()) return failure("not_a_file", "Path is not a file");
      existed = true;
      mode = info.mode;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return failure("filesystem_error", `Unable to inspect file: ${String(error)}`, true);
      }
    }
    if (existed && !prepared.overwrite) return failure("conflict", "File already exists");
    if (!existed && prepared.expectedHash !== undefined) {
      return failure("content_changed", "Expected file no longer exists");
    }
    if (existed) {
      const current = await readFile(target);
      const hash = createHash("sha256").update(current).digest("hex");
      if (hash !== prepared.expectedHash) return failure("content_changed", "File content has changed");
    }

    await mkdir(dirname(target), { recursive: true });
    const temp = join(dirname(target), `.nekoder-${randomBytes(12).toString("hex")}.tmp`);
    const bytes = Buffer.from(prepared.content, "utf8");
    try {
      await writeFile(temp, bytes, { flag: "wx" });
      if (mode !== undefined) await chmod(temp, mode);
      if (existed) {
        const current = await readFile(target);
        const hash = createHash("sha256").update(current).digest("hex");
        if (hash !== prepared.expectedHash) {
          await unlink(temp).catch(() => undefined);
          return failure("content_changed", "File content changed before replacement");
        }
      }
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      return failure("filesystem_error", `Unable to write file: ${String(error)}`, true);
    }
    return {
      ok: true,
      data: {
        path: resolved.data.path,
        action: existed ? "overwritten" : "created",
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  },
};
