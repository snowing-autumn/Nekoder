import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export const SINGLE_TOOL_RESULT_ARTIFACT_BYTES = 48 * 1024;
export const TOOL_MESSAGE_INLINE_BYTES = 96 * 1024;

const PREVIEW_BYTES_PER_END = 2 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface ToolArtifactInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly value: unknown;
}

export interface ToolArtifactReference {
  readonly kind: "tool_artifact";
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly preview: {
    readonly head: string;
    readonly tail: string;
    readonly truncated: true;
  };
}

export interface ProcessedToolArtifactResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly value: unknown | ToolArtifactReference;
  readonly artifact?: ToolArtifactReference;
}

export interface ToolArtifactBatch {
  readonly results: readonly ProcessedToolArtifactResult[];
  readonly inlineBytes: number;
  readonly artifacts: readonly ToolArtifactReference[];
}

export type ToolArtifactStoreErrorCode =
  | "invalid_session_id"
  | "invalid_tool_result"
  | "artifact_write_failed"
  | "artifact_delete_failed";

export class ToolArtifactStoreError extends Error {
  constructor(
    readonly code: ToolArtifactStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ToolArtifactStoreError";
  }
}

/** Internal persistence seam. Production and fault-injection tests use different adapters. */
export interface ToolArtifactPersistence {
  writeAtomic(absolutePath: string, content: Uint8Array): Promise<void>;
  removeTree(absolutePath: string): Promise<void>;
}

export interface ToolArtifactStoreOptions {
  readonly clock?: () => Date;
  readonly persistence?: ToolArtifactPersistence;
}

interface PreparedResult {
  readonly input: ToolArtifactInput;
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
  readonly sha256: string;
  artifactize: boolean;
}

/**
 * Owns Tool Result spill policy and storage. Callers submit a whole Tool message so
 * the Module can enforce both the per-result and aggregate inline budgets.
 */
export class ToolArtifactStore {
  private readonly workspace: string;
  private readonly clock: () => Date;
  private readonly persistence: ToolArtifactPersistence;

  constructor(workspace: string, options: ToolArtifactStoreOptions = {}) {
    this.workspace = resolve(workspace);
    this.clock = options.clock ?? (() => new Date());
    this.persistence = options.persistence ?? new NodeToolArtifactPersistence();
  }

  async process(sessionId: string, inputs: readonly ToolArtifactInput[]): Promise<ToolArtifactBatch> {
    assertSafeSessionId(sessionId);
    const prepared = inputs.map(prepareResult);

    let inlineBytes = 0;
    for (const result of prepared) {
      result.artifactize = result.sizeBytes > SINGLE_TOOL_RESULT_ARTIFACT_BYTES;
      if (!result.artifactize) inlineBytes += result.sizeBytes;
    }

    if (inlineBytes > TOOL_MESSAGE_INLINE_BYTES) {
      const largestFirst = prepared
        .filter((result) => !result.artifactize)
        .sort((left, right) => right.sizeBytes - left.sizeBytes);
      for (const result of largestFirst) {
        if (inlineBytes <= TOOL_MESSAGE_INLINE_BYTES) break;
        result.artifactize = true;
        inlineBytes -= result.sizeBytes;
      }
    }

    const written: string[] = [];
    const references = new Map<PreparedResult, ToolArtifactReference>();
    try {
      for (const result of prepared) {
        if (!result.artifactize) continue;
        const reference = this.referenceFor(sessionId, result);
        const absolutePath = resolveRelativePath(this.workspace, reference.relativePath);
        await this.persistence.writeAtomic(absolutePath, result.bytes);
        written.push(absolutePath);
        references.set(result, reference);
      }
    } catch (cause) {
      await Promise.allSettled(written.map((path) => this.persistence.removeTree(path)));
      throw new ToolArtifactStoreError(
        "artifact_write_failed",
        `Unable to persist Tool Artifacts for Session ${sessionId}`,
        { cause }
      );
    }

    const artifacts = [...references.values()];
    return {
      inlineBytes,
      artifacts,
      results: prepared.map((result) => {
        const artifact = references.get(result);
        return {
          toolCallId: result.input.toolCallId,
          toolName: result.input.toolName,
          value: artifact ?? result.input.value,
          ...(artifact ? { artifact } : {}),
        };
      }),
    };
  }

  async deleteSessionArtifacts(sessionId: string): Promise<void> {
    assertSafeSessionId(sessionId);
    const directory = resolveRelativePath(
      this.workspace,
      [".nekoder", "artifacts", sessionId].join("/")
    );
    try {
      await this.persistence.removeTree(directory);
    } catch (cause) {
      throw new ToolArtifactStoreError(
        "artifact_delete_failed",
        `Unable to delete Tool Artifacts for Session ${sessionId}`,
        { cause }
      );
    }
  }

  private referenceFor(sessionId: string, result: PreparedResult): ToolArtifactReference {
    const timestamp = this.clock().toISOString().replace(/[-:.]/gu, "");
    const toolCallId = sanitizeFilePart(result.input.toolCallId);
    const fileName = `${timestamp}-${toolCallId}-${result.sha256.slice(0, 12)}.json`;
    return {
      kind: "tool_artifact",
      relativePath: [".nekoder", "artifacts", sessionId, fileName].join("/"),
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
      preview: preview(result.bytes),
    };
  }
}

class NodeToolArtifactPersistence implements ToolArtifactPersistence {
  async writeAtomic(absolutePath: string, content: Uint8Array): Promise<void> {
    await mkdir(dirname(absolutePath), { recursive: true });
    const temporary = `${absolutePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, absolutePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async removeTree(absolutePath: string): Promise<void> {
    await rm(absolutePath, { recursive: true, force: true });
  }
}

function prepareResult(input: ToolArtifactInput): PreparedResult {
  if (!input.toolCallId.trim() || !input.toolName.trim()) {
    throw new ToolArtifactStoreError(
      "invalid_tool_result",
      "Tool Artifact inputs require non-empty toolCallId and toolName"
    );
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input.value);
  } catch (cause) {
    throw new ToolArtifactStoreError(
      "invalid_tool_result",
      `Tool Result ${input.toolCallId} is not JSON-serializable`,
      { cause }
    );
  }
  if (serialized === undefined) {
    throw new ToolArtifactStoreError(
      "invalid_tool_result",
      `Tool Result ${input.toolCallId} is not JSON-serializable`
    );
  }
  const bytes = Buffer.from(serialized, "utf8");
  return {
    input,
    bytes,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    artifactize: false,
  };
}

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_ID.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new ToolArtifactStoreError(
      "invalid_session_id",
      `Invalid Session ID for Tool Artifacts: ${sessionId}`
    );
  }
}

function sanitizeFilePart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^\.+/u, "");
  return (sanitized || "tool-call").slice(0, 80);
}

function preview(bytes: Uint8Array): ToolArtifactReference["preview"] {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    head: decoder.decode(bytes.slice(0, PREVIEW_BYTES_PER_END)),
    tail: decoder.decode(bytes.slice(Math.max(0, bytes.byteLength - PREVIEW_BYTES_PER_END))),
    truncated: true,
  };
}

function resolveRelativePath(workspace: string, relativePath: string): string {
  const absolute = resolve(workspace, ...relativePath.split("/"));
  const fromWorkspace = relative(workspace, absolute);
  if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`)) {
    throw new ToolArtifactStoreError("invalid_session_id", "Tool Artifact path escaped the Workspace");
  }
  return absolute;
}
