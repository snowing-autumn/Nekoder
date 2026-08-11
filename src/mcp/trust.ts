import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";

import type { McpServerConfig } from "../config/config.js";

interface TrustEntry {
  readonly workspace: string;
  readonly server: string;
  readonly sha256: string;
}

export class McpTrustStore {
  private readonly path: string;

  constructor(options: { readonly homeDir: string }) {
    this.path = join(options.homeDir, ".nekoder", "mcp-trust.yaml");
  }

  isTrusted(workspace: string, serverName: string, config: McpServerConfig): boolean {
    if (config.source === "user" || "enabled" in config && config.enabled === false) return true;
    const expected = trustEntry(workspace, serverName, config);
    return this.read().some((entry) =>
      entry.workspace === expected.workspace
      && entry.server === expected.server
      && entry.sha256 === expected.sha256
    );
  }

  async trust(workspace: string, serverName: string, config: McpServerConfig): Promise<void> {
    if (config.source === "user" || "enabled" in config && config.enabled === false) return;
    const entry = trustEntry(workspace, serverName, config);
    const retained = this.read().filter((candidate) =>
      candidate.workspace !== entry.workspace || candidate.server !== entry.server
    );
    const contents = dumpYaml({ version: 1, trusted: [...retained, entry] }, { noRefs: true, lineWidth: -1 });
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private read(): TrustEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = parseYaml(readFileSync(this.path, "utf8"), { json: true });
      if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.trusted)) return [];
      return raw.trusted.filter(isTrustEntry);
    } catch {
      return [];
    }
  }
}

function trustEntry(
  workspace: string,
  server: string,
  config: McpServerConfig
): TrustEntry {
  return {
    workspace: realpathSync(workspace),
    server,
    sha256: createHash("sha256").update(canonicalJson(withoutSource(config))).digest("hex"),
  };
}

function withoutSource(config: McpServerConfig): Record<string, unknown> {
  const { source: _source, ...value } = config;
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isTrustEntry(value: unknown): value is TrustEntry {
  return isRecord(value)
    && typeof value.workspace === "string"
    && typeof value.server === "string"
    && typeof value.sha256 === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
