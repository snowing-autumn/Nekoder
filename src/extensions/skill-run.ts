import type { DefinitionSnapshot, SkillDefinition } from "./definition-catalog.js";
import type { Tool, ToolResult } from "../tools/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import { SkillWorkerClient } from "./skill-worker.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export interface SkillRunOptions {
  readonly maxActive?: number;
  readonly maxInstructionBytes?: number;
  readonly registry?: ToolRegistry;
  readonly authorizeCode?: (definition: SkillDefinition) => boolean | Promise<boolean>;
  readonly trustCode?: (definition: SkillDefinition) => void | Promise<void>;
  readonly workerEnvironment?: (definition: SkillDefinition) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  readonly delegate?: (request: { definition: SkillDefinition; argumentsText: string }) => Promise<{ taskId: string }>;
}

interface ActiveSkill {
  readonly definition: SkillDefinition;
  readonly instructions: string;
}

interface UseSkillInput {
  readonly name: string;
  readonly arguments?: string;
  readonly mode?: "inline" | "delegated";
}

export class SkillRun {
  private readonly activated = new Map<string, ActiveSkill>();
  private instructionBytes = 0;
  private dynamicToolCount = 0;
  private dynamicDefinitionBytes = 0;
  private readonly workers = new Map<string, SkillWorkerClient>();

  constructor(
    private snapshot: Pick<DefinitionSnapshot, "skill">,
    private readonly options: SkillRunOptions = {}
  ) {}

  reload(snapshot: Pick<DefinitionSnapshot, "skill">): void {
    if (this.activated.size > 0) throw new Error("Cannot replace the Skill snapshot during an active Run");
    this.snapshot = snapshot;
  }

  begin(): void {
    this.activated.clear();
    this.instructionBytes = 0;
    this.dynamicToolCount = 0;
    this.dynamicDefinitionBytes = 0;
  }

  async end(): Promise<void> {
    for (const [owner, worker] of this.workers) {
      this.options.registry?.clearDynamic(owner);
      await worker.close();
    }
    this.workers.clear();
    this.begin();
  }

  active(): readonly ActiveSkill[] {
    return Object.freeze([...this.activated.values()]);
  }

  supplementalInstructions(): readonly string[] {
    return this.active().map(({ definition, instructions }) =>
      `Skill: ${definition.name} (${definition.source.kind}:${definition.source.path})\n${instructions}`
    );
  }

