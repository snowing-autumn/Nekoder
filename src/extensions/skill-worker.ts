import type { ToolInputSchema, ToolResult } from "../tools/types.js";

export interface SkillWorkerDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly effect?: "read" | "write" | "execute";
}

export interface SkillWorkerStartOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface RpcResponse { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code?: number; message?: string } }

export class SkillWorkerClient {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private toolDefinitions: readonly SkillWorkerDefinition[] = [];
  private definitionByteCount = 0;
  private buffer = "";
  private closed = false;

  private constructor(private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    void this.readOutput();
    void new Response(process.stderr).text();
    void process.exited.then((code) => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error(`Skill Worker exited with code ${code}`));
      this.pending.clear();
    });
  }

  static async start(options: SkillWorkerStartOptions): Promise<SkillWorkerClient> {
    if (options.signal?.aborted) throw new Error("Skill Worker start was cancelled");
    const process = Bun.spawn({
      cmd: [options.command, ...(options.args ?? [])], cwd: options.cwd,
      env: sanitizedEnvironment(options.env),
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const client = new SkillWorkerClient(process);
    const abort = () => { void client.close(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const initialized = await withTimeout(client.request("initialize", { version: 1 }), options.timeoutMs ?? 10_000, "Skill Worker initialize timed out");
      if (!isRecord(initialized) || initialized.version !== 1) throw new Error("Skill Worker protocol version mismatch");
      if (!Array.isArray(initialized.tools) || initialized.tools.length > 32) throw new Error("Skill Worker exceeds the 32 tool limit");
      const definitionBytes = Buffer.byteLength(JSON.stringify(initialized.tools), "utf8");
      if (definitionBytes > 256 * 1024) throw new Error("Skill Worker definitions exceed 256 KiB");
      const definitions = initialized.tools.map(validateDefinition);
      const names = new Set<string>();
      if (definitions.some(({ name }) => names.has(name) || !names.add(name))) throw new Error("Skill Worker returned duplicate tool names");
      client.toolDefinitions = Object.freeze(definitions);
      client.definitionByteCount = definitionBytes;
      return client;
    } catch (error) {
      await client.close();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  definitions(): readonly SkillWorkerDefinition[] { return this.toolDefinitions; }
  definitionBytes(): number { return this.definitionByteCount; }

  async call(name: string, input: unknown): Promise<ToolResult<unknown>> {
    if (!this.toolDefinitions.some((tool) => tool.name === name)) return { ok: false, error: { code: "unknown_tool", message: `Unknown Skill Worker tool: ${name}`, retryable: false } };
    const result = await this.request("call", { name, input });
    if (!isRecord(result) || typeof result.ok !== "boolean") throw new Error("Skill Worker returned an invalid ToolResult");
    return result as unknown as ToolResult<unknown>;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.process.stdin.end(); } catch { /* already closed */ }
    this.process.kill();
    await this.process.exited;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Skill Worker is closed"));
    const id = ++this.sequence;
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    this.process.stdin.flush();
    return promise;
  }

  private async readOutput(): Promise<void> {
    const reader = this.process.stdout.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      this.buffer += value;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let response: RpcResponse;
        try { response = JSON.parse(line) as RpcResponse; }
        catch { this.failAll(new Error("Skill Worker emitted invalid JSON")); continue; }
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(response.error.message ?? "Skill Worker RPC error"));
        else pending.resolve(response.result);
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function validateDefinition(value: unknown): SkillWorkerDefinition {
  if (!isRecord(value) || typeof value.name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(value.name) || typeof value.description !== "string" || !isRecord(value.inputSchema) || value.inputSchema.type !== "object") {
    throw new Error("Skill Worker returned an invalid tool definition");
  }
  if (value.effect !== undefined && !["read", "write", "execute"].includes(String(value.effect))) throw new Error("Skill Worker returned an invalid tool effect");
  return Object.freeze({ name: value.name, description: value.description, inputSchema: value.inputSchema as ToolInputSchema, ...(value.effect ? { effect: value.effect as "read" | "write" | "execute" } : {}) });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedEnvironment(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const secret = /(?:key|token|secret|password|credential|authorization|cookie)/iu;
  const base = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !secret.test(entry[0])
  ));
  return { ...base, ...(extra ?? {}) };
}
