import { AgentSession } from "../agent/session.js";
import { ModeToolAuthorizer } from "../agent/mode-authorizer.js";
import { ConversationManager } from "../conversation/conversation.js";
import type { ModelCollectRequest, ModelInvoker, ModelStepResult } from "../model/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolRunner } from "../tools/runner.js";
import type { Tool } from "../tools/types.js";
import { ApprovalBroker } from "./approval-broker.js";
import { SessionController } from "./session-controller.js";

export interface DemoApplication {
  readonly controller: SessionController;
  readonly conversation: ConversationManager;
  readonly approvalBroker: ApprovalBroker;
}

class DemoModel implements ModelInvoker {
  private toolCallNumber = 0;

  async collect(request: ModelCollectRequest): Promise<ModelStepResult> {
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      return streamResponse(request, "Tool activity completed. The demo run is finished.");
    }
    const prompt = JSON.stringify(last ?? "").toLowerCase();
    if (prompt.includes("interrupt")) {
      await request.onTextDelta?.("This stream will be interrupted…");
      throw new Error("Demo stream interruption");
    }
    if (prompt.includes("approval") || prompt.includes("command")) {
      return toolResponse(request, `demo-command-${++this.toolCallNumber}`, "run_command", {
        command: "git status --short",
        cwd: ".",
      });
    }
    if (prompt.includes("tool")) {
      return toolResponse(request, `demo-read-${++this.toolCallNumber}`, "read_file", { path: "goal.md" });
    }
    const mode = request.instructions?.includes("Investigate only") ? "Plan" : "Execute";
    return streamResponse(
      request,
      `Demo ${mode} response. Try “show a tool”, or enter /plan and then “request approval”.`
    );
  }
}

async function streamResponse(
  request: ModelCollectRequest,
  text: string
): Promise<ModelStepResult> {
  for (const chunk of text.match(/.{1,12}/gu) ?? [text]) {
    await request.onTextDelta?.(chunk);
  }
  return {
    text,
    toolCalls: [],
    responseMessages: [{ role: "assistant", content: text }],
    finishReason: "stop",
    usage: { inputTokens: 12, outputTokens: Math.max(1, Math.ceil(text.length / 4)) },
    warnings: [],
  };
}

async function toolResponse(
  request: ModelCollectRequest,
  toolCallId: string,
  toolName: string,
  input: unknown
): Promise<ModelStepResult> {
  await request.onToolCall?.({ toolCallId, toolName, input });
  return {
    text: "",
    toolCalls: [{ toolCallId, toolName, input }],
    responseMessages: [{
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName, input }],
    }],
    finishReason: "tool-calls",
    usage: { inputTokens: 8, outputTokens: 4 },
    warnings: [],
  };
}

export function createDemoApplication(workspace: string): DemoApplication {
  const read: Tool<{ path: string }, { path: string }, unknown> = {
    name: "read_file",
    description: "Demo read without filesystem side effects",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    timeoutMs: 1_000,
    async prepare(input) { return { ok: true, data: input }; },
    async execute(prepared) {
      return { ok: true, data: { path: prepared.path, preview: "Demo file contents" } };
    },
  };
  const command: Tool<
    { command: string; cwd?: string },
    { command: string; absolutePath: string },
    unknown
  > = {
    name: "run_command",
    description: "Demo command without process side effects",
    effect: "execute",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, cwd: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    timeoutMs: 1_000,
    async prepare(input) {
      return { ok: true, data: { command: input.command, absolutePath: workspace } };
    },
    async execute(prepared) {
      return { ok: true, data: { command: prepared.command, stdout: " M demo-file.ts" } };
    },
  };
  const registry = new ToolRegistry();
  registry.register(read);
  registry.register(command);
  registry.seal();
  const conversation = new ConversationManager();
  const approvalBroker = new ApprovalBroker();
  let id = 0;
  const session = new AgentSession({
    model: new DemoModel(),
    registry,
    toolRunner: new ToolRunner(registry, {
      authorizer: new ModeToolAuthorizer(),
      approvalHandler: approvalBroker,
    }),
    conversation,
    workspace,
    idFactory: () => `demo-${++id}`,
  });
  return {
    controller: new SessionController(session, approvalBroker),
    conversation,
    approvalBroker,
  };
}
