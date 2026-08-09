import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";

import type {
  PermissionMode,
  PermissionRule,
  PermissionRuleSource,
} from "./types.js";

const MODES = new Set<PermissionMode>([
  "strict",
  "plan",
  "default",
  "acceptEdit",
  "permissive",
]);
const MAX_FILE_BYTES = 1024 * 1024;

export class PermissionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionConfigError";
  }
}

export interface LoadedPermissionConfig {
  readonly mode: PermissionMode;
  readonly rules: Record<PermissionRuleSource, readonly PermissionRule[]>;
  readonly sensitiveReads: readonly string[];
}

interface PermissionFile {
  readonly mode?: PermissionMode;
  readonly rules: readonly PermissionRule[];
  readonly sensitiveReads: readonly string[];
}

export function loadPermissionConfig(
  workspace: string,
  options: { readonly homeDir?: string } = {}
): LoadedPermissionConfig {
  const home = options.homeDir ?? homedir();
  const projectPath = join(workspace, ".nekoder", "permissions.yaml");
  const user = readPermissionFile(join(home, ".nekoder", "permissions.yaml"), true);
  const project = readPermissionFile(projectPath, false);
  const local = readPermissionFile(
    join(workspace, ".nekoder", "permissions.local.yaml"),
    true
  );
  return {
    mode: local?.mode ?? user?.mode ?? "default",
    rules: {
      session: [],
      local: local?.rules ?? [],
      project: project === undefined
        ? []
        : isProjectRuleFileTrusted(projectPath, workspace, home)
          ? project.rules
          : project.rules.filter((rule) => rule.decision === "deny"),
      user: user?.rules ?? [],
    },
    sensitiveReads: [
      ...(user?.sensitiveReads ?? []),
      ...(project?.sensitiveReads ?? []),
      ...(local?.sensitiveReads ?? []),
    ],
  };
}

function isProjectRuleFileTrusted(projectPath: string, workspace: string, home: string): boolean {
  if (!existsSync(projectPath)) return false;
  const trustPath = join(home, ".nekoder", "project-rule-trust.yaml");
  if (!existsSync(trustPath)) return false;
  const info = lstatSync(trustPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return false;
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(trustPath, "utf8"));
  } catch {
    return false;
  }
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.trusted)) return false;
  const realWorkspace = realpathSync(workspace);
  const sha256 = createHash("sha256").update(readFileSync(projectPath)).digest("hex");
  return raw.trusted.some(
    (entry) => isObject(entry)
      && entry.workspace === realWorkspace
      && entry.sha256 === sha256
  );
}

