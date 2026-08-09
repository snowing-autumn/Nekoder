import { createHash, randomBytes } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Tool } from "./types.js";
import {
  failure,
  prepareWorkspacePath,
  resolveExistingWorkspacePath,
  type PreparedPath,
} from "./workspace.js";

interface EditFileInput {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

interface PreparedEditFile extends PreparedPath {
  readonly oldText: string;
  readonly newText: string;
}

export const editFileTool: Tool<EditFileInput, PreparedEditFile, unknown> = {
  name: "edit_file",
  description: "Replace exactly one matching text fragment in a workspace file.",
  effect: "write",
  timeoutMs: 10_000,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      oldText: { type: "string", minLength: 1, maxLength: 262_144 },
      newText: { type: "string", maxLength: 262_144 },
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
  },
  async prepare(input, context) {
    const path = prepareWorkspacePath(context.workspace, input.path);
    if (!path.ok) return path;
    return { ok: true, data: { ...path.data, oldText: input.oldText, newText: input.newText } };
  },
  async execute(prepared, context) {
    const resolved = await resolveExistingWorkspacePath(context.workspace, prepared);
    if (!resolved.ok) return resolved;
    try {
      const info = await stat(resolved.data.absolutePath);
      if (!info.isFile()) return failure("not_a_file", "Path is not a file");
      if (info.size > 5 * 1024 * 1024) return failure("file_too_large", "File exceeds the 5 MiB edit limit");
      const beforeBytes = await readFile(resolved.data.absolutePath);
      let original: string;
      let encoding: EditableEncoding;
      try {
        const decoded = decodeEditable(beforeBytes);
        original = decoded.text;
        encoding = decoded.encoding;
      } catch {
        return failure("unsupported_content", "File is not valid UTF-8 text");
      }
      if (original.includes("\0")) return failure("unsupported_content", "Text contains NUL bytes");
      const mapped = normalizeNewlines(original);
      const needle = prepared.oldText.replace(/\r\n|\r/g, "\n");
      const start = mapped.text.indexOf(needle);
      if (start < 0) return failure("not_found", "oldText was not found");
      if (mapped.text.indexOf(needle, start + Math.max(needle.length, 1)) >= 0) {
        return failure("multiple_matches", "oldText occurs more than once");
      }
      const originalStart = mapped.offsets[start]!;
      const originalEnd = mapped.offsets[start + needle.length] ?? original.length;
      const newline = primaryNewline(original);
      const replacement = prepared.newText.replace(/\r\n|\r|\n/g, newline);
      const changed = original.slice(originalStart, originalEnd) !== replacement;
      const after = original.slice(0, originalStart) + replacement + original.slice(originalEnd);
      const beforeHash = createHash("sha256").update(beforeBytes).digest("hex");
      const afterBytes = encodeEditable(after, encoding);
      const afterHash = createHash("sha256").update(afterBytes).digest("hex");
      const position = lineColumn(mapped.text, start);
      const endPosition = lineColumn(mapped.text, start + needle.length);

      if (changed) {
        const temp = join(dirname(resolved.data.absolutePath), `.nekoder-${randomBytes(12).toString("hex")}.tmp`);
        try {
          await writeFile(temp, afterBytes, { flag: "wx" });
          await chmod(temp, info.mode);
          const current = await readFile(resolved.data.absolutePath);
          if (createHash("sha256").update(current).digest("hex") !== beforeHash) {
            await unlink(temp).catch(() => undefined);
            return failure("content_changed", "File content changed before replacement");
          }
          await rename(temp, resolved.data.absolutePath);
        } catch (error) {
          await unlink(temp).catch(() => undefined);
          return failure("filesystem_error", `Unable to edit file: ${String(error)}`, true);
        }
      }
      return {
        ok: true,
        data: {
          path: resolved.data.path,
          changed,
          startLine: position.line,
          startColumn: position.column,
          endLine: endPosition.line,
          endColumn: endPosition.column,
          beforeHash,
          afterHash,
        },
      };
    } catch (error) {
      return failure("filesystem_error", `Unable to edit file: ${String(error)}`, true);
    }
  },
};

function normalizeNewlines(text: string): { text: string; offsets: number[] } {
  let normalized = "";
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index++) {
    offsets.push(index);
    if (text[index] === "\r") {
      normalized += "\n";
      if (text[index + 1] === "\n") index++;
    } else {
      normalized += text[index];
    }
  }
  offsets.push(text.length);
  return { text: normalized, offsets };
}

function primaryNewline(text: string): string {
  const counts = { "\r\n": 0, "\n": 0, "\r": 0 };
  for (const match of text.matchAll(/\r\n|\n|\r/g)) counts[match[0] as keyof typeof counts]++;
  if (counts["\r\n"] >= counts["\n"] && counts["\r\n"] >= counts["\r"] && counts["\r\n"] > 0) return "\r\n";
  if (counts["\r"] > counts["\n"]) return "\r";
  return "\n";
}

function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: [...(lines.at(-1) ?? "")].length + 1 };
}

type EditableEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be";

function decodeEditable(bytes: Uint8Array): { text: string; encoding: EditableEncoding } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2)),
      encoding: "utf16le",
    };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2);
    if (body.length % 2 !== 0) throw new Error("Odd UTF-16BE byte count");
    const swapped = new Uint8Array(body.length);
    for (let index = 0; index < body.length; index += 2) {
      swapped[index] = body[index + 1]!;
      swapped[index + 1] = body[index]!;
    }
    return {
      text: new TextDecoder("utf-16le", { fatal: true }).decode(swapped),
      encoding: "utf16be",
    };
  }
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes),
    encoding: hasBom ? "utf8-bom" : "utf8",
  };
}

function encodeEditable(text: string, encoding: EditableEncoding): Buffer {
  if (encoding === "utf8") return Buffer.from(text, "utf8");
  if (encoding === "utf8-bom") {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  }
  const littleEndian = Buffer.from(text, "utf16le");
  if (encoding === "utf16le") {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian]);
  }
  const bigEndian = Buffer.allocUnsafe(littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index] = littleEndian[index + 1]!;
    bigEndian[index + 1] = littleEndian[index]!;
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]);
}
