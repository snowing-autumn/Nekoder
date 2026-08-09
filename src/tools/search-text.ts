import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Tool } from "./types.js";
import {
  failure,
  prepareWorkspacePath,
  resolveExistingWorkspacePath,
  type PreparedPath,
} from "./workspace.js";

interface SearchTextInput {
  readonly query: string;
  readonly path?: string;
  readonly filePattern?: string;
  readonly isRegex?: boolean;
  readonly caseSensitive?: boolean;
}

interface PreparedSearchText extends PreparedPath {
  readonly query: string;
  readonly filePattern?: string;
  readonly isRegex: boolean;
  readonly caseSensitive: boolean;
}

const DEFAULT_SKIP_DIRS = ["node_modules", "dist", "build", "coverage"] as const;

export function createSearchTextTool(
  skipDirs: readonly string[] = DEFAULT_SKIP_DIRS
): Tool<SearchTextInput, PreparedSearchText, unknown> {
  const excludedDirs = new Set([...skipDirs, ".git"]);
  return {
  name: "search_text",
  description: "Search workspace text files for literal text or a Unicode regular expression.",
  effect: "read",
  timeoutMs: 30_000,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 4096 },
      path: { type: "string", minLength: 1 },
      filePattern: { type: "string", minLength: 1, maxLength: 4096 },
      isRegex: { type: "boolean" },
      caseSensitive: { type: "boolean" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async prepare(input, context) {
    if (!input.query) return failure("invalid_input", "Search query must not be empty");
    if (input.isRegex) {
      try {
        new RegExp(input.query, "u");
      } catch (error) {
        return failure("invalid_input", `Invalid regular expression: ${String(error)}`);
      }
    }
    const path = prepareWorkspacePath(context.workspace, input.path ?? ".");
    if (!path.ok) return path;
    return {
      ok: true,
      data: {
        ...path.data,
        query: input.query,
        ...(input.filePattern === undefined ? {} : { filePattern: input.filePattern }),
        isRegex: input.isRegex ?? false,
        caseSensitive: input.caseSensitive ?? true,
      },
    };
  },
  async execute(prepared, context) {
    const start = await resolveExistingWorkspacePath(context.workspace, prepared);
    if (!start.ok) return start;
    const fileMatcher = prepared.filePattern ? new Bun.Glob(prepared.filePattern) : undefined;
    const regexMatcher = prepared.isRegex
      ? new RegexWorkerMatcher(prepared.query, prepared.caseSensitive, context.signal)
      : undefined;
    const matches: Array<Record<string, unknown>> = [];
    const warnings: Array<{ path: string; code: string }> = [];
    const scan = async (absolute: string, path: string): Promise<void> => {
      if (matches.length >= 200 || context.signal?.aborted) return;
      let bytes: Uint8Array;
      try {
        bytes = await readFile(absolute);
      } catch {
        warnings.push({ path, code: "unreadable" });
        return;
      }
      let text: string;
      try {
        text = decodeSupportedText(bytes);
      } catch {
        warnings.push({ path, code: "unsupported_content" });
        return;
      }
      if (text.includes("\0")) {
        warnings.push({ path, code: "unsupported_content" });
        return;
      }
      const lines = text.split(/\r\n|\n|\r/);
      if (/\r\n$|\n$|\r$/.test(text)) lines.pop();
      for (let lineIndex = 0; lineIndex < lines.length && matches.length < 200; lineIndex++) {
        const line = lines[lineIndex]!;
        const lineMatches = regexMatcher
          ? await regexMatcher.find(line)
          : findLiteralMatches(line, prepared);
        for (const found of lineMatches) {
          const codepointColumn = [...line.slice(0, found.index)].length + 1;
          matches.push({
            path,
            line: lineIndex + 1,
            column: codepointColumn,
            endColumn: codepointColumn + [...found.value].length,
            lineLength: [...line].length,
            preview: [...line].slice(0, 500).join(""),
          });
          if (matches.length >= 200) break;
        }
      }
    };
    const visit = async (absolute: string, local: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch {
        warnings.push({ path: local || ".", code: "unreadable" });
        return;
      }
      for (const entry of entries) {
        if (matches.length >= 200 || context.signal?.aborted) return;
        const childLocal = local ? `${local}/${entry.name}` : entry.name;
        const childAbsolute = join(absolute, entry.name);
        if (entry.isDirectory()) {
          if (!excludedDirs.has(entry.name)) await visit(childAbsolute, childLocal);
        } else if (entry.isFile()) {
          if (!fileMatcher || fileMatcher.match(childLocal)) {
            await scan(childAbsolute, start.data.path === "." ? childLocal : `${start.data.path}/${childLocal}`);
          }
        }
      }
    };
    try {
      const info = await stat(start.data.absolutePath);
      if (info.isFile()) {
        const name = start.data.path.split("/").at(-1) ?? start.data.path;
        if (!fileMatcher || fileMatcher.match(name)) await scan(start.data.absolutePath, start.data.path);
      } else if (info.isDirectory()) {
        await visit(start.data.absolutePath, "");
      } else {
        return failure("not_a_file", "Search path is neither a file nor directory");
      }
      matches.sort((a, b) =>
        String(a.path).localeCompare(String(b.path)) ||
        Number(a.line) - Number(b.line) ||
        Number(a.column) - Number(b.column)
      );
      regexMatcher?.close();
      return {
        ok: true,
        data: {
          matches,
          truncated: matches.length >= 200,
          incomplete: warnings.length > 0,
          warnings: warnings.slice(0, 20),
          warningCount: warnings.length,
        },
      };
    } catch (error) {
      regexMatcher?.close();
      if (context.signal?.aborted) return failure("cancelled", "Text search was cancelled");
      return failure("filesystem_error", `Unable to search text: ${String(error)}`, true);
    }
  },
  };
}

