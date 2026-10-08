import type { ZentaoSettings } from "./settings-store.js";
import type { TestCaseStep } from "../shared/test-case-steps.js";
import { ZENTAO_API_BASE_PATH, ZENTAO_API_V2_BASE_PATH } from "./settings-store.js";

const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 100;

type FetchImplementation = typeof fetch;
type ApiVersion = "v1" | "v2";
type PathResolver = string | ((version: ApiVersion) => string);

interface ApiSession {
  token: string;
  version: ApiVersion;
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
  precondition: string;
  steps: string;
  expectedResult: string;
  stepRows: TestCaseStep[];
}

class ZentaoResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "http" | "empty" | "non-json",
  ) {
    super(message);
    this.name = "ZentaoResponseError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function entityId(value: unknown): number | undefined {
  return positiveInteger(value) ?? positiveInteger(record(value).id);
}

function arrayItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
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
  const message = value.message ?? value.error ?? value.reason;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (message && typeof message === "object") {
    const nestedMessage = record(message).message;
    if (typeof nestedMessage === "string" && nestedMessage.trim()) return nestedMessage.trim();
  }
  return `禅道接口请求失败 (${status})`;
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
    moduleId: entityId(item.module),
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

function hasNextPage(payload: Record<string, unknown>, page: number, itemCount: number, version: ApiVersion): boolean {
  if (version === "v2") {
    const pager = record(payload.pager);
    const currentPage = positiveInteger(pager.pageID) ?? page;
    const pageTotal = nonNegativeNumber(pager.pageTotal);
    if (pageTotal !== undefined) return currentPage < pageTotal;

    const total = nonNegativeNumber(pager.recTotal);
    const perPage = positiveInteger(pager.recPerPage);
    if (total !== undefined && perPage !== undefined) return currentPage * perPage < total;

    // v2 默认分页大小由服务端决定，缺少 pager 时无法用请求的 limit 可靠推断下一页。
    return false;
  }

  const total = nonNegativeNumber(payload.total);
  const limit = positiveInteger(payload.limit) ?? PAGE_LIMIT;
  if (total !== undefined) return page * limit < total;
  return itemCount >= limit;
}

function isVersionCompatibilityError(error: unknown): boolean {
  return error instanceof ZentaoResponseError
    && (error.kind === "empty" || error.kind === "non-json" || error.status === 404 || error.status === 405);
}

function productIdFromTaskCases(payload: Record<string, unknown>, version: ApiVersion): number | undefined {
  if (version === "v1") return entityId(payload.product);
  return entityId(record(payload.task).product)
    ?? entityId(record(payload.testtask).product)
    ?? entityId(payload.product);
}

export class ZentaoClient {
  private token = "";
  private apiVersion?: ApiVersion;
  private sessionPromise?: Promise<ApiSession>;
  private readonly rootUrls: Record<ApiVersion, URL>;

