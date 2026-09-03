import type { ZentaoSettings } from "./settings-store.js";
import { ZENTAO_API_BASE_PATH } from "./settings-store.js";

const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 100;

type FetchImplementation = typeof fetch;

interface ZentaoPage<T> {
  page?: number;
  total?: number;
  limit?: number;
  testcases?: T[];
  testtasks?: T[];
}

export interface ZentaoCaseSummary {
  id: number;
  title: string;
  status: string;
  moduleId?: number;
}

export interface ZentaoTestTaskSummary {
  id: number;
  name: string;
  status: string;
  begin: string;
  end: string;
}

export interface ZentaoCaseImportData {
  zentaoCaseId: number;
  name: string;
  steps: string;
  expectedResult: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, key: string) => {
    const codePoint = key.startsWith("#x") || key.startsWith("#X")
      ? Number.parseInt(key.slice(2), 16)
      : key.startsWith("#") ? Number.parseInt(key.slice(1), 10) : undefined;
    if (codePoint !== undefined) {
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return named[key.toLowerCase()] ?? entity;
  });
}

export function normalizeZentaoText(value: unknown): string {
  if (typeof value !== "string") return "";
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:div|li|ol|p|table|tr|ul)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\r\n?/g, "\n"),
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function apiErrorMessage(payload: unknown, status: number): string {
  const value = record(payload);
  const message = value.message || value.error;
  return typeof message === "string" && message.trim() ? message.trim() : `禅道接口请求失败 (${status})`;
}

function isScene(value: Record<string, unknown>): boolean {
  return value.isScene === true || value.isScene === 1 || value.isScene === "1";
}

function caseSummary(value: unknown): ZentaoCaseSummary | undefined {
  const item = record(value);
  if (isScene(item)) return undefined;
  const id = positiveInteger(item.case ?? item.caseID ?? item.id);
  const title = normalizeZentaoText(item.title);
  if (!id || !title) return undefined;
  return {
    id,
    title,
    status: normalizeZentaoText(item.caseStatus ?? item.status),
    moduleId: positiveInteger(item.module),
  };
}

function testTaskSummary(value: unknown): ZentaoTestTaskSummary | undefined {
  const item = record(value);
  const id = positiveInteger(item.id);
  const name = normalizeZentaoText(item.name);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    status: normalizeZentaoText(item.status),
    begin: normalizeZentaoText(item.begin),
    end: normalizeZentaoText(item.end),
  };
}

export class ZentaoClient {
  private token = "";
  private tokenPromise?: Promise<string>;
  private readonly rootUrl: URL;

  constructor(
    private readonly settings: ZentaoSettings,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {
    this.rootUrl = new URL(`${settings.baseUrl.replace(/\/+$/, "")}${ZENTAO_API_BASE_PATH}/`);
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiErrorMessage(payload, response.status));
    return payload;
  }

