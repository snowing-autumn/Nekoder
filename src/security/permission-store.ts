import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dump as stringifyYaml, load as parseYaml } from "js-yaml";

import type { PersistentRuleWriter } from "../tools/runner.js";
import type { PermissionRule } from "./types.js";

export class PermissionRuleFileStore implements PersistentRuleWriter {
  private readonly home: string;

  constructor(
    private readonly workspace: string,
    options: { readonly homeDir?: string } = {}
  ) {
    this.home = options.homeDir ?? homedir();
  }

  async add(scope: "local" | "user", rule: PermissionRule): Promise<void> {
    const target = scope === "local"
      ? join(this.workspace, ".nekoder", "permissions.local.yaml")
      : join(this.home, ".nekoder", "permissions.yaml");
    const document = readDocument(target);
    const rules = Array.isArray(document.rules) ? document.rules : [];
    if (rules.some((item) => isObject(item) && item.id === rule.id)) {
      throw new Error(`Permission rule id already exists: ${rule.id}`);
    }
    const next = {
      ...document,
      version: 1,
      rules: [...rules, rule],
    };
    const serialized = stringifyYaml(next, { noRefs: true, lineWidth: -1 });
    await mkdir(dirname(target), { recursive: true });
    const temporary = join(
      dirname(target),
      `.permissions-${randomBytes(12).toString("hex")}.tmp`
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function readDocument(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { version: 1, rules: [] };
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${path} must be a regular, non-symbolic-link file`);
  }
  const parsed = parseYaml(readFileSync(path, "utf8"));
  if (!isObject(parsed) || parsed.version !== 1) {
    throw new Error(`${path} is not a supported permission file`);
  }
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
