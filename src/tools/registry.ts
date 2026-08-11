import Ajv2020 from "ajv/dist/2020.js";

import type { AnyTool, ToolName } from "./types.js";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export class ToolRegistry {
  private readonly tools = new Map<ToolName, AnyTool>();
  private readonly dynamic = new Map<string, Map<ToolName, AnyTool>>();
  private sealed = false;

  register(tool: AnyTool): void {
    if (this.sealed) throw new Error("ToolRegistry is sealed");
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  seal(): void {
    const ajv = new Ajv2020({ strict: true });
    for (const tool of this.tools.values()) ajv.compile(tool.inputSchema);
    this.sealed = true;
  }

  isSealed(): boolean {
    return this.sealed;
  }

  get(name: ToolName): AnyTool | undefined {
    if (!this.sealed) throw new Error("ToolRegistry must be sealed before use");
    return this.tools.get(name) ?? [...this.dynamic.values()].map((tools) => tools.get(name)).find(Boolean);
  }

  registerDynamic(owner: string, tools: readonly AnyTool[]): void {
    if (!this.sealed) throw new Error("ToolRegistry must be sealed before dynamic registration");
    const ajv = new Ajv2020({ strict: true });
    const names = new Set<string>();
    for (const tool of tools) {
      if (!TOOL_NAME.test(tool.name)) throw new Error(`Invalid dynamic tool name: ${tool.name}`);
      if (names.has(tool.name) || this.tools.has(tool.name) || [...this.dynamic.entries()].some(([key, value]) => key !== owner && value.has(tool.name))) throw new Error(`Duplicate dynamic tool name: ${tool.name}`);
      names.add(tool.name);
      ajv.compile(tool.inputSchema);
    }
    this.dynamic.set(owner, new Map(tools.map((tool) => [tool.name, tool])));
  }

  clearDynamic(owner: string): void { this.dynamic.delete(owner); }

  definitions(): Array<{
    name: string;
    description: string;
    inputSchema: import("./types.js").ToolInputSchema;
  }> {
    if (!this.sealed) throw new Error("ToolRegistry must be sealed before use");
    return [...this.tools.values(), ...[...this.dynamic.values()].flatMap((tools) => [...tools.values()])]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }
}