export const searchTextTool = createSearchTextTool();

function findLiteralMatches(
  line: string,
  prepared: PreparedSearchText
): Array<{ index: number; value: string }> {
  const haystack = prepared.caseSensitive ? line : line.toLocaleLowerCase();
  const needle = prepared.caseSensitive ? prepared.query : prepared.query.toLocaleLowerCase();
  const found: Array<{ index: number; value: string }> = [];
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + Math.max(needle.length, 1))) {
    found.push({ index, value: line.slice(index, index + prepared.query.length) });
  }
  return found;
}

class RegexWorkerMatcher {
  private readonly worker = new Worker(
    new URL("./search-regex-worker.ts", import.meta.url).href
  );
  private readonly pending = new Map<
    number,
    { resolve: (matches: Array<{ index: number; value: string }>) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly query: string,
    private readonly caseSensitive: boolean,
    private readonly signal?: AbortSignal
  ) {
    this.worker.onmessage = (event: MessageEvent<{
      id: number;
      matches?: Array<{ index: number; value: string }>;
      error?: string;
    }>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.error) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data.matches ?? []);
    };
    this.worker.onerror = (event) => this.failAll(new Error(event.message));
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  find(line: string): Promise<Array<{ index: number; value: string }>> {
    if (this.closed || this.signal?.aborted) return Promise.reject(new Error("Regex worker closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, line, query: this.query, caseSensitive: this.caseSensitive });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.worker.terminate();
    this.failAll(new Error("Regex worker closed"));
  }

  private readonly onAbort = (): void => this.close();

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function decodeSupportedText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2);
    if (body.length % 2 !== 0) throw new Error("Odd UTF-16BE byte count");
    const swapped = new Uint8Array(body.length);
    for (let index = 0; index < body.length; index += 2) {
      swapped[index] = body[index + 1]!;
      swapped[index + 1] = body[index]!;
    }
    return new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
  }
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}
