import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type { Tool } from "./types.js";
import {
  failure,
  prepareWorkspacePath,
  resolveExistingWorkspacePath,
  type PreparedPath,
} from "./workspace.js";

interface ReadFileInput {
  readonly path: string;
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly maxLines?: number;
}

interface PreparedReadFile extends PreparedPath {
  readonly startLine: number;
  readonly startColumn: number;
  readonly maxLines: number;
}

export const readFileTool: Tool<ReadFileInput, PreparedReadFile, unknown> = {
  name: "read_file",
  description: "Read a bounded page of a UTF text file in the workspace.",
  effect: "read",
  timeoutMs: 10_000,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      startLine: { type: "integer", minimum: 1 },
      startColumn: { type: "integer", minimum: 1 },
      maxLines: { type: "integer", minimum: 1, maximum: 2000 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async prepare(input, context) {
    const path = prepareWorkspacePath(context.workspace, input.path);
    if (!path.ok) return path;
    return {
      ok: true,
      data: {
        ...path.data,
        startLine: input.startLine ?? 1,
        startColumn: input.startColumn ?? 1,
        maxLines: input.maxLines ?? 2000,
      },
    };
  },
  async execute(prepared, context) {
    const resolved = await resolveExistingWorkspacePath(context.workspace, prepared);
    if (!resolved.ok) return resolved;
    try {
      const before = await stat(resolved.data.absolutePath, { bigint: true });
      if (!before.isFile()) return failure("not_a_file", "Path is not a file");
      if (before.size > 20n * 1024n * 1024n) {
        return failure("file_too_large", "File exceeds the 20 MiB read limit");
      }
      const bytes = await readFile(resolved.data.absolutePath);
      const after = await stat(resolved.data.absolutePath, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs
      ) {
        return failure("file_changed_during_read", "File changed while it was being read", true);
      }
      const decoded = decodeText(bytes);
      if (!decoded.ok) return decoded;
      const lines = splitLines(decoded.data);
      if (lines.length === 0) {
        if (prepared.startLine !== 1 || prepared.startColumn !== 1) {
          return failure("range_out_of_bounds", "Start position is outside the file");
        }
      } else if (prepared.startLine > lines.length) {
        return failure("range_out_of_bounds", "Start line is outside the file");
      }
      const first = lines[prepared.startLine - 1] ?? "";
      const codepoints = [...first];
      if (prepared.startColumn > codepoints.length + 1) {
        return failure("range_out_of_bounds", "Start column is outside the line");
      }
      const page = buildPage(
        lines,
        prepared.startLine,
        prepared.startColumn,
        prepared.maxLines,
        50 * 1024
      );
      return {
        ok: true,
        data: {
          path: resolved.data.path,
          text: page.text,
          startLine: prepared.startLine,
          startColumn: prepared.startColumn,
          endLine: page.endLine,
          endColumn: page.endColumn,
          totalLines: lines.length,
          truncated: page.next !== undefined,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          ...(page.next === undefined ? {} : { next: page.next }),
        },
      };
    } catch (error) {
      return failure("filesystem_error", `Unable to read file: ${String(error)}`, true);
    }
  },
};

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (/\r\n$|\n$|\r$/.test(text)) lines.pop();
  return lines;
}

function buildPage(
  lines: readonly string[],
  startLine: number,
  startColumn: number,
  maxLines: number,
  maxBytes: number
): {
  text: string;
  endLine: number;
  endColumn: number;
  next?: { startLine: number; startColumn: number };
} {
  let text = "";
  let bytes = 0;
  let endLine = startLine;
  let endColumn = startColumn;
  const lastLine = Math.min(lines.length, startLine - 1 + maxLines);
  for (let lineNumber = startLine; lineNumber <= lastLine; lineNumber++) {
    if (lineNumber > startLine) {
      if (bytes + 1 > maxBytes) {
        return { text, endLine, endColumn, next: { startLine: lineNumber, startColumn: 1 } };
      }
      text += "\n";
      bytes++;
    }
    const source = [...(lines[lineNumber - 1] ?? "")];
    const baseColumn = lineNumber === startLine ? startColumn : 1;
    const visible = lineNumber === startLine ? source.slice(startColumn - 1) : source;
    for (let index = 0; index < visible.length; index++) {
      const char = visible[index]!;
      const size = Buffer.byteLength(char, "utf8");
      if (bytes + size > maxBytes) {
        return {
          text,
          endLine: lineNumber,
          endColumn: baseColumn + index,
          next: { startLine: lineNumber, startColumn: baseColumn + index },
        };
      }
      text += char;
      bytes += size;
      endLine = lineNumber;
      endColumn = baseColumn + index + 1;
    }
    endLine = lineNumber;
    endColumn = baseColumn + visible.length;
  }
  const nextLine = startLine - 1 + maxLines < lines.length ? lastLine + 1 : undefined;
  return {
    text,
    endLine,
    endColumn,
    ...(nextLine === undefined ? {} : { next: { startLine: nextLine, startColumn: 1 } }),
  };
}

function decodeText(bytes: Uint8Array): import("./types.js").ToolResult<string> {
  try {
    let text: string;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      const body = bytes.subarray(2);
      const swapped = new Uint8Array(body.length);
      for (let i = 0; i + 1 < body.length; i += 2) {
        swapped[i] = body[i + 1]!;
        swapped[i + 1] = body[i]!;
      }
      text = new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
    } else {
      const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
        ? bytes.subarray(3)
        : bytes;
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    }
    if (text.includes("\0")) return failure("unsupported_content", "Text contains NUL bytes");
    return { ok: true, data: text };
  } catch {
    return failure("unsupported_content", "File is not supported UTF text");
  }
}
