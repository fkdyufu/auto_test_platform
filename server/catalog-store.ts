import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type ExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type TestOutcome = "passed" | "failed";

export interface Product {
  id: string;
  name: string;
  description: string;
  zentaoId: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface TestCase {
  id: string;
  productId: string;
  name: string;
  steps: string;
  expectedResult: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface TestOrder {
  id: string;
  productId: string;
  name: string;
  description: string;
  targetUrl: string;
  username: string;
  password: string;
  caseIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface CaseRun {
  id: string;
  testCaseId: string;
  caseNameSnapshot: string;
  stepsSnapshot: string;
  expectedResultSnapshot: string;
  status: ExecutionStatus;
  outcome?: TestOutcome;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TestRun {
  id: string;
  testOrderId: string;
  triggerType: "all" | "single";
  status: ExecutionStatus;
  outcome?: TestOutcome;
  caseRuns: CaseRun[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

interface CatalogData {
  version: 1;
  products: Product[];
  testCases: TestCase[];
  testOrders: TestOrder[];
  testRuns: TestRun[];
}

export interface ProductSummary extends Product {
  caseCount: number;
  orderCount: number;
}

export interface TestOrderSummary extends Omit<TestOrder, "password"> {
  productName: string;
  caseCount: number;
  hasPassword: boolean;
  latestRun?: TestRun;
}

export interface TestOrderDetail extends TestOrderSummary {
  cases: TestCase[];
  runs: TestRun[];
}

export class CatalogError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

function requiredText(value: unknown, label: string, maxLength = 10_000): string {
  if (typeof value !== "string" || !value.trim()) throw new CatalogError(`${label}不能为空`);
  const text = value.trim();
  if (text.length > maxLength) throw new CatalogError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function optionalText(value: unknown, maxLength = 10_000): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length > maxLength) throw new CatalogError(`字段不能超过 ${maxLength} 个字符`);
  return text;
}

function normalizeTargetUrl(value: unknown): string {
  const raw = requiredText(value, "目标地址", 2_048);
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CatalogError("目标地址必须使用 http 或 https");
  }
  return url.toString().replace(/\/$/, "");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultData(): CatalogData {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    products: ["WKCJ-I", "WKCJ-II"].map((name) => ({
      id: randomUUID(),
      name,
      description: "",
      zentaoId: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    testCases: [],
    testOrders: [],
    testRuns: [],
  };
}

export class CatalogStore {
  private initializePromise?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async write(data: CatalogData): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private async initialize(): Promise<void> {
    try {
      await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.write(defaultData());
    }
  }

  private async read(): Promise<CatalogData> {
    this.initializePromise ??= this.initialize();
    await this.initializePromise;
    const data = JSON.parse(await readFile(this.filePath, "utf8")) as CatalogData;
    if (data.version !== 1 || !Array.isArray(data.products) || !Array.isArray(data.testCases)) {
      throw new CatalogError("业务数据文件格式不正确", 500);
    }
    data.testOrders ??= [];
    data.testRuns ??= [];
    return data;
  }

  private mutate<T>(operation: (data: CatalogData) => T | Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(async () => {
      const data = await this.read();
      const value = await operation(data);
      await this.write(data);
      return value;
    });
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async listProducts(): Promise<ProductSummary[]> {
    const data = await this.read();
    return data.products
      .filter((product) => !product.archivedAt)
      .map((product) => ({
        ...clone(product),
        caseCount: data.testCases.filter((testCase) => testCase.productId === product.id && !testCase.archivedAt).length,
        orderCount: data.testOrders.filter((order) => order.productId === product.id && !order.archivedAt).length,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async getProduct(id: string): Promise<Product> {
    const data = await this.read();
    const product = data.products.find((item) => item.id === id && !item.archivedAt);
    if (!product) throw new CatalogError("产品不存在", 404);
    return clone(product);
  }

  async createProduct(input: Record<string, unknown>): Promise<Product> {
    return this.mutate((data) => {
      const name = requiredText(input.name, "产品名称", 120);
      if (data.products.some((item) => !item.archivedAt && item.name.toLowerCase() === name.toLowerCase())) {
        throw new CatalogError("产品名称已存在", 409);
      }
      const timestamp = new Date().toISOString();
      const product: Product = {
        id: randomUUID(),
        name,
        description: optionalText(input.description, 4_000),
        zentaoId: optionalText(input.zentaoId, 120),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.products.push(product);
      return clone(product);
    });
  }

  async updateProduct(id: string, input: Record<string, unknown>): Promise<Product> {
    return this.mutate((data) => {
      const product = data.products.find((item) => item.id === id && !item.archivedAt);
      if (!product) throw new CatalogError("产品不存在", 404);
      const name = requiredText(input.name, "产品名称", 120);
      if (data.products.some((item) => item.id !== id && !item.archivedAt && item.name.toLowerCase() === name.toLowerCase())) {
        throw new CatalogError("产品名称已存在", 409);
      }
      product.name = name;
      product.description = optionalText(input.description, 4_000);
      product.zentaoId = optionalText(input.zentaoId, 120);
      product.updatedAt = new Date().toISOString();
      return clone(product);
    });
  }

  async archiveProduct(id: string): Promise<void> {
    await this.mutate((data) => {
      const product = data.products.find((item) => item.id === id && !item.archivedAt);
      if (!product) throw new CatalogError("产品不存在", 404);
      const timestamp = new Date().toISOString();
      product.archivedAt = timestamp;
      product.updatedAt = timestamp;
      data.testCases.filter((item) => item.productId === id && !item.archivedAt).forEach((item) => (item.archivedAt = timestamp));
      data.testOrders.filter((item) => item.productId === id && !item.archivedAt).forEach((item) => (item.archivedAt = timestamp));
    });
  }

  async listTestCases(productId: string): Promise<TestCase[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.testCases
      .filter((item) => item.productId === productId && !item.archivedAt)
      .map(clone)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getTestCase(id: string): Promise<TestCase> {
    const data = await this.read();
    const testCase = data.testCases.find((item) => item.id === id && !item.archivedAt);
    if (!testCase) throw new CatalogError("测试用例不存在", 404);
    return clone(testCase);
  }

  async createTestCase(productId: string, input: Record<string, unknown>): Promise<TestCase> {
    return this.mutate((data) => {
      const product = data.products.find((item) => item.id === productId && !item.archivedAt);
      if (!product) throw new CatalogError("产品不存在", 404);
      const timestamp = new Date().toISOString();
      const testCase: TestCase = {
        id: randomUUID(),
        productId,
        name: requiredText(input.name, "用例名称", 200),
        steps: requiredText(input.steps, "测试步骤", 20_000),
        expectedResult: requiredText(input.expectedResult, "预期结果", 10_000),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.testCases.push(testCase);
      return clone(testCase);
    });
  }

  async updateTestCase(id: string, input: Record<string, unknown>): Promise<TestCase> {
    return this.mutate((data) => {
      const testCase = data.testCases.find((item) => item.id === id && !item.archivedAt);
      if (!testCase) throw new CatalogError("测试用例不存在", 404);
      testCase.name = requiredText(input.name, "用例名称", 200);
      testCase.steps = requiredText(input.steps, "测试步骤", 20_000);
      testCase.expectedResult = requiredText(input.expectedResult, "预期结果", 10_000);
      testCase.updatedAt = new Date().toISOString();
      return clone(testCase);
    });
  }

  async archiveTestCase(id: string): Promise<void> {
    await this.mutate((data) => {
      const testCase = data.testCases.find((item) => item.id === id && !item.archivedAt);
      if (!testCase) throw new CatalogError("测试用例不存在", 404);
      const timestamp = new Date().toISOString();
      testCase.archivedAt = timestamp;
      testCase.updatedAt = timestamp;
      data.testOrders.forEach((order) => {
        if (!order.archivedAt && order.caseIds.includes(id)) {
          order.caseIds = order.caseIds.filter((caseId) => caseId !== id);
          order.updatedAt = timestamp;
        }
      });
    });
  }

  private validateOrderCases(data: CatalogData, productId: string, value: unknown): string[] {
    if (!Array.isArray(value)) throw new CatalogError("请选择测试用例");
    const caseIds = [...new Set(value.filter((item): item is string => typeof item === "string"))];
    if (!caseIds.length) throw new CatalogError("测试单至少需要一个测试用例");
    const validIds = new Set(
      data.testCases.filter((item) => item.productId === productId && !item.archivedAt).map((item) => item.id),
    );
    if (caseIds.some((id) => !validIds.has(id))) throw new CatalogError("测试单包含不属于该产品的用例");
    return caseIds;
  }

  async createTestOrder(input: Record<string, unknown>): Promise<TestOrder> {
    return this.mutate((data) => {
      const productId = requiredText(input.productId, "产品");
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) {
        throw new CatalogError("产品不存在", 404);
      }
      const timestamp = new Date().toISOString();
      const order: TestOrder = {
        id: randomUUID(),
        productId,
        name: requiredText(input.name, "测试单名称", 200),
        description: optionalText(input.description, 4_000),
        targetUrl: normalizeTargetUrl(input.targetUrl),
        username: optionalText(input.username, 300),
        password: optionalText(input.password, 1_000),
        caseIds: this.validateOrderCases(data, productId, input.caseIds),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.testOrders.push(order);
      return clone(order);
    });
  }

  async updateTestOrder(id: string, input: Record<string, unknown>): Promise<TestOrder> {
    return this.mutate((data) => {
      const order = data.testOrders.find((item) => item.id === id && !item.archivedAt);
      if (!order) throw new CatalogError("测试单不存在", 404);
      const productId = requiredText(input.productId, "产品");
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) {
        throw new CatalogError("产品不存在", 404);
      }
      order.productId = productId;
      order.name = requiredText(input.name, "测试单名称", 200);
      order.description = optionalText(input.description, 4_000);
      order.targetUrl = normalizeTargetUrl(input.targetUrl);
      order.username = optionalText(input.username, 300);
      if (typeof input.password === "string" && input.password.trim()) order.password = input.password.trim();
      order.caseIds = this.validateOrderCases(data, productId, input.caseIds);
      order.updatedAt = new Date().toISOString();
      return clone(order);
    });
  }

  async archiveTestOrder(id: string): Promise<void> {
    await this.mutate((data) => {
      const order = data.testOrders.find((item) => item.id === id && !item.archivedAt);
      if (!order) throw new CatalogError("测试单不存在", 404);
      order.archivedAt = new Date().toISOString();
      order.updatedAt = order.archivedAt;
    });
  }

  private publicOrder(data: CatalogData, order: TestOrder): TestOrderSummary {
    const { password: _password, ...safeOrder } = clone(order);
    const product = data.products.find((item) => item.id === order.productId);
    const latestRun = data.testRuns
      .filter((run) => run.testOrderId === order.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return {
      ...safeOrder,
      productName: product?.name || "已删除产品",
      caseCount: order.caseIds.length,
      hasPassword: Boolean(order.password),
      latestRun: latestRun ? clone(latestRun) : undefined,
    };
  }

  async listTestOrders(): Promise<TestOrderSummary[]> {
    const data = await this.read();
    return data.testOrders
      .filter((order) => !order.archivedAt)
      .map((order) => this.publicOrder(data, order))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getTestOrder(id: string): Promise<TestOrder> {
    const data = await this.read();
    const order = data.testOrders.find((item) => item.id === id && !item.archivedAt);
    if (!order) throw new CatalogError("测试单不存在", 404);
    return clone(order);
  }

  async getTestOrderDetail(id: string): Promise<TestOrderDetail> {
    const data = await this.read();
    const order = data.testOrders.find((item) => item.id === id && !item.archivedAt);
    if (!order) throw new CatalogError("测试单不存在", 404);
    const cases = order.caseIds
      .map((caseId) => data.testCases.find((item) => item.id === caseId))
      .filter((item): item is TestCase => Boolean(item))
      .map(clone);
    const runs = data.testRuns
      .filter((run) => run.testOrderId === id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 30)
      .map(clone);
    return { ...this.publicOrder(data, order), cases, runs };
  }

  async createTestRun(runId: string, testOrderId: string, selectedCaseIds?: string[]): Promise<TestRun> {
    return this.mutate((data) => {
      const order = data.testOrders.find((item) => item.id === testOrderId && !item.archivedAt);
      if (!order) throw new CatalogError("测试单不存在", 404);
      const caseIds = selectedCaseIds?.length ? selectedCaseIds : order.caseIds;
      if (caseIds.some((caseId) => !order.caseIds.includes(caseId))) {
        throw new CatalogError("所选用例不属于该测试单");
      }
      const cases = caseIds.map((caseId) => data.testCases.find((item) => item.id === caseId && !item.archivedAt));
      if (cases.some((item) => !item)) throw new CatalogError("测试单中存在已删除的测试用例");
      const run: TestRun = {
        id: runId,
        testOrderId,
        triggerType: selectedCaseIds?.length ? "single" : "all",
        status: "queued",
        caseRuns: (cases as TestCase[]).map((testCase) => ({
          id: randomUUID(),
          testCaseId: testCase.id,
          caseNameSnapshot: testCase.name,
          stepsSnapshot: testCase.steps,
          expectedResultSnapshot: testCase.expectedResult,
          status: "queued",
        })),
        createdAt: new Date().toISOString(),
      };
      data.testRuns.push(run);
      return clone(run);
    });
  }

  async updateTestRun(id: string, update: (run: TestRun) => void): Promise<TestRun> {
    return this.mutate((data) => {
      const run = data.testRuns.find((item) => item.id === id);
      if (!run) throw new CatalogError("执行记录不存在", 404);
      update(run);
      return clone(run);
    });
  }
}

export const catalogStore = new CatalogStore(path.resolve(process.cwd(), ".data", "catalog.json"));
