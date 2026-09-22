import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const API_TYPES = [
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type ApiType = (typeof API_TYPES)[number];

export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface ModelSettings {
  providerPreset: string;
  apiType: ApiType;
  model: string;
  baseUrl: string;
  apiKey: string;
  userAgent: string;
  reasoningLevel: ReasoningLevel;
}

export interface PublicModelSettings extends Omit<ModelSettings, "apiKey"> {
  hasApiKey: boolean;
  maskedApiKey: string;
  configured: boolean;
}

export interface ZentaoSettings {
  baseUrl: string;
  account: string;
  password: string;
}

export interface PublicZentaoSettings extends Omit<ZentaoSettings, "password"> {
  hasPassword: boolean;
  configured: boolean;
}

const DEFAULT_SETTINGS: ModelSettings = {
  providerPreset: "openai",
  apiType: "openai-responses",
  model: "",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  userAgent: "codex-tui/0.151.0",
  reasoningLevel: "medium",
};

const DEFAULT_ZENTAO_SETTINGS: ZentaoSettings = {
  baseUrl: "",
  account: "",
  password: "",
};

export const ZENTAO_API_BASE_PATH = "/api.php/v1";
export const ZENTAO_API_V2_BASE_PATH = "/api.php/v2";

const dataDirectory = path.resolve(process.cwd(), ".data");
const settingsPath = path.join(dataDirectory, "model-settings.json");
const zentaoSettingsPath = path.join(dataDirectory, "zentao-settings.json");

function isApiType(value: unknown): value is ApiType {
  return typeof value === "string" && API_TYPES.includes(value as ApiType);
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && REASONING_LEVELS.includes(value as ReasoningLevel);
}

function normalizeUserAgent(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SETTINGS.userAgent;
  const userAgent = value.trim();
  if (userAgent.length > 512) {
    throw new Error("User-Agent 不能超过 512 个字符");
  }
  if (/[\r\n]/.test(userAgent)) {
    throw new Error("User-Agent 不能包含换行符");
  }
  return userAgent;
}

function normalizeUrl(value: unknown, label = "API 地址"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}不能为空`);
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label}格式不正确`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label}必须使用 http 或 https`);
  }

  return url.toString().replace(/\/$/, "");
}

function usesLocalEndpoint(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export async function readModelSettings(): Promise<ModelSettings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Partial<ModelSettings>;
    return {
      providerPreset: typeof raw.providerPreset === "string" ? raw.providerPreset : DEFAULT_SETTINGS.providerPreset,
      apiType: isApiType(raw.apiType) ? raw.apiType : DEFAULT_SETTINGS.apiType,
      model: typeof raw.model === "string" ? raw.model : "",
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : DEFAULT_SETTINGS.baseUrl,
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
      userAgent: typeof raw.userAgent === "string" ? normalizeUserAgent(raw.userAgent) : DEFAULT_SETTINGS.userAgent,
      reasoningLevel: isReasoningLevel(raw.reasoningLevel) ? raw.reasoningLevel : DEFAULT_SETTINGS.reasoningLevel,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_SETTINGS };
    }
    throw error;
  }
}

export async function saveModelSettings(input: unknown): Promise<ModelSettings> {
  if (!input || typeof input !== "object") {
    throw new Error("配置格式不正确");
  }

  const current = await readModelSettings();
  const value = input as Record<string, unknown>;
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const apiKey = typeof value.apiKey === "string" && value.apiKey.trim() ? value.apiKey.trim() : current.apiKey;

  if (!model) {
    throw new Error("模型名称不能为空");
  }
  if (!isApiType(value.apiType)) {
    throw new Error("不支持的 API 类型");
  }
  if (!isReasoningLevel(value.reasoningLevel)) {
    throw new Error("不支持的推理强度");
  }

  const settings: ModelSettings = {
    providerPreset: typeof value.providerPreset === "string" ? value.providerPreset : "custom",
    apiType: value.apiType,
    model,
    baseUrl: normalizeUrl(value.baseUrl),
    apiKey,
    userAgent: normalizeUserAgent(value.userAgent),
    reasoningLevel: value.reasoningLevel,
  };

  if (!settings.apiKey && !usesLocalEndpoint(settings.baseUrl)) {
    throw new Error("API Key 不能为空");
  }

  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${settingsPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, settingsPath);
  return settings;
}

export function toPublicSettings(settings: ModelSettings): PublicModelSettings {
  const hasApiKey = Boolean(settings.apiKey);
  const maskedApiKey = hasApiKey
    ? settings.apiKey.length <= 8
      ? "********"
      : `${settings.apiKey.slice(0, 3)}••••${settings.apiKey.slice(-4)}`
    : "";

  return {
    providerPreset: settings.providerPreset,
    apiType: settings.apiType,
    model: settings.model,
    baseUrl: settings.baseUrl,
    userAgent: settings.userAgent,
    reasoningLevel: settings.reasoningLevel,
    hasApiKey,
    maskedApiKey,
    configured: Boolean(settings.model && settings.baseUrl && (hasApiKey || usesLocalEndpoint(settings.baseUrl))),
  };
}

export async function readZentaoSettings(filePath = zentaoSettingsPath): Promise<ZentaoSettings> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Partial<ZentaoSettings>;
    return {
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : DEFAULT_ZENTAO_SETTINGS.baseUrl,
      account: typeof raw.account === "string" ? raw.account : DEFAULT_ZENTAO_SETTINGS.account,
      password: typeof raw.password === "string" ? raw.password : DEFAULT_ZENTAO_SETTINGS.password,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_ZENTAO_SETTINGS };
    }
    throw error;
  }
}

export async function saveZentaoSettings(input: unknown, filePath = zentaoSettingsPath): Promise<ZentaoSettings> {
  if (!input || typeof input !== "object") {
    throw new Error("配置格式不正确");
  }

  const current = await readZentaoSettings(filePath);
  const settings = resolveZentaoSettings(input, current);

  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
  return settings;
}

export function resolveZentaoSettings(input: unknown, current: ZentaoSettings): ZentaoSettings {
  if (!input || typeof input !== "object") {
    throw new Error("配置格式不正确");
  }
  const value = input as Record<string, unknown>;
  const baseUrl = typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl : current.baseUrl;
  const account = typeof value.account === "string" && value.account.trim() ? value.account.trim() : current.account;
  const password = typeof value.password === "string" && value.password ? value.password : current.password;

  if (!account) {
    throw new Error("禅道账号不能为空");
  }
  if (account.length > 200) {
    throw new Error("禅道账号不能超过 200 个字符");
  }
  if (!password) {
    throw new Error("禅道密码不能为空");
  }

  return {
    baseUrl: normalizeUrl(baseUrl, "禅道地址"),
    account,
    password,
  };
}

export function toPublicZentaoSettings(settings: ZentaoSettings): PublicZentaoSettings {
  const hasPassword = Boolean(settings.password);
  return {
    baseUrl: settings.baseUrl,
    account: settings.account,
    hasPassword,
    configured: Boolean(settings.baseUrl && settings.account && hasPassword),
  };
}

export const modelRuntimePaths = {
  dataDirectory,
  modelsPath: path.join(dataDirectory, "pi-models.json"),
  authPath: path.join(dataDirectory, "pi-auth.json"),
  agentDirectory: path.join(dataDirectory, "pi-agent"),
  workspaceDirectory: path.join(dataDirectory, "workspace"),
  artifactsDirectory: path.join(dataDirectory, "artifacts"),
};
