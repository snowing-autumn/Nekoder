import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { fetchModels, getContext, type ModelCatalog } from "tokenlens";

export const PROTOCOLS = ["anthropic", "openai", "openai-compat"] as const;

export type Protocol = (typeof PROTOCOLS)[number];

// AI SDK 的跨 provider 统一推理力度。Anthropic 会翻成 adaptive thinking 的
// effort 或 budget_tokens，OpenAI / 中转站翻成 reasoning_effort；不配就什么
// 都不发。
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const ENV_KEYS: Record<Protocol, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-compat": "OPENAI_API_KEY",
};

// protocol 对应到 models.dev 目录里的 provider id。openai-compat 指向任意中转站，
// 没有固定的 provider，只能跨目录按模型名搜。
const CATALOG_PROVIDERS: Record<Protocol, string | undefined> = {
  anthropic: "anthropic",
  openai: "openai",
  "openai-compat": undefined,
};

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const CATALOG_TIMEOUT_MS = 10_000;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_CACHE_FILE = join(homedir(), ".mewcode", "models-cache.json");

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ProviderConfig {
  name: string;
  protocol: Protocol;
  base_url: string;
  model: string;
  api_key?: string;
  /** 推理力度，三种协议通用。与 thinking 同时出现时以本字段为准。 */
  reasoning?: ReasoningEffort;
  /** reasoning 的布尔简写：true 等价于 reasoning: "high"。 */
  thinking?: boolean;
  context_window?: number;
  max_output_tokens?: number;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
}

export interface Config {
  providers: ProviderConfig[];
  mcp_servers: McpServerConfig[];
  enable_coordinator_mode: boolean;
}

const CONFIG_CANDIDATES = [
  join(".mewcode", "config.yaml"),
  "config.yaml",
];

export function loadConfig(cwd: string = process.cwd()): Config {
  const path = findConfigFile(cwd);
  if (!path) {
    throw new ConfigError(
      "找不到配置文件。请创建 .mewcode/config.yaml 或 ~/.mewcode/config.yaml。"
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`解析 ${path} 失败：${String(err)}`);
  }

  return parseConfig(raw, path);
}

function findConfigFile(cwd: string): string | undefined {
  const candidates = [
    ...CONFIG_CANDIDATES.map((p) => join(cwd, p)),
    join(homedir(), ".mewcode", "config.yaml"),
  ];
  return candidates.find((p) => existsSync(p));
}

function parseConfig(raw: unknown, path: string): Config {
  const root = raw as Partial<Config> | null;
  const providers = root?.providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new ConfigError(`${path} 里没有配置任何 provider。`);
  }

  providers.forEach((p, i) => validateProvider(p, `${path} providers[${i}]`));

  return {
    providers,
    mcp_servers: Array.isArray(root?.mcp_servers) ? root.mcp_servers : [],
    enable_coordinator_mode: root?.enable_coordinator_mode === true,
  };
}

function validateProvider(p: ProviderConfig, where: string): void {
  for (const field of ["name", "protocol", "base_url", "model"] as const) {
    if (!p?.[field]) throw new ConfigError(`${where} 缺少必填字段 ${field}。`);
  }
  if (!(PROTOCOLS as readonly string[]).includes(p.protocol)) {
    throw new ConfigError(
      `${where} 的 protocol "${p.protocol}" 无效，必须是 ${PROTOCOLS.join(" / ")} 之一。`
    );
  }
  if (
    p.reasoning !== undefined &&
    !(REASONING_EFFORTS as readonly string[]).includes(p.reasoning)
  ) {
    throw new ConfigError(
      `${where} 的 reasoning "${p.reasoning}" 无效，必须是 ${REASONING_EFFORTS.join(" / ")} 之一。`
    );
  }
}

// 未配置时返回 undefined，调用方就不会下发 reasoning 参数——不支持该参数的
// 中转站会直接拒掉请求，所以默认必须是“什么都不发”。
export function resolveReasoning(
  cfg: ProviderConfig
): ReasoningEffort | undefined {
  if (cfg.reasoning) return cfg.reasoning;
  return cfg.thinking ? "high" : undefined;
}

export function resolveAPIKey(cfg: ProviderConfig): string | undefined {
  return cfg.api_key || process.env[ENV_KEYS[cfg.protocol]] || undefined;
}

export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

// 三层回退：配置里显式写的值 > models.dev 目录（经 tokenlens）> 保守默认值。
// 目录查询是尽力而为的，超时或模型不在目录里都静默降级，不阻塞启动。
export async function resolveModelLimits(
  cfg: ProviderConfig
): Promise<ModelLimits> {
  const caps = await lookupModelCaps(cfg);
  return {
    // models.dev 多数模型只给出 limit.context（总窗口），maxTotal 才是上下文
    // 窗口；只有少数模型另外标了 limit.input，那时 maxInput 作为补充。
    contextWindow:
      pickPositive(cfg.context_window) ??
      pickPositive(caps?.maxTotal ?? caps?.maxInput) ??
      fallbackContextWindow(cfg.model),
    maxOutputTokens:
      pickPositive(cfg.max_output_tokens) ??
      pickPositive(caps?.maxOutput) ??
      DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

function pickPositive(value: number | undefined): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function fallbackContextWindow(model: string): number {
  return model.toLowerCase().includes("claude") ? 200_000 : 128_000;
}

interface CatalogCache {
  fetchedAt: number;
  catalog: ModelCatalog;
}

let catalogPromise: Promise<ModelCatalog | null> | undefined;

// models.dev 的完整目录有 3MB 多、拉一次要好几秒，所以落盘缓存一天，
// 只有首次运行或缓存过期时才走网络。
function loadCatalog(): Promise<ModelCatalog | null> {
  catalogPromise ??= (async () => {
    const cached = readCatalogCache();
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
      return cached.catalog;
    }
    try {
      const catalog = await fetchModels({
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      });
      writeCatalogCache(catalog);
      return catalog;
    } catch {
      // 网络不通时宁可用过期缓存，也好过退到粗糙的默认值
      return cached?.catalog ?? null;
    }
  })();
  return catalogPromise;
}

function readCatalogCache(): CatalogCache | undefined {
  try {
    return JSON.parse(readFileSync(CATALOG_CACHE_FILE, "utf8")) as CatalogCache;
  } catch {
    return undefined;
  }
}

function writeCatalogCache(catalog: ModelCatalog): void {
  try {
    mkdirSync(dirname(CATALOG_CACHE_FILE), { recursive: true });
    writeFileSync(
      CATALOG_CACHE_FILE,
      JSON.stringify({ fetchedAt: Date.now(), catalog } satisfies CatalogCache)
    );
  } catch {
    // 缓存写不进去不影响主流程，下次再拉一遍就是了
  }
}

async function lookupModelCaps(cfg: ProviderConfig) {
  const providers = await loadCatalog();
  if (!providers) return undefined;

  // 先按协议对应的 provider 精确匹配，再退回无 provider 前缀的全目录搜索，
  // 这样中转站沿用官方模型名时也能查到。
  const providerId = CATALOG_PROVIDERS[cfg.protocol];
  const ids = providerId ? [`${providerId}/${cfg.model}`, cfg.model] : [cfg.model];

  for (const modelId of ids) {
    try {
      const caps = getContext({ modelId, providers });
      if (caps.maxTotal ?? caps.maxInput ?? caps.maxOutput) return caps;
    } catch {
      // 目录里没有这个 id，继续试下一个
    }
  }
  return undefined;
}
