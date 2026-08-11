import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type InstructionLayerKind = "workspace_local" | "project_shared" | "user_global";

export interface InstructionReference {
  readonly source: string;
  readonly content: string;
  readonly depth: number;
}

export interface InstructionLayerSnapshot {
  readonly kind: InstructionLayerKind;
  readonly source: string;
  readonly instructions: string;
  readonly references: readonly InstructionReference[];
}

export interface InstructionSnapshot {
  /** Layers are ordered from highest to lowest priority. */
  readonly layers: readonly InstructionLayerSnapshot[];
  /** Only root instruction-file text. Safe to place in the instruction supplement. */
  readonly trustedInstructions: string;
  /** Included files, explicitly marked as low-authority reference data. */
  readonly referenceData: string;
}

export interface InstructionLoaderOptions {
  readonly workspace: string;
  readonly homeDir: string;
  readonly maxDepth?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

export type InstructionLoadErrorCode =
  | "instruction_not_file"
  | "instruction_invalid_utf8"
  | "instruction_file_too_large"
  | "instruction_total_too_large"
  | "include_missing"
  | "include_not_file"
  | "include_invalid_utf8"
  | "include_file_too_large"
  | "include_outside_scope"
  | "include_cycle"
  | "include_depth_exceeded"
  | "include_unsupported";

export class InstructionLoadError extends Error {
  constructor(
    readonly code: InstructionLoadErrorCode,
    message: string,
    readonly includeChain: readonly string[] = []
  ) {
    super(message);
    this.name = "InstructionLoadError";
  }
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024;
const INCLUDE = /^\s*@(?:<([^>\r\n]+)>|([^\s<>]+))\s*$/u;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const GLOB_META = /[*?\[\]{}]/u;

interface LayerDefinition {
  readonly kind: InstructionLayerKind;
  readonly file: string;
  readonly boundary: string;
  readonly displayRoot: string;
}

interface LoadState {
  readonly maxDepth: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  totalBytes: number;
}

export class InstructionLoader {
  constructor(private readonly options: InstructionLoaderOptions) {}

  async load(): Promise<InstructionSnapshot> {
    const workspace = await realpath(this.options.workspace);
    const userBoundary = resolve(this.options.homeDir, ".nekoder");
    const definitions: readonly LayerDefinition[] = [
      {
        kind: "workspace_local",
        file: resolve(workspace, ".nekoder", "instructions.md"),
        boundary: workspace,
        displayRoot: ".",
      },
      {
        kind: "project_shared",
        file: resolve(workspace, "NEKODER.md"),
        boundary: workspace,
        displayRoot: ".",
      },
      {
        kind: "user_global",
        file: resolve(userBoundary, "instructions.md"),
        boundary: userBoundary,
        displayRoot: "~/.nekoder",
      },
    ];
    const state: LoadState = {
      maxDepth: this.options.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxFileBytes: this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      maxTotalBytes: this.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      totalBytes: 0,
    };
    const layers: InstructionLayerSnapshot[] = [];
    for (const definition of definitions) {
      if (!(await exists(definition.file))) continue;
      const boundary = await realpath(definition.boundary);
      const rootPath = await assertRegularFile(definition.file, "instruction", []);
      assertContained(boundary, rootPath, "include_outside_scope", [displayPath(definition, rootPath)]);
      const loaded = await this.loadDocument(
        rootPath,
        boundary,
        definition,
        0,
        [],
        state,
        true
      );
      layers.push(Object.freeze({
        kind: definition.kind,
        source: displayPath(definition, rootPath),
        instructions: loaded.content,
        references: Object.freeze(loaded.references),
      }));
    }

    const trustedInstructions = layers
      .filter(({ instructions }) => instructions.trim().length > 0)
      .map(({ kind, source, instructions }) =>
        `## ${layerTitle(kind)} (${source})\n${instructions}`
      )
      .join("\n\n");
    const references = layers.flatMap(({ references: items }) => items);
    const referenceData = references.map((item) =>
      `<nekoder-reference-data source=${JSON.stringify(item.source)} authority="data">\n${item.content}\n</nekoder-reference-data>`
    ).join("\n\n");

    return Object.freeze({
      layers: Object.freeze(layers),
      trustedInstructions,
      referenceData,
    });
  }