function readPermissionFile(path: string, allowMode: boolean): PermissionFile | undefined {
  if (!existsSync(path)) return undefined;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new PermissionConfigError(`${path} must be a regular, non-symbolic-link file`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new PermissionConfigError(`${path} exceeds the 1 MiB limit`);
  }
  const text = readFileSync(path, "utf8");
  if (containsForbiddenYamlSyntax(text)) {
    throw new PermissionConfigError(`${path} contains forbidden YAML alias, merge, or tag syntax`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new PermissionConfigError(`Unable to parse ${path}: ${String(error)}`);
  }
  if (!isObject(raw)) throw new PermissionConfigError(`${path} must contain an object`);
  const unknown = Object.keys(raw).find(
    (key) => !["version", "mode", "sensitive_reads", "rules"].includes(key)
  );
  if (unknown) throw new PermissionConfigError(`${path} contains unknown field ${unknown}`);
  if (raw.version !== 1) throw new PermissionConfigError(`${path} version must be 1`);
  if (raw.mode !== undefined && !allowMode) {
    throw new PermissionConfigError(`${path} cannot specify mode`);
  }
  if (raw.mode !== undefined && !MODES.has(raw.mode as PermissionMode)) {
    throw new PermissionConfigError(`${path} contains invalid mode`);
  }
  const rules = raw.rules ?? [];
  if (!Array.isArray(rules) || rules.length > 1000) {
    throw new PermissionConfigError(`${path} rules must be an array of at most 1000 entries`);
  }
  const parsedRules = rules.map((rule, index) => parseRule(rule, path, index));
  const ids = new Set<string>();
  for (const rule of parsedRules) {
    if (ids.has(rule.id)) throw new PermissionConfigError(`${path} contains duplicate rule id ${rule.id}`);
    ids.add(rule.id);
  }
  const sensitiveReads = raw.sensitive_reads ?? [];
  if (!Array.isArray(sensitiveReads) || sensitiveReads.some((item) => typeof item !== "string")) {
    throw new PermissionConfigError(`${path} sensitive_reads must be a string array`);
  }
  return {
    ...(raw.mode === undefined ? {} : { mode: raw.mode as PermissionMode }),
    rules: parsedRules,
    sensitiveReads,
  };
}

function parseRule(raw: unknown, path: string, index: number): PermissionRule {
  if (!isObject(raw)) throw new PermissionConfigError(`${path} rules[${index}] must be an object`);
  const unknown = Object.keys(raw).find(
    (key) => !["id", "tool", "match", "decision", "comment"].includes(key)
  );
  if (unknown) throw new PermissionConfigError(`${path} rules[${index}] contains unknown field ${unknown}`);
  if (typeof raw.id !== "string" || Buffer.byteLength(raw.id, "utf8") > 128) {
    throw new PermissionConfigError(`${path} rules[${index}].id is invalid`);
  }
  if (typeof raw.tool !== "string") {
    throw new PermissionConfigError(`${path} rules[${index}] requires a string tool`);
  }
  const match = parseMatch(raw.match, path, index);
  if (raw.decision !== "allow" && raw.decision !== "deny") {
    throw new PermissionConfigError(`${path} rules[${index}].decision is invalid`);
  }
  if (raw.comment !== undefined && typeof raw.comment !== "string") {
    throw new PermissionConfigError(`${path} rules[${index}].comment must be a string`);
  }
  if (typeof raw.comment === "string" && Buffer.byteLength(raw.comment, "utf8") > 4 * 1024) {
    throw new PermissionConfigError(`${path} rules[${index}].comment exceeds 4 KiB`);
  }
  return {
    id: raw.id,
    tool: raw.tool,
    match,
    decision: raw.decision,
    ...(raw.comment === undefined ? {} : { comment: raw.comment }),
  };
}

function parseMatch(
  raw: unknown,
  path: string,
  index: number
): import("./types.js").PermissionRule["match"] {
  if (typeof raw === "string") {
    assertMatchLimit(raw, path, index);
    return raw;
  }
  if (!isObject(raw)) {
    throw new PermissionConfigError(`${path} rules[${index}].match must be a string or object`);
  }
  const unknown = Object.keys(raw).find((key) => !["command", "cwd", "path"].includes(key));
  if (unknown) throw new PermissionConfigError(`${path} rules[${index}].match contains unknown field ${unknown}`);
  if (Object.keys(raw).length === 0 || Object.values(raw).some((value) => typeof value !== "string")) {
    throw new PermissionConfigError(`${path} rules[${index}].match constraints must be strings`);
  }
  for (const value of Object.values(raw)) assertMatchLimit(value as string, path, index);
  return raw;
}

function assertMatchLimit(value: string, path: string, index: number): void {
  if (Buffer.byteLength(value, "utf8") > 4 * 1024) {
    throw new PermissionConfigError(`${path} rules[${index}].match exceeds 4 KiB`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsForbiddenYamlSyntax(text: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#") {
      while (index < text.length && text[index] !== "\n") index++;
      continue;
    }
    const previous = index === 0 ? "\n" : text[index - 1]!;
    const next = text[index + 1] ?? "";
    const tokenBoundary = /[\s:[{,]/u.test(previous);
    if (tokenBoundary && (character === "&" || character === "*" || character === "!") && /[A-Za-z_]/u.test(next)) {
      return true;
    }
    if (character === "<" && text[index + 1] === "<" && /^\s*:/u.test(text.slice(index + 2))) {
      return true;
    }
  }
  return false;
}
