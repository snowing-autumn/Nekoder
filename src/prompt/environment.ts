import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { PromptEnvironment } from "./assembler.js";

export function collectPromptEnvironment(
  workspace: string,
  options: { readonly model: string; readonly shell: string },
  now: Date = new Date()
): PromptEnvironment {
  const resolvedWorkspace = realpathSync(workspace);
  const git = inspectGit(resolvedWorkspace);
  return {
    workspace: resolvedWorkspace,
    platform: process.platform,
    architecture: process.arch,
    shell: options.shell,
    gitRepository: git.repository,
    gitBranch: git.branch,
    model: options.model,
    localDate: localDate(now),
  };
}

function inspectGit(workspace: string): { repository: string; branch: string } {
  const marker = join(workspace, ".git");
  if (!existsSync(marker)) return { repository: "not-applicable", branch: "not-applicable" };
  try {
    const info = statSync(marker);
    let gitDirectory: string;
    if (info.isDirectory()) {
      gitDirectory = marker;
    } else if (info.isFile()) {
      const pointer = readFileSync(marker, "utf8").trim();
      if (!pointer.startsWith("gitdir:")) return unavailable();
      const target = pointer.slice("gitdir:".length).trim();
      gitDirectory = isAbsolute(target) ? target : resolve(dirname(marker), target);
    } else {
      return unavailable();
    }
    const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) {
      return { repository: "true", branch: head.slice("ref: refs/heads/".length) };
    }
    if (/^[a-f0-9]{40,64}$/iu.test(head)) {
      return { repository: "true", branch: `detached:${head.slice(0, 7)}` };
    }
    return unavailable();
  } catch {
    return unavailable();
  }
}

function unavailable(): { repository: string; branch: string } {
  return { repository: "unavailable", branch: "unavailable" };
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
