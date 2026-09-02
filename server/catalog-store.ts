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
  type: string;
  model: string;
  description: string;
  controlInterfaces: ControlInterface[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface EnvironmentConnection {
  id: string;
  sourceDeviceId: string;
  sourcePort: string;
  targetDeviceId: string;
  targetPort: string;
  description: string;
}

export interface LabEnvironment {
  id: string;
  productId: string;
  name: string;
  description: string;
  deviceIds: string[];
  connections: EnvironmentConnection[];
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
  targetUrl: string;
  username: string;
  password: string;
  environmentId: string;
  scenarioId: string;
  roleBindings: Record<string, string>;
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
  version: 4;
  products: Product[];
  testCases: TestCase[];
  deviceResources: DeviceResource[];
  labEnvironments: LabEnvironment[];
  testScenarios: TestScenario[];
  testOrders: TestOrder[];
  testRuns: TestRun[];
}

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

export interface TestOrderSummary extends Omit<TestOrder, "password"> {
  productName: string;
  environmentName: string;
  scenarioName: string;
  caseCount: number;
  hasPassword: boolean;
  latestRun?: TestRun;
}

export interface TestOrderDetail extends TestOrderSummary {
  cases: TestCase[];
  runs: TestRun[];
  environment?: LabEnvironment;
  scenario?: TestScenario;
  boundDevices: DeviceResourceSummary[];
}

export interface TestOrderExecutionContext {
  environment?: LabEnvironment;
  scenario?: TestScenario;
  devices: DeviceResource[];
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

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function uniqueName(data: { name: string; archivedAt?: string }[], name: string, label: string, currentId?: string): void {
  if (data.some((item) => !item.archivedAt && (item as { id?: string }).id !== currentId && item.name.toLowerCase() === name.toLowerCase())) {
    throw new CatalogError(`${label}已存在`, 409);
  }
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
    version: 4,
    products: ["WKCJ-I", "WKCJ-II"].map((name) => ({
      id: randomUUID(),
      name,
      description: "",
      zentaoId: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    testCases: [],
    deviceResources: [],
    labEnvironments: [],
    testScenarios: [],
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
    if (![1, 2, 3, 4].includes(data.version) || !Array.isArray(data.products) || !Array.isArray(data.testCases)) {
      throw new CatalogError("业务数据文件格式不正确", 500);
    }
    data.version = 4;
    data.deviceResources ??= [];
    data.labEnvironments ??= [];
    data.testScenarios ??= [];
    data.testOrders ??= [];
    data.testRuns ??= [];
    data.testOrders.forEach((order) => {
      order.environmentId ??= "";
      order.scenarioId ??= "";
      order.roleBindings ??= {};
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
    const environmentOwners = new Map<string, string>();
    const scenarioOwners = new Map<string, string>();
    data.testOrders.forEach((order) => {
      if (order.environmentId && !environmentOwners.has(order.environmentId)) environmentOwners.set(order.environmentId, order.productId);
      if (order.scenarioId && !scenarioOwners.has(order.scenarioId)) scenarioOwners.set(order.scenarioId, order.productId);
    });
    data.labEnvironments = data.labEnvironments.map((environment) => ({
      ...environment,
      productId: productIds.has(environment.productId)
        ? environment.productId
        : environmentOwners.get(environment.id) || fallbackProductId,
    }));
    data.testScenarios = data.testScenarios.map((scenario) => ({
      ...scenario,
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
    const deviceOwners = new Map<string, string>();
    data.labEnvironments.forEach((environment) => {
      environment.deviceIds.forEach((deviceId) => {
        if (!deviceOwners.has(deviceId)) deviceOwners.set(deviceId, environment.productId);
      });
    });
    data.deviceResources = data.deviceResources.map((device) => ({
      id: device.id,
      productId: productIds.has(device.productId) ? device.productId : deviceOwners.get(device.id) || fallbackProductId,
      name: device.name,
      type: device.type,
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
    data.labEnvironments.forEach((environment) => {
      const allowedIds = new Set(environment.deviceIds.filter((deviceId) => deviceProductById.get(deviceId) === environment.productId));
      environment.deviceIds = [...allowedIds];
      environment.connections = environment.connections.filter(
        (connection) => allowedIds.has(connection.sourceDeviceId) && allowedIds.has(connection.targetDeviceId),
      );
    });
    data.testOrders.forEach((order) => {
      const environment = data.labEnvironments.find((item) => item.id === order.environmentId);
      const scenario = data.testScenarios.find((item) => item.id === order.scenarioId);
      if (environment && environment.productId !== order.productId) order.environmentId = "";
      if (scenario && scenario.productId !== order.productId) order.scenarioId = "";
      if (!order.environmentId || !order.scenarioId) order.roleBindings = {};
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
      data.labEnvironments.filter((item) => item.productId === id && !item.archivedAt).forEach((item) => (item.archivedAt = timestamp));
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

  async updateTestCase(productId: string, id: string, input: Record<string, unknown>): Promise<TestCase> {
    return this.mutate((data) => {
      const testCase = data.testCases.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!testCase) throw new CatalogError("测试用例不存在", 404);
      testCase.name = requiredText(input.name, "用例名称", 200);
      testCase.steps = requiredText(input.steps, "测试步骤", 20_000);
      testCase.expectedResult = requiredText(input.expectedResult, "预期结果", 10_000);
      testCase.updatedAt = new Date().toISOString();
      return clone(testCase);
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
        type: requiredText(input.type, "设备类型", 120),
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
      device.type = requiredText(input.type, "设备类型", 120);
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
      if (data.labEnvironments.some((item) => !item.archivedAt && item.deviceIds.includes(id))) {
        throw new CatalogError("设备正在被实验环境使用，不能删除", 409);
      }
      device.archivedAt = new Date().toISOString();
      device.updatedAt = device.archivedAt;
    });
  }

  private normalizeEnvironmentDevices(data: CatalogData, productId: string, value: unknown): string[] {
    if (!Array.isArray(value)) throw new CatalogError("请选择环境设备");
    const deviceIds = [...new Set(value.filter((item): item is string => typeof item === "string"))];
    if (!deviceIds.length) throw new CatalogError("实验环境至少需要一台设备");
    const activeIds = new Set(
      data.deviceResources.filter((item) => item.productId === productId && !item.archivedAt).map((item) => item.id),
    );
    if (deviceIds.some((id) => !activeIds.has(id))) throw new CatalogError("实验环境包含其他产品或不存在的设备");
    return deviceIds;
  }

  private normalizeConnections(value: unknown, deviceIds: string[]): EnvironmentConnection[] {
    if (!Array.isArray(value)) throw new CatalogError("连接关系格式不正确");
    if (value.length > 500) throw new CatalogError("连接关系不能超过 500 条");
    const allowedDevices = new Set(deviceIds);
    return value.map((item) => {
      const input = recordValue(item);
      const sourceDeviceId = requiredText(input.sourceDeviceId, "本端设备");
      const targetDeviceId = requiredText(input.targetDeviceId, "对端设备");
      if (!allowedDevices.has(sourceDeviceId) || !allowedDevices.has(targetDeviceId)) {
        throw new CatalogError("连接关系中的设备不属于当前实验环境");
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

  async listLabEnvironments(productId: string): Promise<LabEnvironment[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.labEnvironments
      .filter((item) => item.productId === productId && !item.archivedAt)
      .map(clone)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  async createLabEnvironment(productId: string, input: Record<string, unknown>): Promise<LabEnvironment> {
    return this.mutate((data) => {
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) throw new CatalogError("产品不存在", 404);
      const name = requiredText(input.name, "环境名称", 160);
      uniqueName(data.labEnvironments.filter((item) => item.productId === productId), name, "环境名称");
      const deviceIds = this.normalizeEnvironmentDevices(data, productId, input.deviceIds);
      const timestamp = new Date().toISOString();
      const environment: LabEnvironment = {
        id: randomUUID(),
        productId,
        name,
        description: optionalText(input.description, 4_000),
        deviceIds,
        connections: this.normalizeConnections(input.connections ?? [], deviceIds),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.labEnvironments.push(environment);
      return clone(environment);
    });
  }

  async updateLabEnvironment(productId: string, id: string, input: Record<string, unknown>): Promise<LabEnvironment> {
    return this.mutate((data) => {
      const environment = data.labEnvironments.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!environment) throw new CatalogError("实验环境不存在", 404);
      const name = requiredText(input.name, "环境名称", 160);
      uniqueName(data.labEnvironments.filter((item) => item.productId === productId), name, "环境名称", id);
      const deviceIds = this.normalizeEnvironmentDevices(data, productId, input.deviceIds);
      environment.name = name;
      environment.description = optionalText(input.description, 4_000);
      environment.deviceIds = deviceIds;
      environment.connections = this.normalizeConnections(input.connections ?? [], deviceIds);
      environment.updatedAt = new Date().toISOString();
      return clone(environment);
    });
  }

  async archiveLabEnvironment(productId: string, id: string): Promise<void> {
    await this.mutate((data) => {
      const environment = data.labEnvironments.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!environment) throw new CatalogError("实验环境不存在", 404);
      if (data.testOrders.some((item) => !item.archivedAt && item.environmentId === id)) {
        throw new CatalogError("实验环境正在被测试单使用，不能删除", 409);
      }
      environment.archivedAt = new Date().toISOString();
      environment.updatedAt = environment.archivedAt;
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

  async listTestScenarios(productId: string): Promise<TestScenario[]> {
    await this.getProduct(productId);
    const data = await this.read();
    return data.testScenarios
      .filter((item) => item.productId === productId && !item.archivedAt)
      .map(clone)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
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
        name,
        category: requiredText(input.category, "功能分类", 120),
        description: optionalText(input.description, 4_000),
        roles: this.normalizeScenarioRoles(input.roles),
        parameters: this.normalizeScenarioParameters(input.parameters ?? []),
        setupInstructions: requiredText(input.setupInstructions, "环境搭建要求", 20_000),
        verificationInstructions: requiredText(input.verificationInstructions, "环境验证要求", 10_000),
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
      const name = requiredText(input.name, "场景名称", 160);
      uniqueName(data.testScenarios.filter((item) => item.productId === productId), name, "场景名称", id);
      scenario.name = name;
      scenario.category = requiredText(input.category, "功能分类", 120);
      scenario.description = optionalText(input.description, 4_000);
      scenario.roles = this.normalizeScenarioRoles(input.roles);
      scenario.parameters = this.normalizeScenarioParameters(input.parameters ?? []);
      scenario.setupInstructions = requiredText(input.setupInstructions, "环境搭建要求", 20_000);
      scenario.verificationInstructions = requiredText(input.verificationInstructions, "环境验证要求", 10_000);
      scenario.cleanupInstructions = optionalText(input.cleanupInstructions, 10_000);
      scenario.updatedAt = new Date().toISOString();
      return clone(scenario);
    });
  }

  async archiveTestScenario(productId: string, id: string): Promise<void> {
    await this.mutate((data) => {
      const scenario = data.testScenarios.find((item) => item.id === id && item.productId === productId && !item.archivedAt);
      if (!scenario) throw new CatalogError("测试场景不存在", 404);
      if (data.testOrders.some((item) => !item.archivedAt && item.scenarioId === id)) {
        throw new CatalogError("测试场景正在被测试单使用，不能删除", 409);
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

  private validateOrderEnvironment(
    data: CatalogData,
    productId: string,
    environmentValue: unknown,
    scenarioValue: unknown,
    bindingsValue: unknown,
  ): Pick<TestOrder, "environmentId" | "scenarioId" | "roleBindings"> {
    const environmentId = optionalText(environmentValue, 100);
    const scenarioId = optionalText(scenarioValue, 100);
    const environment = environmentId
      ? data.labEnvironments.find((item) => item.id === environmentId && item.productId === productId && !item.archivedAt)
      : undefined;
    const scenario = scenarioId
      ? data.testScenarios.find((item) => item.id === scenarioId && item.productId === productId && !item.archivedAt)
      : undefined;
    if (environmentId && !environment) throw new CatalogError("实验环境不属于当前产品或不存在", 404);
    if (scenarioId && !scenario) throw new CatalogError("测试场景不属于当前产品或不存在", 404);
    if (scenario && !environment) throw new CatalogError("选择测试场景后必须选择实验环境");
    if (!scenario) return { environmentId, scenarioId: "", roleBindings: {} };

    const input = recordValue(bindingsValue);
    const roleBindings: Record<string, string> = {};
    for (const role of scenario.roles) {
      const deviceId = optionalText(input[role.key], 100);
      if (!deviceId) throw new CatalogError(`请为角色“${role.name}”绑定设备`);
      if (!environment?.deviceIds.includes(deviceId)) throw new CatalogError(`角色“${role.name}”绑定的设备不属于所选环境`);
      const device = data.deviceResources.find((item) => item.id === deviceId && item.productId === productId && !item.archivedAt);
      if (!device) throw new CatalogError(`角色“${role.name}”绑定的设备不存在`);
      if (device.type.toLowerCase() !== role.deviceType.toLowerCase()) {
        throw new CatalogError(`角色“${role.name}”需要 ${role.deviceType} 类型设备`);
      }
      roleBindings[role.key] = deviceId;
    }
    return { environmentId, scenarioId, roleBindings };
  }

  async createTestOrder(productId: string, input: Record<string, unknown>): Promise<TestOrder> {
    return this.mutate((data) => {
      if (!data.products.some((item) => item.id === productId && !item.archivedAt)) {
        throw new CatalogError("产品不存在", 404);
      }
      const timestamp = new Date().toISOString();
      const environment = this.validateOrderEnvironment(data, productId, input.environmentId, input.scenarioId, input.roleBindings);
      const order: TestOrder = {
        id: randomUUID(),
        productId,
        name: requiredText(input.name, "测试单名称", 200),
        description: optionalText(input.description, 4_000),
        targetUrl: normalizeTargetUrl(input.targetUrl),
        username: optionalText(input.username, 300),
        password: optionalText(input.password, 1_000),
        ...environment,
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
      order.targetUrl = normalizeTargetUrl(input.targetUrl);
      order.username = optionalText(input.username, 300);
      if (typeof input.password === "string" && input.password.trim()) order.password = input.password.trim();
      Object.assign(order, this.validateOrderEnvironment(data, productId, input.environmentId, input.scenarioId, input.roleBindings));
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
    const { password: _password, ...safeOrder } = clone(order);
    const product = data.products.find((item) => item.id === order.productId);
    const environment = data.labEnvironments.find((item) => item.id === order.environmentId);
    const scenario = data.testScenarios.find((item) => item.id === order.scenarioId);
    const latestRun = data.testRuns
      .filter((run) => run.testOrderId === order.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return {
      ...safeOrder,
      productName: product?.name || "已删除产品",
      environmentName: environment?.name || "",
      scenarioName: scenario?.name || "",
      caseCount: order.caseIds.length,
      hasPassword: Boolean(order.password),
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
    const environment = data.labEnvironments.find((item) => item.id === order.environmentId && !item.archivedAt);
    const scenario = data.testScenarios.find((item) => item.id === order.scenarioId && !item.archivedAt);
    const boundIds = new Set(Object.values(order.roleBindings));
    const boundDevices = data.deviceResources
      .filter((item) => boundIds.has(item.id) && !item.archivedAt)
      .map((item) => this.publicDevice(item));
    return {
      ...this.publicOrder(data, order),
      cases,
      runs,
      environment: environment ? clone(environment) : undefined,
      scenario: scenario ? clone(scenario) : undefined,
      boundDevices,
    };
  }

  async getTestOrderExecutionContext(id: string): Promise<TestOrderExecutionContext> {
    const data = await this.read();
    const order = data.testOrders.find((item) => item.id === id && !item.archivedAt);
    if (!order) throw new CatalogError("测试单不存在", 404);
    const environment = data.labEnvironments.find((item) => item.id === order.environmentId && !item.archivedAt);
    const scenario = data.testScenarios.find((item) => item.id === order.scenarioId && !item.archivedAt);
    const devices = environment
      ? environment.deviceIds
          .map((deviceId) => data.deviceResources.find((item) => item.id === deviceId && !item.archivedAt))
          .filter((item): item is DeviceResource => Boolean(item))
          .map(clone)
      : [];
    return {
      environment: environment ? clone(environment) : undefined,
      scenario: scenario ? clone(scenario) : undefined,
      devices,
    };
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