  constructor(
    private readonly settings: ZentaoSettings,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {
    const baseUrl = settings.baseUrl.replace(/\/+$/, "");
    this.rootUrls = {
      v1: new URL(`${baseUrl}${ZENTAO_API_BASE_PATH}/`),
      v2: new URL(`${baseUrl}${ZENTAO_API_V2_BASE_PATH}/`),
    };
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const body = await response.text();
    if (!body.trim()) {
      throw new ZentaoResponseError(
        response.ok ? `禅道接口返回了空响应 (${response.status})` : `禅道接口请求失败 (${response.status})`,
        response.status,
        "empty",
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new ZentaoResponseError(`禅道接口返回了非 JSON 响应 (${response.status})`, response.status, "non-json");
    }
    if (!response.ok) throw new ZentaoResponseError(apiErrorMessage(payload, response.status), response.status, "http");
    return payload;
  }

  private async requestToken(version: ApiVersion): Promise<string> {
    const path = version === "v2" ? "users/login" : "tokens";
    const response = await this.fetchImplementation(new URL(path, this.rootUrls[version]), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ account: this.settings.account, password: this.settings.password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const payload = record(await this.parseResponse(response));
    if (typeof payload.token === "string" && payload.token) return payload.token;

    const loginError = apiErrorMessage(payload, response.status);
    if (payload.status === "error" || payload.status === "fail" || payload.status === "failed") {
      throw new ZentaoResponseError(loginError, response.status, "http");
    }
    throw new ZentaoResponseError(`禅道 ${version} 登录响应中没有 Token`, response.status, "non-json");
  }

  private async createSession(): Promise<ApiSession> {
    try {
      return { token: await this.requestToken("v2"), version: "v2" };
    } catch (error) {
      if (!isVersionCompatibilityError(error)) throw error;
      return { token: await this.requestToken("v1"), version: "v1" };
    }
  }

  private async getSession(): Promise<ApiSession> {
    if (this.token && this.apiVersion) return { token: this.token, version: this.apiVersion };
    this.sessionPromise ??= this.createSession().then((session) => {
      this.token = session.token;
      this.apiVersion = session.version;
      return session;
    }).finally(() => {
      this.sessionPromise = undefined;
    });
    return this.sessionPromise;
  }

  private clearSession(): void {
    this.token = "";
    this.apiVersion = undefined;
  }

  private async request<T>(path: PathResolver, retryAuthentication = true): Promise<{ payload: T; version: ApiVersion }> {
    const { token, version } = await this.getSession();
    const resolvedPath = typeof path === "function" ? path(version) : path;
    const response = await this.fetchImplementation(new URL(resolvedPath, this.rootUrls[version]), {
      headers: { Token: token, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if ((response.status === 401 || response.status === 403) && retryAuthentication) {
      this.clearSession();
      return this.request<T>(path, false);
    }
    return { payload: await this.parseResponse(response) as T, version };
  }

  async testConnection(): Promise<void> {
    await this.request((version) => version === "v2" ? "products?pageID=1&limit=1" : "products?page=1&limit=1");
  }

  async listProductCases(productId: number): Promise<ZentaoCaseSummary[]> {
    const results: ZentaoCaseSummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { payload: rawPayload, version } = await this.request<Record<string, unknown>>((apiVersion) =>
        apiVersion === "v2"
          ? `products/${productId}/testcases?pageID=${page}&limit=${PAGE_LIMIT}`
          : `products/${productId}/testcases?page=${page}&limit=${PAGE_LIMIT}`,
      );
      const payload = record(rawPayload);
      const items = arrayItems(payload.testcases);
      results.push(...items.map(caseSummary).filter((item): item is ZentaoCaseSummary => Boolean(item)));
      if (!hasNextPage(payload, page, items.length, version)) break;
    }
    return [...new Map(results.map((item) => [item.id, item])).values()];
  }

  async listTestTasks(productId: number): Promise<ZentaoTestTaskSummary[]> {
    const results: ZentaoTestTaskSummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { payload: rawPayload, version } = await this.request<Record<string, unknown>>((apiVersion) =>
        apiVersion === "v2"
          ? `products/${productId}/testtasks?pageID=${page}&limit=${PAGE_LIMIT}`
          : `testtasks?product=${productId}&page=${page}&limit=${PAGE_LIMIT}`,
      );
      const payload = record(rawPayload);
      const items = arrayItems(payload.testtasks);
      results.push(...items.map(testTaskSummary).filter((item): item is ZentaoTestTaskSummary => Boolean(item)));
      if (!hasNextPage(payload, page, items.length, version)) break;
    }
    return [...new Map(results.map((item) => [item.id, item])).values()];
  }

  async listTestTaskCases(testTaskId: number, expectedProductId?: number): Promise<ZentaoCaseSummary[]> {
    const results: ZentaoCaseSummary[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { payload: rawPayload, version } = await this.request<Record<string, unknown>>((apiVersion) =>
        apiVersion === "v2"
          ? `testtasks/${testTaskId}/cases?testtaskID=${testTaskId}&pageID=${page}&limit=${PAGE_LIMIT}`
          : `testtasks/${testTaskId}?page=${page}&limit=${PAGE_LIMIT}`,
      );
      const payload = record(rawPayload);
      if (expectedProductId && productIdFromTaskCases(payload, version) !== expectedProductId) {
        throw new Error("所选禅道测试单不属于当前产品");
      }
      const items = arrayItems(version === "v2" ? payload.runs : payload.testcases);
      results.push(...items.map(caseSummary).filter((item): item is ZentaoCaseSummary => Boolean(item)));
      if (!hasNextPage(payload, page, items.length, version)) break;
    }
    return [...new Map(results.map((item) => [item.id, item])).values()];
  }

  async getCaseImportData(caseId: number, expectedProductId?: number): Promise<ZentaoCaseImportData> {
    const { payload, version } = await this.request<Record<string, unknown>>(`testcases/${caseId}`);
    const item = version === "v2" ? record(record(payload).testcase) : record(payload);
    if (expectedProductId && entityId(item.product) !== expectedProductId) {
      throw new Error(`禅道用例 #${caseId} 不属于当前产品`);
    }
    const steps = arrayItems(item.steps).map(record);
    const stepPairs = steps
      .map((step) => ({
        description: normalizeZentaoText(step.desc ?? step.step),
        expectation: normalizeZentaoText(step.expect),
      }))
      .filter((step) => step.description);
    const precondition = normalizeZentaoText(item.precondition);
    const numberedSteps = stepPairs.map((step, index) => `${index + 1}. ${step.description}`);
    const numberedExpectations = stepPairs.map(
      (step, index) => `${index + 1}. ${step.expectation || "未提供预期结果"}`,
    );

    return {
      zentaoCaseId: positiveInteger(item.caseID ?? item.id) || caseId,
      name: normalizeZentaoText(item.title) || `禅道用例 #${caseId}`,
      precondition,
      steps: numberedSteps.join("\n") || "禅道用例未提供测试步骤",
      expectedResult: numberedExpectations.join("\n") || "禅道用例未提供预期结果",
      stepRows: stepPairs.length ? stepPairs.map((row) => ({ step: row.description, expected: row.expectation })) : [{ step: "禅道用例未提供测试步骤", expected: "禅道用例未提供预期结果" }],
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
