export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type TestOutcome = "passed" | "failed";

export interface ModelSettings {
  providerPreset: string;
  apiType: "openai-responses" | "openai-completions" | "anthropic-messages" | "google-generative-ai";
  reasoningLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  model: string;
  baseUrl: string;
  userAgent: string;
  apiKey?: string;
  hasApiKey: boolean;
  maskedApiKey: string;
  configured: boolean;
}

export interface ZentaoSettings {
  baseUrl: string;
  account: string;
  password?: string;
  hasPassword: boolean;
  configured: boolean;
}

export interface RunEvent {
  id: number;
  timestamp: string;
  type:
    | "status"
    | "assistant_delta"
    | "assistant"
    | "tool_start"
    | "tool_end"
    | "run_state"
    | "result"
    | "error"
    | "scenario_state"
    | "scenario_result"
    | "case_state"
    | "case_result";
  message?: string;
  tool?: string;
  toolCallId?: string;
  args?: unknown;
  error?: boolean;
  status?: RunStatus;
  outcome?: TestOutcome;
  testCaseId?: string;
  caseRunId?: string;
  caseName?: string;
  scenarioRunId?: string;
  scenarioName?: string;
}

export interface RunResponse {
  id: string;
  requirement: string;
  status: RunStatus;
  createdAt: string;
  events: RunEvent[];
  source: "adhoc" | "test_order";
  testOrderId?: string;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  zentaoId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSummary extends Product {
  caseCount: number;
  orderCount: number;
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
}

export type ControlInterfaceType = "web" | "ssh" | "telnet" | "serial" | "api" | "other";

export interface ControlInterface {
  id: string;
  name: string;
  type: ControlInterfaceType;
  address: string;
  username: string;
  hasPassword: boolean;
}

export interface ControlInterfaceInput extends Omit<ControlInterface, "hasPassword"> {
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
}

export interface CaseRun {
  id: string;
  testCaseId: string;
  scenarioRunId: string;
  caseNameSnapshot: string;
  stepsSnapshot: string;
  expectedResultSnapshot: string;
  status: RunStatus;
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
  status: RunStatus;
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
  status: RunStatus;
  outcome?: TestOutcome;
  scenarioRuns: ScenarioRun[];
  caseRuns: CaseRun[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TestOrderSummary {
  id: string;
  productId: string;
  productName: string;
  name: string;
  description: string;
  physicalEnvironmentId: string;
  physicalEnvironmentName: string;
  caseIds: string[];
  caseCount: number;
  createdAt: string;
  updatedAt: string;
  latestRun?: TestRun;
}

export interface TestOrderDetail extends TestOrderSummary {
  cases: TestCase[];
  runs: TestRun[];
  physicalEnvironment?: PhysicalEnvironment;
}

export interface ProductInput {
  name: string;
  description: string;
  zentaoId: string;
}

export interface TestCaseInput {
  scenarioId: string;
  name: string;
  steps: string;
  expectedResult: string;
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

export interface ZentaoCaseImportResult {
  created: number;
  updated: number;
  skipped: number;
}

export interface TestOrderInput {
  name: string;
  description: string;
  physicalEnvironmentId: string;
  caseIds: string[];
}

export interface DeviceResourceInput {
  name: string;
  type: string;
  model: string;
  description: string;
  controlInterfaces: ControlInterfaceInput[];
}
export type PhysicalEnvironmentInput = Omit<PhysicalEnvironment, "id" | "productId" | "createdAt" | "updatedAt">;
export type TestScenarioInput = Omit<TestScenario, "id" | "productId" | "isDefault" | "createdAt" | "updatedAt">;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  return payload;
}

export const api = {
  getSettings: () => request<ModelSettings>("/api/settings"),
  saveSettings: (settings: Partial<ModelSettings>) =>
    request<ModelSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  testSettings: () => request<{ ok: true; message: string }>("/api/settings/test", { method: "POST" }),
  getZentaoSettings: () => request<ZentaoSettings>("/api/settings/zentao"),
  saveZentaoSettings: (settings: Pick<ZentaoSettings, "baseUrl" | "account" | "password">) =>
    request<ZentaoSettings>("/api/settings/zentao", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  testZentaoConnection: (settings: Pick<ZentaoSettings, "baseUrl" | "account" | "password">) =>
    request<{ ok: true; message: string }>("/api/settings/zentao/test", {
      method: "POST",
      body: JSON.stringify(settings),
    }),
  getProducts: () => request<ProductSummary[]>("/api/products"),
  createProduct: (input: ProductInput) =>
    request<Product>("/api/products", { method: "POST", body: JSON.stringify(input) }),
  updateProduct: (id: string, input: ProductInput) =>
    request<Product>(`/api/products/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteProduct: (id: string) => request<void>(`/api/products/${id}`, { method: "DELETE" }),
  getTestCases: (productId: string) => request<TestCase[]>(`/api/products/${productId}/cases`),
  createTestCase: (productId: string, input: TestCaseInput) =>
    request<TestCase>(`/api/products/${productId}/cases`, { method: "POST", body: JSON.stringify(input) }),
  updateTestCase: (productId: string, id: string, input: TestCaseInput) =>
    request<TestCase>(`/api/products/${productId}/test-cases/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteTestCase: (productId: string, id: string) =>
    request<void>(`/api/products/${productId}/test-cases/${id}`, { method: "DELETE" }),
  getZentaoTestTasks: (productId: string) =>
    request<ZentaoTestTaskSummary[]>(`/api/products/${productId}/zentao/test-tasks`),
  getZentaoTestCases: (productId: string, testTaskId?: number) => {
    const query = testTaskId ? `?source=testTask&testTaskId=${testTaskId}` : "";
    return request<ZentaoCaseSummary[]>(`/api/products/${productId}/zentao/test-cases${query}`);
  },
  importZentaoTestCases: (productId: string, caseIds: number[], overwrite: boolean) =>
    request<ZentaoCaseImportResult>(`/api/products/${productId}/zentao/import-cases`, {
      method: "POST",
      body: JSON.stringify({ caseIds, overwrite }),
    }),
  getDeviceResources: (productId: string) => request<DeviceResource[]>(`/api/products/${productId}/device-resources`),
  createDeviceResource: (productId: string, input: DeviceResourceInput) =>
    request<DeviceResource>(`/api/products/${productId}/device-resources`, { method: "POST", body: JSON.stringify(input) }),
  updateDeviceResource: (productId: string, id: string, input: DeviceResourceInput) =>
    request<DeviceResource>(`/api/products/${productId}/device-resources/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteDeviceResource: (productId: string, id: string) =>
    request<void>(`/api/products/${productId}/device-resources/${id}`, { method: "DELETE" }),
  getPhysicalEnvironments: (productId: string) =>
    request<PhysicalEnvironment[]>(`/api/products/${productId}/physical-environments`),
  createPhysicalEnvironment: (productId: string, input: PhysicalEnvironmentInput) =>
    request<PhysicalEnvironment>(`/api/products/${productId}/physical-environments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updatePhysicalEnvironment: (productId: string, id: string, input: PhysicalEnvironmentInput) =>
    request<PhysicalEnvironment>(`/api/products/${productId}/physical-environments/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deletePhysicalEnvironment: (productId: string, id: string) =>
    request<void>(`/api/products/${productId}/physical-environments/${id}`, { method: "DELETE" }),
  getTestScenarios: (productId: string) => request<TestScenario[]>(`/api/products/${productId}/test-scenarios`),
  createTestScenario: (productId: string, input: TestScenarioInput) =>
    request<TestScenario>(`/api/products/${productId}/test-scenarios`, { method: "POST", body: JSON.stringify(input) }),
  updateTestScenario: (productId: string, id: string, input: TestScenarioInput) =>
    request<TestScenario>(`/api/products/${productId}/test-scenarios/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteTestScenario: (productId: string, id: string) =>
    request<void>(`/api/products/${productId}/test-scenarios/${id}`, { method: "DELETE" }),
  getTestOrders: (productId: string) => request<TestOrderSummary[]>(`/api/products/${productId}/test-orders`),
  getTestOrder: (productId: string, id: string) => request<TestOrderDetail>(`/api/products/${productId}/test-orders/${id}`),
  createTestOrder: (productId: string, input: TestOrderInput) =>
    request<TestOrderDetail>(`/api/products/${productId}/test-orders`, { method: "POST", body: JSON.stringify(input) }),
  updateTestOrder: (productId: string, id: string, input: TestOrderInput) =>
    request<TestOrderDetail>(`/api/products/${productId}/test-orders/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteTestOrder: (productId: string, id: string) =>
    request<void>(`/api/products/${productId}/test-orders/${id}`, { method: "DELETE" }),
  executeTestOrder: (productId: string, id: string, testCaseId?: string) =>
    request<RunResponse>(`/api/products/${productId}/test-orders/${id}/runs`, {
      method: "POST",
      body: JSON.stringify(testCaseId ? { testCaseId } : {}),
    }),
  getRun: (id: string) => request<RunResponse>(`/api/runs/${id}`),
  createRun: (requirement: string) =>
    request<RunResponse>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ requirement }),
    }),
  cancelRun: (id: string) => request<{ ok: true }>(`/api/runs/${id}/cancel`, { method: "POST" }),
};
