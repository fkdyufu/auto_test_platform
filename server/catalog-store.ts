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
  scenarioId: string;
  source: "local" | "zentao";
  zentaoCaseId?: number;
  lastImportedAt?: string;
  name: string;
  steps: string;
  expectedResult: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type ControlInterfaceType = "web" | "ssh" | "telnet" | "serial" | "api" | "other";

export interface ControlInterface {
  id: string;
  name: string;
  type: ControlInterfaceType;
  address: string;
  username: string;
  password: string;
}

export interface DeviceResource {
  id: string;
  productId: string;
  name: string;
  types: string[];
  model: string;
  description: string;
  controlInterfaces: ControlInterface[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface PhysicalConnection {
  id: string;
  sourceDeviceId: string;
  sourcePort: string;
  targetDeviceId: string;
  targetPort: string;
  description: string;
}

export interface PhysicalEnvironment {
  id: string;
  productId: string;
  name: string;
  description: string;
  deviceIds: string[];
  connections: PhysicalConnection[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ScenarioRole {
  id: string;
  key: string;
  name: string;
  deviceType: string;
}

export interface ScenarioParameter {
  id: string;
  key: string;
  name: string;
  defaultValue: string;
}

export interface TestScenario {
  id: string;
  productId: string;
  isDefault: boolean;
  name: string;
  category: string;
  description: string;
  roles: ScenarioRole[];
  parameters: ScenarioParameter[];
  setupInstructions: string;
  verificationInstructions: string;
  cleanupInstructions: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface TestOrder {
  id: string;
  productId: string;
  name: string;
  description: string;
  physicalEnvironmentId: string;
  caseIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

type LegacyTestOrder = Omit<TestOrder, "physicalEnvironmentId"> & {
  physicalEnvironmentId?: string;
  environmentId?: string;
  targetUrl?: string;
  username?: string;
  password?: string;
  scenarioId?: string;
  roleBindings?: Record<string, string>;
};

export interface CaseRun {
  id: string;
  testCaseId: string;
  scenarioRunId: string;
  caseNameSnapshot: string;
  stepsSnapshot: string;
  expectedResultSnapshot: string;
  status: ExecutionStatus;
  outcome?: TestOutcome;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ScenarioRun {
  id: string;
  testScenarioId: string;
  scenarioNameSnapshot: string;
  isDefault: boolean;
  status: ExecutionStatus;
  outcome?: TestOutcome;
  roleBindings: Record<string, string>;
  parameterValues: Record<string, string>;
  caseRunIds: string[];
  summary?: string;
  cleanupOutcome?: TestOutcome;
  cleanupSummary?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TestRun {
  id: string;
  testOrderId: string;
  triggerType: "all" | "single";
  status: ExecutionStatus;
  outcome?: TestOutcome;
  scenarioRuns: ScenarioRun[];
  caseRuns: CaseRun[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

interface CatalogData {
  version: 9;
  products: Product[];
  testCases: TestCase[];
  deviceResources: DeviceResource[];
  physicalEnvironments: PhysicalEnvironment[];
  testScenarios: TestScenario[];
  testOrders: TestOrder[];
  testRuns: TestRun[];
}

type LegacyTestCase = Omit<TestCase, "scenarioId" | "source"> & {
  scenarioId?: string;
  source?: TestCase["source"];
};
type LegacyCaseRun = Omit<CaseRun, "scenarioRunId"> & { scenarioRunId?: string };
type LegacyTestRun = Omit<TestRun, "scenarioRuns" | "caseRuns"> & {
  scenarioRuns?: ScenarioRun[];
  caseRuns: LegacyCaseRun[];
};
type LegacyDeviceResource = Omit<DeviceResource, "types"> & {
  type?: string;
  types?: string[];
};

export interface ProductSummary extends Product {
  caseCount: number;
  orderCount: number;
}

export interface PublicControlInterface extends Omit<ControlInterface, "password"> {
  hasPassword: boolean;
}

export interface DeviceResourceSummary extends Omit<DeviceResource, "controlInterfaces"> {
  controlInterfaces: PublicControlInterface[];
}

export interface TestOrderSummary extends TestOrder {
  productName: string;
  physicalEnvironmentName: string;
  caseCount: number;
  latestRun?: TestRun;
}

export interface TestOrderDetail extends TestOrderSummary {
  cases: TestCase[];
  runs: TestRun[];
  physicalEnvironment?: PhysicalEnvironment;
}

export interface TestOrderExecutionContext {
  physicalEnvironment?: PhysicalEnvironment;
  devices: DeviceResource[];
  scenarios: TestScenario[];
}

export interface DiagnosticExecutionContext extends TestOrderExecutionContext {
  product: Product;
  testOrder: TestOrder;
  testRun: TestRun;
  caseRun: CaseRun;
  scenarioRun: ScenarioRun;
  scenario?: TestScenario;
}

export interface ImportedTestCaseInput {
  zentaoCaseId: number;
  name: string;
  steps: string;
  expectedResult: string;
}

export interface TestCaseImportResult {
  created: number;
  updated: number;
  skipped: number;
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

function normalizeDeviceTypes(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const types = values
    .flatMap((item) => typeof item === "string" ? item.split(/[/,，]/) : [])
    .map((item) => item.trim())
    .filter(Boolean);
  if (!types.length) throw new CatalogError("设备类型不能为空");
  if (types.length > 20) throw new CatalogError("设备类型不能超过 20 个");
  types.forEach((item) => {
    if (item.length > 120) throw new CatalogError("单个设备类型不能超过 120 个字符");
  });
  const seen = new Set<string>();
  return types.filter((item) => {
    const normalized = item.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function uniqueName(data: { name: string; archivedAt?: string }[], name: string, label: string, currentId?: string): void {
  if (data.some((item) => !item.archivedAt && (item as { id?: string }).id !== currentId && item.name.toLowerCase() === name.toLowerCase())) {
    throw new CatalogError(`${label}已存在`, 409);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultScenarioId(productId: string): string {
  return `default-scenario-${productId}`;
}

function createDefaultScenario(product: Product, timestamp = new Date().toISOString()): TestScenario {
  return {
    id: defaultScenarioId(product.id),
    productId: product.id,
    isDefault: true,
    name: "默认场景",
    category: "默认",
    description: "不切换逻辑拓扑，直接使用所选物理环境执行用例。",
    roles: [],
    parameters: [],
    setupInstructions: "保持物理环境当前逻辑配置，不执行额外的场景搭建。",
    verificationInstructions: "确认用例所需设备及其控制接口可用。",
    cleanupInstructions: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function defaultData(): CatalogData {
  const timestamp = new Date().toISOString();
  const products = ["WKCJ-I", "WKCJ-II"].map((name) => ({
    id: randomUUID(),
    name,
    description: "",
    zentaoId: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  return {
    version: 9,
    products,
    testCases: [],
    deviceResources: [],
    physicalEnvironments: [],
    testScenarios: products.map((product) => createDefaultScenario(product, timestamp)),
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
    const data = JSON.parse(await readFile(this.filePath, "utf8")) as CatalogData & { version: number };
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(data.version) || !Array.isArray(data.products) || !Array.isArray(data.testCases)) {
      throw new CatalogError("业务数据文件格式不正确", 500);
    }
    const legacyData = data as typeof data & { labEnvironments?: PhysicalEnvironment[] };
    data.version = 9;
    data.deviceResources ??= [];
    data.physicalEnvironments ??= legacyData.labEnvironments ?? [];
    delete legacyData.labEnvironments;
    data.testScenarios ??= [];
    data.testOrders ??= [];
    data.testRuns ??= [];
    const legacyOrders = data.testOrders as LegacyTestOrder[];
    legacyOrders.forEach((order) => {
      order.physicalEnvironmentId ??= order.environmentId || "";
    });

    const productIds = new Set(data.products.map((product) => product.id));
    const fallbackProductId = data.products
      .filter((product) => !product.archivedAt)
      .sort((left, right) => {
        const score = (productId: string) =>
          data.testCases.filter((item) => item.productId === productId && !item.archivedAt).length
          + data.testOrders.filter((item) => item.productId === productId && !item.archivedAt).length;
        return score(right.id) - score(left.id);
      })[0]?.id || data.products[0]?.id || "";
    const physicalEnvironmentOwners = new Map<string, string>();
    const scenarioOwners = new Map<string, string>();
    legacyOrders.forEach((order) => {
      if (order.physicalEnvironmentId && !physicalEnvironmentOwners.has(order.physicalEnvironmentId)) {
        physicalEnvironmentOwners.set(order.physicalEnvironmentId, order.productId);
      }
      if (order.scenarioId && !scenarioOwners.has(order.scenarioId)) scenarioOwners.set(order.scenarioId, order.productId);
    });
    data.physicalEnvironments = data.physicalEnvironments.map((physicalEnvironment) => ({
      ...physicalEnvironment,
      productId: productIds.has(physicalEnvironment.productId)
        ? physicalEnvironment.productId
        : physicalEnvironmentOwners.get(physicalEnvironment.id) || fallbackProductId,
    }));
    data.testScenarios = data.testScenarios.map((scenario) => ({
      ...scenario,
      isDefault: scenario.isDefault === true,
      productId: productIds.has(scenario.productId)
        ? scenario.productId
        : scenarioOwners.get(scenario.id) || fallbackProductId,
      roles: (scenario.roles || []).map((role) => ({
        id: role.id,
        key: role.key,
        name: role.name,
        deviceType: role.deviceType,
      })),
    }));
    data.products.forEach((product) => {
      if (!data.testScenarios.some((scenario) => scenario.productId === product.id && scenario.isDefault)) {
        data.testScenarios.push(createDefaultScenario(product, product.createdAt));
      }
    });
    const scenarioById = new Map(data.testScenarios.map((scenario) => [scenario.id, scenario]));
    data.testCases = (data.testCases as LegacyTestCase[]).map((testCase) => {
      const scenario = testCase.scenarioId ? scenarioById.get(testCase.scenarioId) : undefined;
      return {
        id: testCase.id,
        productId: testCase.productId,
        scenarioId: scenario?.productId === testCase.productId ? scenario.id : defaultScenarioId(testCase.productId),
        source: testCase.source === "zentao" && Number.isInteger(testCase.zentaoCaseId) ? "zentao" : "local",
        zentaoCaseId: Number.isInteger(testCase.zentaoCaseId) ? testCase.zentaoCaseId : undefined,
        lastImportedAt: typeof testCase.lastImportedAt === "string" ? testCase.lastImportedAt : undefined,
        name: testCase.name,
        steps: testCase.steps,
        expectedResult: testCase.expectedResult,
        createdAt: testCase.createdAt,
        updatedAt: testCase.updatedAt,
        archivedAt: testCase.archivedAt,
      };
    });
    const deviceOwners = new Map<string, string>();
    data.physicalEnvironments.forEach((physicalEnvironment) => {
      physicalEnvironment.deviceIds.forEach((deviceId) => {
        if (!deviceOwners.has(deviceId)) deviceOwners.set(deviceId, physicalEnvironment.productId);
      });
    });
    data.deviceResources = (data.deviceResources as LegacyDeviceResource[]).map((device) => ({
      id: device.id,
      productId: productIds.has(device.productId) ? device.productId : deviceOwners.get(device.id) || fallbackProductId,
      name: device.name,
      types: normalizeDeviceTypes(device.types?.length ? device.types : device.type),
      model: device.model || "",
      description: device.description || "",
      controlInterfaces: (device.controlInterfaces || []).map((control) => ({
        id: control.id,
        name: control.name,
        type: control.type === ("relay" as ControlInterfaceType) ? "other" : control.type,
        address: control.address,
        username: control.username || "",
        password: control.password || "",
      })),
      createdAt: device.createdAt,
      updatedAt: device.updatedAt,
      archivedAt: device.archivedAt,
    }));

    const deviceProductById = new Map(data.deviceResources.map((device) => [device.id, device.productId]));
    data.physicalEnvironments.forEach((physicalEnvironment) => {
      const allowedIds = new Set(
        physicalEnvironment.deviceIds.filter((deviceId) => deviceProductById.get(deviceId) === physicalEnvironment.productId),
      );
      physicalEnvironment.deviceIds = [...allowedIds];
      physicalEnvironment.connections = physicalEnvironment.connections.filter(
        (connection) => allowedIds.has(connection.sourceDeviceId) && allowedIds.has(connection.targetDeviceId),
      );
    });
    data.testOrders = legacyOrders.map((order) => {
      const physicalEnvironment = data.physicalEnvironments.find((item) => item.id === order.physicalEnvironmentId);
      return {
        id: order.id,
        productId: order.productId,
        name: order.name,
        description: order.description || "",
        physicalEnvironmentId:
          physicalEnvironment && physicalEnvironment.productId !== order.productId ? "" : order.physicalEnvironmentId || "",
        caseIds: order.caseIds,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        archivedAt: order.archivedAt,
      };
    });
    const testCaseById = new Map(data.testCases.map((testCase) => [testCase.id, testCase]));
    data.testRuns = (data.testRuns as LegacyTestRun[]).map((run) => {
      if (run.scenarioRuns && run.caseRuns.every((caseRun) => Boolean(caseRun.scenarioRunId))) {
        return run as TestRun;
      }
      const runOrder = data.testOrders.find((order) => order.id === run.testOrderId);
      const scenarioRuns = new Map<string, ScenarioRun>();
      const caseRuns = run.caseRuns.map((caseRun) => {
        const testCase = testCaseById.get(caseRun.testCaseId);
        const scenario = scenarioById.get(testCase?.scenarioId || "");
        const scenarioId = scenario?.id || defaultScenarioId(testCase?.productId || runOrder?.productId || "legacy");
        let scenarioRun = scenarioRuns.get(scenarioId);
        if (!scenarioRun) {
          scenarioRun = {
            id: `scenario-run-${run.id}-${scenarioId}`,
            testScenarioId: scenarioId,
            scenarioNameSnapshot: scenario?.name || "默认场景",
            isDefault: scenario?.isDefault ?? true,
            status: run.status,
            outcome: run.outcome,
            roleBindings: {},
            parameterValues: {},
            caseRunIds: [],
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
          };
          scenarioRuns.set(scenarioId, scenarioRun);
        }
        scenarioRun.caseRunIds.push(caseRun.id);
        return { ...caseRun, scenarioRunId: scenarioRun.id };
      });
      return { ...run, scenarioRuns: [...scenarioRuns.values()], caseRuns };
    });
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
      data.testScenarios.push(createDefaultScenario(product, timestamp));
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
      data.deviceResources.filter((item) => item.productId === id && !item.archivedAt).forEach((item) => (item.archivedAt = timestamp));
      data.physicalEnvironments.filter((item) => item.productId === id && !item.archivedAt).forEach((item) => (item.archivedAt = timestamp));
      data.testScenarios.filter((item) => item.productId === id && !item.archivedAt).forEach((item) => (item.archivedAt = timestamp));
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

  async getTestCase(productId: string, id: string): Promise<TestCase> {
    const data = await this.read();
    const testCase = data.testCases.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
    if (!testCase) throw new CatalogError("测试用例不存在", 404);
    return clone(testCase);
  }

  private validateTestCaseScenario(data: CatalogData, productId: string, value: unknown): string {
    const scenarioId = optionalText(value, 100) || defaultScenarioId(productId);
    const scenario = data.testScenarios.find(
      (item) => item.id === scenarioId && item.productId === productId && !item.archivedAt,
    );
    if (!scenario) throw new CatalogError("测试场景不属于当前产品或不存在", 404);
    return scenarioId;
  }

  async createTestCase(productId: string, input: Record<string, unknown>): Promise<TestCase> {
    return this.mutate((data) => {
      const product = data.products.find((item) => item.id === productId && !item.archivedAt);
      if (!product) throw new CatalogError("产品不存在", 404);
      const timestamp = new Date().toISOString();
      const testCase: TestCase = {
        id: randomUUID(),
        productId,
        scenarioId: this.validateTestCaseScenario(data, productId, input.scenarioId),
        source: "local",
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

  async updateTestCase(productId: string, id: string, input: Record<string, unknown>): Promise<TestCase> {
    return this.mutate((data) => {
      const testCase = data.testCases.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!testCase) throw new CatalogError("测试用例不存在", 404);
      testCase.scenarioId = this.validateTestCaseScenario(data, productId, input.scenarioId ?? testCase.scenarioId);
      testCase.name = requiredText(input.name, "用例名称", 200);
      testCase.steps = requiredText(input.steps, "测试步骤", 20_000);
      testCase.expectedResult = requiredText(input.expectedResult, "预期结果", 10_000);
      testCase.updatedAt = new Date().toISOString();
      return clone(testCase);
    });
  }

  async importZentaoTestCases(
    productId: string,
    importedCases: ImportedTestCaseInput[],
    overwriteExisting = false,
  ): Promise<TestCaseImportResult> {
    if (!Array.isArray(importedCases) || !importedCases.length) throw new CatalogError("请选择要导入的禅道用例");
    if (importedCases.length > 500) throw new CatalogError("单次最多导入 500 个禅道用例");
    return this.mutate((data) => {
      const product = data.products.find((item) => item.id === productId && !item.archivedAt);
      if (!product) throw new CatalogError("产品不存在", 404);
      const timestamp = new Date().toISOString();
      const uniqueCases = new Map<number, ImportedTestCaseInput>();
      importedCases.forEach((item) => {
        if (!Number.isInteger(item.zentaoCaseId) || item.zentaoCaseId <= 0) {
          throw new CatalogError("禅道用例 ID 不正确");
        }
        uniqueCases.set(item.zentaoCaseId, item);
      });

      const result: TestCaseImportResult = { created: 0, updated: 0, skipped: 0 };
      for (const item of uniqueCases.values()) {
        const existing = data.testCases.find(
          (testCase) => testCase.productId === productId
            && testCase.zentaoCaseId === item.zentaoCaseId
            && !testCase.archivedAt,
        );
        if (existing && !overwriteExisting) {
          result.skipped += 1;
          continue;
        }

        const name = requiredText(item.name, "用例名称", 200);
        const steps = requiredText(item.steps, "测试步骤", 20_000);
        const expectedResult = requiredText(item.expectedResult, "预期结果", 10_000);
        if (existing) {
          existing.source = "zentao";
          existing.name = name;
          existing.steps = steps;
          existing.expectedResult = expectedResult;
          existing.lastImportedAt = timestamp;
          existing.updatedAt = timestamp;
          result.updated += 1;
          continue;
        }

        data.testCases.push({
          id: randomUUID(),
          productId,
          scenarioId: defaultScenarioId(productId),
          source: "zentao",
          zentaoCaseId: item.zentaoCaseId,
          lastImportedAt: timestamp,
          name,
          steps,
          expectedResult,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        result.created += 1;
      }
      return result;
    });
  }

  async archiveTestCase(productId: string, id: string): Promise<void> {
    await this.mutate((data) => {
      const testCase = data.testCases.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
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

  private normalizeControlInterfaces(value: unknown, existing: ControlInterface[] = []): ControlInterface[] {
    if (!Array.isArray(value)) throw new CatalogError("控制接口格式不正确");
    if (value.length > 30) throw new CatalogError("控制接口不能超过 30 个");
    const allowedTypes = new Set<ControlInterfaceType>(["web", "ssh", "telnet", "serial", "api", "other"]);
    return value.map((item) => {
      const input = recordValue(item);
      const id = optionalText(input.id, 100) || randomUUID();
      const type = optionalText(input.type, 30) as ControlInterfaceType;
      if (!allowedTypes.has(type)) throw new CatalogError("控制接口类型不正确");
      const previous = existing.find((control) => control.id === id);
      const nextPassword = optionalText(input.password, 1_000);
      return {
        id,
        name: requiredText(input.name, "接口名称", 120),
        type,
        address: requiredText(input.address, "接口地址", 2_048),
        username: optionalText(input.username, 300),
        password: nextPassword || previous?.password || "",
      };
    });
  }

  private publicDevice(device: DeviceResource): DeviceResourceSummary {
    return {
      ...clone(device),
      controlInterfaces: device.controlInterfaces.map(({ password, ...control }) => ({
        ...control,
        hasPassword: Boolean(password),
      })),
    };
  }

  async listDeviceResources(productId: string): Promise<DeviceResourceSummary[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.deviceResources
      .filter((item) => item.productId === productId && !item.archivedAt)
      .map((item) => this.publicDevice(item))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async createDeviceResource(productId: string, input: Record<string, unknown>): Promise<DeviceResourceSummary> {
    return this.mutate((data) => {
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) throw new CatalogError("产品不存在", 404);
      const name = requiredText(input.name, "设备名称", 160);
      uniqueName(data.deviceResources.filter((item) => item.productId === productId), name, "设备名称");
      const timestamp = new Date().toISOString();
      const device: DeviceResource = {
        id: randomUUID(),
        productId,
        name,
        types: normalizeDeviceTypes(input.types ?? input.type),
        model: optionalText(input.model, 160),
        description: optionalText(input.description, 4_000),
        controlInterfaces: this.normalizeControlInterfaces(input.controlInterfaces ?? []),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.deviceResources.push(device);
      return this.publicDevice(device);
    });
  }

  async updateDeviceResource(productId: string, id: string, input: Record<string, unknown>): Promise<DeviceResourceSummary> {
    return this.mutate((data) => {
      const device = data.deviceResources.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!device) throw new CatalogError("设备资源不存在", 404);
      const name = requiredText(input.name, "设备名称", 160);
      uniqueName(data.deviceResources.filter((item) => item.productId === productId), name, "设备名称", id);
      device.name = name;
      device.types = normalizeDeviceTypes(input.types ?? input.type);
      device.model = optionalText(input.model, 160);
      device.description = optionalText(input.description, 4_000);
      device.controlInterfaces = this.normalizeControlInterfaces(input.controlInterfaces ?? [], device.controlInterfaces);
      device.updatedAt = new Date().toISOString();
      return this.publicDevice(device);
    });
  }

  async archiveDeviceResource(productId: string, id: string): Promise<void> {
    await this.mutate((data) => {
      const device = data.deviceResources.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!device) throw new CatalogError("设备资源不存在", 404);
      if (data.physicalEnvironments.some((item) => !item.archivedAt && item.deviceIds.includes(id))) {
        throw new CatalogError("设备正在被物理环境使用，不能删除", 409);
      }
      device.archivedAt = new Date().toISOString();
      device.updatedAt = device.archivedAt;
    });
  }

  private normalizePhysicalEnvironmentDevices(data: CatalogData, productId: string, value: unknown): string[] {
    if (!Array.isArray(value)) throw new CatalogError("请选择物理环境设备");
    const deviceIds = [...new Set(value.filter((item): item is string => typeof item === "string"))];
    if (!deviceIds.length) throw new CatalogError("物理环境至少需要一台设备");
    const activeIds = new Set(
      data.deviceResources.filter((item) => item.productId === productId && !item.archivedAt).map((item) => item.id),
    );
    if (deviceIds.some((id) => !activeIds.has(id))) throw new CatalogError("物理环境包含其他产品或不存在的设备");
    return deviceIds;
  }

  private normalizeConnections(value: unknown, deviceIds: string[]): PhysicalConnection[] {
    if (!Array.isArray(value)) throw new CatalogError("连接关系格式不正确");
    if (value.length > 500) throw new CatalogError("连接关系不能超过 500 条");
    const allowedDevices = new Set(deviceIds);
    return value.map((item) => {
      const input = recordValue(item);
      const sourceDeviceId = requiredText(input.sourceDeviceId, "本端设备");
      const targetDeviceId = requiredText(input.targetDeviceId, "对端设备");
      if (!allowedDevices.has(sourceDeviceId) || !allowedDevices.has(targetDeviceId)) {
        throw new CatalogError("连接关系中的设备不属于当前物理环境");
      }
      const sourcePort = requiredText(input.sourcePort, "本端端口", 160);
      const targetPort = requiredText(input.targetPort, "对端端口", 160);
      if (sourceDeviceId === targetDeviceId && sourcePort === targetPort) {
        throw new CatalogError("连接关系不能连接到同一个设备端口");
      }
      return {
        id: optionalText(input.id, 100) || randomUUID(),
        sourceDeviceId,
        sourcePort,
        targetDeviceId,
        targetPort,
        description: optionalText(input.description, 500),
      };
    });
  }

  async listPhysicalEnvironments(productId: string): Promise<PhysicalEnvironment[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.physicalEnvironments
      .filter((item) => item.productId === productId && !item.archivedAt)
      .map(clone)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async createPhysicalEnvironment(productId: string, input: Record<string, unknown>): Promise<PhysicalEnvironment> {
    return this.mutate((data) => {
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) throw new CatalogError("产品不存在", 404);
      const name = requiredText(input.name, "物理环境名称", 160);
      uniqueName(data.physicalEnvironments.filter((item) => item.productId === productId), name, "物理环境名称");
      const deviceIds = this.normalizePhysicalEnvironmentDevices(data, productId, input.deviceIds);
      const timestamp = new Date().toISOString();
      const physicalEnvironment: PhysicalEnvironment = {
        id: randomUUID(),
        productId,
        name,
        description: optionalText(input.description, 4_000),
        deviceIds,
        connections: this.normalizeConnections(input.connections ?? [], deviceIds),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.physicalEnvironments.push(physicalEnvironment);
      return clone(physicalEnvironment);
    });
  }

  async updatePhysicalEnvironment(productId: string, id: string, input: Record<string, unknown>): Promise<PhysicalEnvironment> {
    return this.mutate((data) => {
      const physicalEnvironment = data.physicalEnvironments.find(
        (item) => item.id === id && item.productId === productId && !item.archivedAt,
      );
      if (!physicalEnvironment) throw new CatalogError("物理环境不存在", 404);
      const name = requiredText(input.name, "物理环境名称", 160);
      uniqueName(data.physicalEnvironments.filter((item) => item.productId === productId), name, "物理环境名称", id);
      const deviceIds = this.normalizePhysicalEnvironmentDevices(data, productId, input.deviceIds);
      physicalEnvironment.name = name;
      physicalEnvironment.description = optionalText(input.description, 4_000);
      physicalEnvironment.deviceIds = deviceIds;
      physicalEnvironment.connections = this.normalizeConnections(input.connections ?? [], deviceIds);
      physicalEnvironment.updatedAt = new Date().toISOString();
      return clone(physicalEnvironment);
    });
  }

  async archivePhysicalEnvironment(productId: string, id: string): Promise<void> {
    await this.mutate((data) => {
      const physicalEnvironment = data.physicalEnvironments.find(
        (item) => item.id === id && item.productId === productId && !item.archivedAt,
      );
      if (!physicalEnvironment) throw new CatalogError("物理环境不存在", 404);
      if (data.testOrders.some((item) => !item.archivedAt && item.physicalEnvironmentId === id)) {
        throw new CatalogError("物理环境正在被测试单使用，不能删除", 409);
      }
      physicalEnvironment.archivedAt = new Date().toISOString();
      physicalEnvironment.updatedAt = physicalEnvironment.archivedAt;
    });
  }

  private normalizeScenarioRoles(value: unknown): ScenarioRole[] {
    if (!Array.isArray(value) || !value.length) throw new CatalogError("测试场景至少需要一个设备角色");
    if (value.length > 30) throw new CatalogError("设备角色不能超过 30 个");
    const roles = value.map((item) => {
      const input = recordValue(item);
      const key = requiredText(input.key, "角色标识", 80);
      if (!/^[a-z][a-z0-9_-]*$/i.test(key)) throw new CatalogError("角色标识只能包含字母、数字、下划线和连字符");
      return {
        id: optionalText(input.id, 100) || randomUUID(),
        key,
        name: requiredText(input.name, "角色名称", 120),
        deviceType: requiredText(input.deviceType, "设备类型", 120),
      };
    });
    if (new Set(roles.map((item) => item.key.toLowerCase())).size !== roles.length) throw new CatalogError("角色标识不能重复");
    return roles;
  }

  private normalizeScenarioParameters(value: unknown): ScenarioParameter[] {
    if (!Array.isArray(value)) throw new CatalogError("场景参数格式不正确");
    if (value.length > 100) throw new CatalogError("场景参数不能超过 100 个");
    const parameters = value.map((item) => {
      const input = recordValue(item);
      const key = requiredText(input.key, "参数标识", 80);
      if (!/^[a-z][a-z0-9_.-]*$/i.test(key)) throw new CatalogError("参数标识格式不正确");
      return {
        id: optionalText(input.id, 100) || randomUUID(),
        key,
        name: requiredText(input.name, "参数名称", 120),
        defaultValue: optionalText(input.defaultValue, 1_000),
      };
    });
    if (new Set(parameters.map((item) => item.key.toLowerCase())).size !== parameters.length) {
      throw new CatalogError("参数标识不能重复");
    }
    return parameters;
  }

  private validateScenarioCaseIds(data: CatalogData, productId: string, value: unknown): string[] {
    if (!Array.isArray(value)) throw new CatalogError("关联用例格式不正确");
    if (value.length > 10_000) throw new CatalogError("单个场景关联用例不能超过 10000 个");
    if (value.some((item) => typeof item !== "string")) throw new CatalogError("关联用例 ID 格式不正确");
    const caseIds = [...new Set(value as string[])];
    const validIds = new Set(
      data.testCases.filter((item) => item.productId === productId && !item.archivedAt).map((item) => item.id),
    );
    if (caseIds.some((caseId) => !validIds.has(caseId))) {
      throw new CatalogError("关联用例包含其他产品或不存在的用例");
    }
    return caseIds;
  }

  async listTestScenarios(productId: string): Promise<TestScenario[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.testScenarios
      .filter((item) => item.productId === productId && !item.archivedAt)
      .map(clone)
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name, "zh-CN"));
  }

  async createTestScenario(productId: string, input: Record<string, unknown>): Promise<TestScenario> {
    return this.mutate((data) => {
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) throw new CatalogError("产品不存在", 404);
      const name = requiredText(input.name, "场景名称", 160);
      uniqueName(data.testScenarios.filter((item) => item.productId === productId), name, "场景名称");
      const timestamp = new Date().toISOString();
      const scenario: TestScenario = {
        id: randomUUID(),
        productId,
        isDefault: false,
        name,
        category: requiredText(input.category, "功能分类", 120),
        description: optionalText(input.description, 4_000),
        roles: this.normalizeScenarioRoles(input.roles),
        parameters: this.normalizeScenarioParameters(input.parameters ?? []),
        setupInstructions: requiredText(input.setupInstructions, "场景搭建要求", 20_000),
        verificationInstructions: requiredText(input.verificationInstructions, "场景验证要求", 10_000),
        cleanupInstructions: optionalText(input.cleanupInstructions, 10_000),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.testScenarios.push(scenario);
      return clone(scenario);
    });
  }

  async updateTestScenario(productId: string, id: string, input: Record<string, unknown>): Promise<TestScenario> {
    return this.mutate((data) => {
      const scenario = data.testScenarios.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!scenario) throw new CatalogError("测试场景不存在", 404);
      if (scenario.isDefault) throw new CatalogError("默认场景由系统维护，不能编辑", 409);
      const name = requiredText(input.name, "场景名称", 160);
      const caseIds = input.caseIds === undefined ? undefined : this.validateScenarioCaseIds(data, productId, input.caseIds);
      uniqueName(data.testScenarios.filter((item) => item.productId === productId), name, "场景名称", id);
      const timestamp = new Date().toISOString();
      scenario.name = name;
      scenario.category = requiredText(input.category, "功能分类", 120);
      scenario.description = optionalText(input.description, 4_000);
      scenario.roles = this.normalizeScenarioRoles(input.roles);
      scenario.parameters = this.normalizeScenarioParameters(input.parameters ?? []);
      scenario.setupInstructions = requiredText(input.setupInstructions, "场景搭建要求", 20_000);
      scenario.verificationInstructions = requiredText(input.verificationInstructions, "场景验证要求", 10_000);
      scenario.cleanupInstructions = optionalText(input.cleanupInstructions, 10_000);
      scenario.updatedAt = timestamp;
      if (caseIds) {
        const selectedIds = new Set(caseIds);
        data.testCases
          .filter((testCase) => testCase.productId === productId && !testCase.archivedAt)
          .forEach((testCase) => {
            const nextScenarioId = selectedIds.has(testCase.id)
              ? id
              : testCase.scenarioId === id
                ? defaultScenarioId(productId)
                : testCase.scenarioId;
            if (nextScenarioId !== testCase.scenarioId) {
              testCase.scenarioId = nextScenarioId;
              testCase.updatedAt = timestamp;
            }
          });
      }
      return clone(scenario);
    });
  }

  async archiveTestScenario(productId: string, id: string): Promise<void> {
    await this.mutate((data) => {
      const scenario = data.testScenarios.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!scenario) throw new CatalogError("测试场景不存在", 404);
      if (scenario.isDefault) throw new CatalogError("默认场景不能删除", 409);
      if (data.testCases.some((testCase) => testCase.scenarioId === id && !testCase.archivedAt)) {
        throw new CatalogError("测试场景正在被测试用例使用，不能删除", 409);
      }
      scenario.archivedAt = new Date().toISOString();
      scenario.updatedAt = scenario.archivedAt;
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

  private validateOrderPhysicalEnvironment(data: CatalogData, productId: string, physicalEnvironmentValue: unknown): string {
    const physicalEnvironmentId = optionalText(physicalEnvironmentValue, 100);
    const physicalEnvironment = physicalEnvironmentId
      ? data.physicalEnvironments.find(
          (item) => item.id === physicalEnvironmentId && item.productId === productId && !item.archivedAt,
        )
      : undefined;
    if (physicalEnvironmentId && !physicalEnvironment) throw new CatalogError("物理环境不属于当前产品或不存在", 404);
    return physicalEnvironmentId;
  }

  async createTestOrder(productId: string, input: Record<string, unknown>): Promise<TestOrder> {
    return this.mutate((data) => {
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) {
        throw new CatalogError("产品不存在", 404);
      }
      const timestamp = new Date().toISOString();
      const order: TestOrder = {
        id: randomUUID(),
        productId,
        name: requiredText(input.name, "测试单名称", 200),
        description: optionalText(input.description, 4_000),
        physicalEnvironmentId: this.validateOrderPhysicalEnvironment(data, productId, input.physicalEnvironmentId),
        caseIds: this.validateOrderCases(data, productId, input.caseIds),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.testOrders.push(order);
      return clone(order);
    });
  }

  async updateTestOrder(productId: string, id: string, input: Record<string, unknown>): Promise<TestOrder> {
    return this.mutate((data) => {
      const order = data.testOrders.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!order) throw new CatalogError("测试单不存在", 404);
      order.name = requiredText(input.name, "测试单名称", 200);
      order.description = optionalText(input.description, 4_000);
      order.physicalEnvironmentId = this.validateOrderPhysicalEnvironment(data, productId, input.physicalEnvironmentId);
      order.caseIds = this.validateOrderCases(data, productId, input.caseIds);
      order.updatedAt = new Date().toISOString();
      return clone(order);
    });
  }

  async archiveTestOrder(productId: string, id: string): Promise<void> {
    await this.mutate((data) => {
      const order = data.testOrders.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!order) throw new CatalogError("测试单不存在", 404);
      order.archivedAt = new Date().toISOString();
      order.updatedAt = order.archivedAt;
    });
  }

  private publicOrder(data: CatalogData, order: TestOrder): TestOrderSummary {
    const product = data.products.find((item) => item.id === order.productId);
    const physicalEnvironment = data.physicalEnvironments.find((item) => item.id === order.physicalEnvironmentId);
    const latestRun = data.testRuns
      .filter((run) => run.testOrderId === order.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return {
      ...clone(order),
      productName: product?.name || "已删除产品",
      physicalEnvironmentName: physicalEnvironment?.name || "",
      caseCount: order.caseIds.length,
      latestRun: latestRun ? clone(latestRun) : undefined,
    };
  }

  async listTestOrders(productId: string): Promise<TestOrderSummary[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.testOrders
      .filter((order) => order.productId === productId && !order.archivedAt)
      .map((order) => this.publicOrder(data, order))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getTestOrder(productId: string, id: string): Promise<TestOrder> {
    const data = await this.read();
    const order = data.testOrders.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
    if (!order) throw new CatalogError("测试单不存在", 404);
    return clone(order);
  }

  async getTestOrderDetail(productId: string, id: string): Promise<TestOrderDetail> {
    const data = await this.read();
    const order = data.testOrders.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
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
    const physicalEnvironment = data.physicalEnvironments.find(
      (item) => item.id === order.physicalEnvironmentId && !item.archivedAt,
    );
    return {
      ...this.publicOrder(data, order),
      cases,
      runs,
      physicalEnvironment: physicalEnvironment ? clone(physicalEnvironment) : undefined,
    };
  }

  async getTestOrderExecutionContext(id: string): Promise<TestOrderExecutionContext> {
    const data = await this.read();
    const order = data.testOrders.find((item) => item.id === id && !item.archivedAt);
    if (!order) throw new CatalogError("测试单不存在", 404);
    const physicalEnvironment = data.physicalEnvironments.find(
      (item) => item.id === order.physicalEnvironmentId && !item.archivedAt,
    );
    const devices = physicalEnvironment
      ? physicalEnvironment.deviceIds
          .map((deviceId) => data.deviceResources.find((item) => item.id === deviceId && !item.archivedAt))
          .filter((item): item is DeviceResource => Boolean(item))
          .map(clone)
      : [];
    return {
      physicalEnvironment: physicalEnvironment ? clone(physicalEnvironment) : undefined,
      devices,
      scenarios: data.testScenarios
        .filter((scenario) => scenario.productId === order.productId && !scenario.archivedAt)
        .map(clone),
    };
  }

  async getDiagnosticExecutionContext(
    productId: string,
    testRunId: string,
    caseRunId: string,
  ): Promise<DiagnosticExecutionContext> {
    const data = await this.read();
    const product = data.products.find((item) => item.id === productId && !item.archivedAt);
    if (!product) throw new CatalogError("产品不存在", 404);
    const testRun = data.testRuns.find((item) => item.id === testRunId);
    const testOrder = testRun
      ? data.testOrders.find((item) => item.id === testRun.testOrderId && item.productId === productId)
      : undefined;
    if (!testRun || !testOrder) throw new CatalogError("测试执行记录不存在或不属于当前产品", 404);
    const caseRun = testRun.caseRuns.find((item) => item.id === caseRunId);
    if (!caseRun) throw new CatalogError("用例执行记录不存在", 404);
    const scenarioRun = testRun.scenarioRuns.find((item) => item.id === caseRun.scenarioRunId);
    if (!scenarioRun) throw new CatalogError("场景执行记录不存在", 404);
    const scenario = data.testScenarios.find((item) => item.id === scenarioRun.testScenarioId);
    const physicalEnvironment = data.physicalEnvironments.find(
      (item) => item.id === testOrder.physicalEnvironmentId && !item.archivedAt,
    );
    const devices = physicalEnvironment
      ? physicalEnvironment.deviceIds
          .map((deviceId) => data.deviceResources.find((item) => item.id === deviceId && !item.archivedAt))
          .filter((item): item is DeviceResource => Boolean(item))
      : [];

    return clone({
      product,
      testOrder,
      testRun,
      caseRun,
      scenarioRun,
      scenario,
      physicalEnvironment,
      devices,
      scenarios: scenario ? [scenario] : [],
    });
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
      const caseRuns: CaseRun[] = [];
      const scenarioRunsById = new Map<string, ScenarioRun>();
      for (const testCase of cases as TestCase[]) {
        const scenario = data.testScenarios.find(
          (item) => item.id === testCase.scenarioId && item.productId === order.productId && !item.archivedAt,
        );
        if (!scenario) throw new CatalogError(`用例“${testCase.name}”关联的测试场景不存在`);
        let scenarioRun = scenarioRunsById.get(scenario.id);
        if (!scenarioRun) {
          scenarioRun = {
            id: randomUUID(),
            testScenarioId: scenario.id,
            scenarioNameSnapshot: scenario.name,
            isDefault: scenario.isDefault,
            status: "queued",
            roleBindings: {},
            parameterValues: Object.fromEntries(
              scenario.parameters.map((parameter) => [parameter.key, parameter.defaultValue]),
            ),
            caseRunIds: [],
          };
          scenarioRunsById.set(scenario.id, scenarioRun);
        }
        const caseRun: CaseRun = {
          id: randomUUID(),
          testCaseId: testCase.id,
          scenarioRunId: scenarioRun.id,
          caseNameSnapshot: testCase.name,
          stepsSnapshot: testCase.steps,
          expectedResultSnapshot: testCase.expectedResult,
          status: "queued",
        };
        scenarioRun.caseRunIds.push(caseRun.id);
        caseRuns.push(caseRun);
      }
      const run: TestRun = {
        id: runId,
        testOrderId,
        triggerType: selectedCaseIds?.length ? "single" : "all",
        status: "queued",
        scenarioRuns: [...scenarioRunsById.values()],
        caseRuns,
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

  async failInterruptedTestRuns(reason: string): Promise<string[]> {
    return this.mutate((data) => {
      const finishedAt = new Date().toISOString();
      const interruptedRunIds: string[] = [];
      for (const run of data.testRuns) {
        if (run.status !== "queued" && run.status !== "running") continue;
        interruptedRunIds.push(run.id);
        run.status = "failed";
        run.outcome = "failed";
        run.finishedAt = finishedAt;
        run.caseRuns.forEach((caseRun) => {
          if (caseRun.status !== "queued" && caseRun.status !== "running") return;
          const wasRunning = caseRun.status === "running";
          caseRun.status = "failed";
          caseRun.outcome = "failed";
          caseRun.summary = wasRunning ? `执行中断：${reason}` : `未执行：${reason}`;
          caseRun.finishedAt = finishedAt;
        });
        run.scenarioRuns.forEach((scenarioRun) => {
          if (scenarioRun.status !== "queued" && scenarioRun.status !== "running") return;
          const prefix = scenarioRun.status === "running" ? "执行中断" : "未执行";
          scenarioRun.status = "failed";
          scenarioRun.outcome = "failed";
          scenarioRun.summary = scenarioRun.summary
            ? `${scenarioRun.summary}\n${prefix}：${reason}`
            : `${prefix}：${reason}`;
          scenarioRun.finishedAt = finishedAt;
        });
      }
      return interruptedRunIds;
    });
  }
}

export const catalogStore = new CatalogStore(path.resolve(process.cwd(), ".data", "catalog.json"));