  private async loadDocument(
    file: string,
    boundary: string,
    definition: LayerDefinition,
    depth: number,
    stack: readonly string[],
    state: LoadState,
    root: boolean
  ): Promise<{ content: string; references: InstructionReference[] }> {
    const shown = displayPath(definition, file);
    const chain = [...stack.map((item) => displayPath(definition, item)), shown];
    const bytes = await readFile(file);
    if (bytes.byteLength > state.maxFileBytes) {
      throw new InstructionLoadError(
        root ? "instruction_file_too_large" : "include_file_too_large",
        `${shown} exceeds the ${state.maxFileBytes} byte instruction file limit`,
        chain
      );
    }
    state.totalBytes += bytes.byteLength;
    if (state.totalBytes > state.maxTotalBytes) {
      throw new InstructionLoadError(
        "instruction_total_too_large",
        `Instruction snapshot exceeds the ${state.maxTotalBytes} byte total limit`,
        chain
      );
    }
    const content = decodeUtf8(
      bytes,
      root ? "instruction_invalid_utf8" : "include_invalid_utf8",
      shown,
      chain
    );
    const kept: string[] = [];
    const references: InstructionReference[] = [];
    for (const line of content.split(/\r?\n/u)) {
      const match = INCLUDE.exec(line);
      if (!match) {
        kept.push(line);
        continue;
      }
      if (depth >= state.maxDepth) {
        throw new InstructionLoadError(
          "include_depth_exceeded",
          `Instruction include depth exceeds ${state.maxDepth}`,
          chain
        );
      }
      const include = (match[1] ?? match[2] ?? "").trim();
      validateInclude(include, chain);
      const candidate = resolve(dirname(file), include);
      if (!(await exists(candidate))) {
        throw new InstructionLoadError(
          "include_missing",
          `Instruction include does not exist: ${include}`,
          [...chain, include]
        );
      }
      const target = await assertRegularFile(candidate, "include", [...chain, include]);
      assertContained(boundary, target, "include_outside_scope", [...chain, target]);
      if (stack.includes(target) || target === file) {
        throw new InstructionLoadError(
          "include_cycle",
          `Instruction include cycle: ${[...chain, displayPath(definition, target)].join(" -> ")}`,
          [...chain, displayPath(definition, target)]
        );
      }
      const child = await this.loadDocument(
        target,
        boundary,
        definition,
        depth + 1,
        [...stack, file],
        state,
        false
      );
      references.push(Object.freeze({
        source: displayPath(definition, target),
        content: child.content,
        depth: depth + 1,
      }));
      references.push(...child.references);
    }
    return { content: kept.join("\n").replace(/^\uFEFF/u, ""), references };
  }
}

function validateInclude(include: string, chain: readonly string[]): void {
  if (!include || isAbsolute(include) || URL_SCHEME.test(include) || GLOB_META.test(include)) {
    throw new InstructionLoadError(
      "include_unsupported",
      `Unsupported instruction include: ${include || "(empty)"}`,
      chain
    );
  }
}

async function assertRegularFile(
  path: string,
  role: "instruction" | "include",
  chain: readonly string[]
): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile()) {
    throw new InstructionLoadError(
      role === "instruction" ? "instruction_not_file" : "include_not_file",
      `${path} is not a regular file`,
      chain
    );
  }
  return await realpath(path);
}

function decodeUtf8(
  bytes: Uint8Array,
  code: "instruction_invalid_utf8" | "include_invalid_utf8",
  shown: string,
  chain: readonly string[]
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InstructionLoadError(code, `${shown} is not valid UTF-8`, chain);
  }
}

function assertContained(
  boundary: string,
  target: string,
  code: "include_outside_scope",
  chain: readonly string[]
): void {
  const path = relative(boundary, target);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new InstructionLoadError(code, `${target} is outside the instruction scope`, chain);
}

function displayPath(definition: LayerDefinition, file: string): string {
  const path = relative(definition.boundary, file).split(sep).join("/");
  return definition.displayRoot === "." ? path : `${definition.displayRoot}/${path}`;
}

function layerTitle(kind: InstructionLayerKind): string {
  if (kind === "workspace_local") return "Workspace-local Project Instructions";
  if (kind === "project_shared") return "Shared Project Instructions";
  return "User Instructions";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(error);
  }
}
