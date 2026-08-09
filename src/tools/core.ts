import { editFileTool } from "./edit-file.js";
import { createFindFilesTool } from "./find-files.js";
import { readFileTool } from "./read-file.js";
import { ToolRegistry } from "./registry.js";
import {
  createRunCommandTool,
  type RunCommandToolOptions,
} from "./run-command.js";
import { createSearchTextTool } from "./search-text.js";
import { writeFileTool } from "./write-file.js";

export interface CoreToolOptions {
  readonly skipDirs?: readonly string[];
  readonly runCommand?: RunCommandToolOptions;
}

export function createCoreToolRegistry(options: CoreToolOptions = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(editFileTool);
  registry.register(createFindFilesTool(options.skipDirs));
  registry.register(readFileTool);
  registry.register(createRunCommandTool(options.runCommand));
  registry.register(createSearchTextTool(options.skipDirs));
  registry.register(writeFileTool);
  registry.seal();
  return registry;
}