  private async requestToken(): Promise<string> {
    const response = await this.fetchImplementation(new URL("tokens", this.rootUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ account: this.settings.account, password: this.settings.password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = record(await this.parseResponse(response));
    if (typeof payload.token !== "string" || !payload.token) throw new Error("禅道登录响应中没有 Token");
    return payload.token;
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    this.tokenPromise ??= this.requestToken().then((token) => {
      this.token = token;
      return token;
    }).finally(() => {
      this.tokenPromise = undefined;
    });
    return this.tokenPromise;
  }

  private async request<T>(path: string, retryAuthentication = true): Promise<T> {
    const token = await this.getToken();
    const response = await this.fetchImplementation(new URL(path, this.rootUrl), {
      headers: { Token: token, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if ((response.status === 401 || response.status === 403) && retryAuthentication) {
      this.token = "";
      return this.request<T>(path, false);
    }
    return await this.parseResponse(response) as T;
  }

  async testConnection(): Promise<void> {
    await this.request("products?limit=1");
  }

  async listProductCases(productId: number): Promise<ZentaoCaseSummary[]> {
    const results: ZentaoCaseSummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const payload = await this.request<ZentaoPage<unknown>>(
        `products/${productId}/testcases?page=${page}&limit=${PAGE_LIMIT}`,
      );
      const items = Array.isArray(payload.testcases) ? payload.testcases : [];
      results.push(...items.map(caseSummary).filter((item): item is ZentaoCaseSummary => Boolean(item)));
      if (!items.length || items.length < PAGE_LIMIT || page * PAGE_LIMIT >= (payload.total || 0)) break;
    }
    return [...new Map(results.map((item) => [item.id, item])).values()];
  }

  async listTestTasks(productId: number): Promise<ZentaoTestTaskSummary[]> {
    const results: ZentaoTestTaskSummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const payload = await this.request<ZentaoPage<unknown>>(
        `testtasks?product=${productId}&page=${page}&limit=${PAGE_LIMIT}`,
      );
      const items = Array.isArray(payload.testtasks) ? payload.testtasks : [];
      results.push(...items.map(testTaskSummary).filter((item): item is ZentaoTestTaskSummary => Boolean(item)));
      if (!items.length || items.length < PAGE_LIMIT || page * PAGE_LIMIT >= (payload.total || 0)) break;
    }
    return results;
  }

  async listTestTaskCases(testTaskId: number, expectedProductId?: number): Promise<ZentaoCaseSummary[]> {
    const results: ZentaoCaseSummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const payload = await this.request<Record<string, unknown>>(
        `testtasks/${testTaskId}?page=${page}&limit=${PAGE_LIMIT}`,
      );
      if (expectedProductId && positiveInteger(payload.product) !== expectedProductId) {
        throw new Error("所选禅道测试单不属于当前产品");
      }
      const items = Array.isArray(payload.testcases) ? payload.testcases : [];
      results.push(...items.map(caseSummary).filter((item): item is ZentaoCaseSummary => Boolean(item)));
      if (!items.length || items.length < PAGE_LIMIT) break;
    }
    return [...new Map(results.map((item) => [item.id, item])).values()];
  }

  async getCaseImportData(caseId: number, expectedProductId?: number): Promise<ZentaoCaseImportData> {
    const item = await this.request<Record<string, unknown>>(`testcases/${caseId}`);
    if (expectedProductId && positiveInteger(item.product) !== expectedProductId) {
      throw new Error(`禅道用例 #${caseId} 不属于当前产品`);
    }
    const steps = Array.isArray(item.steps) ? item.steps.map(record) : [];
    const stepPairs = steps
      .map((step) => ({ description: normalizeZentaoText(step.desc), expectation: normalizeZentaoText(step.expect) }))
      .filter((step) => step.description);
    const precondition = normalizeZentaoText(item.precondition);
    const numberedSteps = stepPairs.map((step, index) => `${index + 1}. ${step.description}`);
    const numberedExpectations = stepPairs.map(
      (step, index) => `${index + 1}. ${step.expectation || "未提供预期结果"}`,
    );
    const stepText = [precondition ? `前置条件：${precondition}` : "", ...numberedSteps].filter(Boolean).join("\n");

    return {
      zentaoCaseId: positiveInteger(item.caseID ?? item.id) || caseId,
      name: normalizeZentaoText(item.title) || `禅道用例 #${caseId}`,
      steps: stepText || "禅道用例未提供测试步骤",
      expectedResult: numberedExpectations.join("\n") || "禅道用例未提供预期结果",
    };
  }

  async getCasesImportData(caseIds: number[], expectedProductId?: number): Promise<ZentaoCaseImportData[]> {
    const results: ZentaoCaseImportData[] = [];
    const uniqueIds = [...new Set(caseIds)];
    for (let index = 0; index < uniqueIds.length; index += 5) {
      results.push(...await Promise.all(
        uniqueIds.slice(index, index + 5).map((id) => this.getCaseImportData(id, expectedProductId)),
      ));
    }
    return results;
  }
}

let cachedClient: { key: string; client: ZentaoClient } | undefined;

export function getZentaoClient(settings: ZentaoSettings): ZentaoClient {
  const key = JSON.stringify([settings.baseUrl, settings.account, settings.password]);
  if (!cachedClient || cachedClient.key !== key) cachedClient = { key, client: new ZentaoClient(settings) };
  return cachedClient.client;
}