  async activate(
    name: string,
    argumentsText = "",
    mode: "inline" | "delegated" = "inline",
    activationStack: readonly string[] = [],
    codeApproved = false
  ): Promise<ToolResult<{ status: "activated" | "already-active" | "delegated"; name: string; contentHash: string; taskId?: string }>> {
    const definition = this.snapshot.skill(name);
    if (!definition) return failure("skill_not_found", `Unknown Skill: ${name}`);
    if (activationStack.includes(name)) return failure("skill_cycle", `Skill activation cycle: ${[...activationStack, name].join(" -> ")}`);
    if (!definition.runtime.modes.includes(mode)) return failure("skill_mode_not_allowed", `Skill ${name} does not allow ${mode} mode`);
    if (mode === "delegated") {
      if (!this.options.delegate) return failure("delegation_not_allowed", "Delegated Skills require the Root delegated-task manager");
      const delegated = await this.options.delegate({ definition, argumentsText });
      return { ok: true, data: { status: "delegated", name, contentHash: definition.contentHash, taskId: delegated.taskId } };
    }
    const existing = this.activated.get(name);
    if (existing?.definition.contentHash === definition.contentHash) {
      return { ok: true, data: { status: "already-active", name, contentHash: definition.contentHash } };
    }
    if (this.activated.size >= (this.options.maxActive ?? 20)) return failure("skill_limit_exceeded", "A Run may activate at most 20 inline Skills");
    const instructions = substitute(definition.instructions, argumentsText, definition.source.path);
    const bytes = Buffer.byteLength(instructions, "utf8");
    if (this.instructionBytes + bytes > (this.options.maxInstructionBytes ?? 256 * 1024)) {
      return failure("skill_instruction_budget_exceeded", "Active Skill instructions exceed the Run budget");
    }
    this.activated.set(name, Object.freeze({ definition, instructions }));
    this.instructionBytes += bytes;
    const executableCode = Boolean(definition.runtime.worker) || await hasStandardCode(definition);
    if (executableCode) {
      if (codeApproved) await this.options.trustCode?.(definition);
      if (!codeApproved && !await this.options.authorizeCode?.(definition)) return this.rollback(name, bytes, "skill_code_trust_required", `Executable Skill ${name} requires content trust`);
    }
    if (definition.runtime.worker) {
      if (!this.options.registry) return this.rollback(name, bytes, "skill_worker_unavailable", "Skill Worker requires a dynamic Tool Registry");
      let worker: SkillWorkerClient;
      try {
        worker = await SkillWorkerClient.start({
          command: definition.runtime.worker.command,
          args: definition.runtime.worker.args,
          cwd: definition.source.path,
          env: await this.options.workerEnvironment?.(definition),
        });
      } catch (error) {
        return this.rollback(name, bytes, "skill_worker_unavailable", String(error));
      }
      if (this.dynamicToolCount + worker.definitions().length > 128) {
        await worker.close();
        return this.rollback(name, bytes, "skill_tool_budget_exceeded", "Skill Worker tools exceed the Run limit of 128");
      }
      if (this.dynamicDefinitionBytes + worker.definitionBytes() > 256 * 1024) {
        await worker.close();
        return this.rollback(name, bytes, "skill_tool_budget_exceeded", "Skill Worker definitions exceed the Run limit of 256 KiB");
      }
      const owner = `skill:${name}:${definition.contentHash}`;
      try {
        this.options.registry.registerDynamic(owner, worker.definitions().map((reported): Tool<unknown, unknown, unknown> => ({
          name: `skill__${name.replaceAll("-", "_")}__${reported.name}`,
          description: `${reported.description} (Skill Worker ${name}; no OS sandbox)`,
          effect: reported.effect ?? "execute",
          inputSchema: reported.inputSchema,
          timeoutMs: 120_000,
          async prepare(input) { return { ok: true, data: input }; },
          async authorizationTarget() { return { ok: true, data: { primary: `skill:${name}/${reported.name}`, maxApprovalScope: "session" } }; },
          execute: (input) => worker.call(reported.name, input),
        })));
      } catch (error) {
        await worker.close();
        return this.rollback(name, bytes, "skill_worker_unavailable", String(error));
      }
      this.workers.set(owner, worker);
      this.dynamicToolCount += worker.definitions().length;
      this.dynamicDefinitionBytes += worker.definitionBytes();
    }
    return { ok: true, data: { status: "activated", name, contentHash: definition.contentHash } };
  }

  private rollback(name: string, bytes: number, code: import("../tools/types.js").ToolErrorCode, message: string): ToolResult<never> {
    this.activated.delete(name);
    this.instructionBytes -= bytes;
    return failure(code, message);
  }

  tool(): Tool<UseSkillInput, UseSkillInput, unknown> {
    return {
      name: "use_skill",
      description: "Activate a discovered Skill for this Run. This orchestration tool must be the only call in its Tool Batch.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          arguments: { type: "string" },
          mode: { type: "string", enum: ["inline", "delegated"] },
        },
        required: ["name"],
        additionalProperties: false,
      },
      timeoutMs: 10_000,
      async prepare(input) { return { ok: true, data: input }; },
      authorizationTarget: async (input) => {
        const definition = this.snapshot.skill(input.name);
        const executableCode = definition ? Boolean(definition.runtime.worker) || await hasStandardCode(definition) : false;
        const untrustedCode = executableCode && definition ? !await this.options.authorizeCode?.(definition) : false;
        const needsApproval = untrustedCode || input.mode === "delegated";
        return { ok: true, data: { primary: untrustedCode && definition ? `skill-code:${input.name}:${definition.contentHash}` : `skill:${input.name}`, ...(needsApproval ? { dynamic: true as const, maxApprovalScope: "once" as const } : {}) } };
      },
      execute: async (input) => this.activate(input.name, input.arguments ?? "", input.mode ?? "inline", [], true),
    };
  }
}

async function hasStandardCode(definition: SkillDefinition): Promise<boolean> {
  try { return (await stat(join(definition.source.path, "scripts"))).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function substitute(content: string, argumentsText: string, skillDirectory: string): string {
  const args = argumentsText.trim() ? argumentsText.trim().split(/\s+/u) : [];
  return content
    .replaceAll("${NEKODER_SKILL_DIR}", skillDirectory)
    .replaceAll("${CLAUDE_SKILL_DIR}", skillDirectory)
    .replaceAll("$ARGUMENTS", argumentsText)
    .replace(/\$(?:ARGUMENTS\[)?(\d+)\]?/gu, (_match, index: string) => args[Number(index)] ?? "");
}

function failure(code: import("../tools/types.js").ToolErrorCode, message: string): ToolResult<never> {
  return { ok: false, error: { code, message, retryable: false } };
}
