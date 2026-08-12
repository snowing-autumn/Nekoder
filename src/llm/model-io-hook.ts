import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { ModelCollectRequest, ModelInvoker, ModelStepResult } from "../model/types.js";

export interface ModelIoHook {
  request(id: string, request: ModelCollectRequest): Promise<void>;
  response(id: string, response: ModelStepResult): Promise<void>;
  error(id: string, error: unknown): Promise<void>;
  createId(): string;
}

export interface JsonlModelIoHookOptions {
  readonly file: string;
  readonly stableSystemPrompt: string;
  readonly idFactory?: () => string;
  readonly clock?: () => number;
}

export class JsonlModelIoHook implements ModelIoHook {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly options: JsonlModelIoHookOptions) {}

  createId(): string {
    return this.options.idFactory?.() ?? crypto.randomUUID();
  }

  request(id: string, request: ModelCollectRequest): Promise<void> {
    const { signal, onTextDelta, onToolCall, ...semanticRequest } = request;
    return this.write({
      id,
      timestamp: this.timestamp(),
      phase: "request",
      stableSystemPrompt: this.options.stableSystemPrompt,
      request: {
        ...semanticRequest,
        callbacks: {
          onTextDelta: onTextDelta !== undefined,
          onToolCall: onToolCall !== undefined,
        },
        ...(signal ? { signal: { aborted: signal.aborted, reason: serializable(signal.reason) } } : {}),
      },
    });
  }

  response(id: string, response: ModelStepResult): Promise<void> {
    return this.write({ id, timestamp: this.timestamp(), phase: "response", response });
  }

  error(id: string, error: unknown): Promise<void> {
    return this.write({ id, timestamp: this.timestamp(), phase: "error", error: serializable(error) });
  }

  private timestamp(): string {
    return new Date(this.options.clock?.() ?? Date.now()).toISOString();
  }

  private write(record: unknown): Promise<void> {
    const line = `${JSON.stringify(record, jsonReplacer)}\n`;
    const operation = this.writes.then(async () => {
      await mkdir(dirname(this.options.file), { recursive: true });
      await appendFile(this.options.file, line, "utf8");
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
}

export function withModelIoHook(model: ModelInvoker, hook: ModelIoHook): ModelInvoker {
  return {
    async collect(request) {
      const id = hook.createId();
      await hook.request(id, request);
      try {
        const response = await model.collect(request);
        await hook.response(id, response);
        return response;
      } catch (error) {
        await hook.error(id, error);
        throw error;
      }
    },
  };
}

function serializable(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return serializable(value);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  return value;
}
