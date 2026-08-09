import Ajv2020 from "ajv/dist/2020.js";

import type { AnyTool, ToolName } from "./types.js";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export class ToolRegistry {
  private readonly tools = new Map<ToolName, AnyTool>();
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
    return this.tools.get(name);
  }

  definitions(): Array<{
    name: string;
    description: string;
    inputSchema: import("./types.js").ToolInputSchema;
  }> {
    if (!this.sealed) throw new Error("ToolRegistry must be sealed before use");
    return [...this.tools.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }
}
