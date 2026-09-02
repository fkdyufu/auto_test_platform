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
  name: string;
  type: string;
  model: string;
  description: string;
  controlInterfaces: ControlInterface[];
  createdAt: string;
  updatedAt: string;
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
  name: string;
  description: string;
  deviceIds: string[];
  connections: EnvironmentConnection[];
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
  caseNameSnapshot: string;
  stepsSnapshot: string;
  expectedResultSnapshot: string;
  status: RunStatus;
  outcome?: TestOutcome;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TestRun {
  id: string;
  testOrderId: string;
  triggerType: "all" | "single";
  status: RunStatus;
  outcome?: TestOutcome;
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
  targetUrl: string;
  username: string;
  environmentId: string;
  environmentName: string;
  scenarioId: string;
  scenarioName: string;
  roleBindings: Record<string, string>;
  caseIds: string[];
  caseCount: number;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
  latestRun?: TestRun;
}

export interface TestOrderDetail extends TestOrderSummary {
  cases: TestCase[];
  runs: TestRun[];
  environment?: LabEnvironment;
  scenario?: TestScenario;
  boundDevices: DeviceResource[];
}

export interface ProductInput {
  name: string;
  description: string;
  zentaoId: string;
}

export interface TestCaseInput {
  name: string;
  steps: string;
  expectedResult: string;
}

export interface TestOrderInput {
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
}

export interface DeviceResourceInput {
  name: string;
  type: string;
  model: string;
  description: string;
  controlInterfaces: ControlInterfaceInput[];
}
export type LabEnvironmentInput = Omit<LabEnvironment, "id" | "createdAt" | "updatedAt">;
export type TestScenarioInput = Omit<TestScenario, "id" | "createdAt" | "updatedAt">;

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
  getProducts: () => request<ProductSummary[]>("/api/products"),
  createProduct: (input: ProductInput) =>
    request<Product>("/api/products", { method: "POST", body: JSON.stringify(input) }),
  updateProduct: (id: string, input: ProductInput) =>
    request<Product>(`/api/products/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteProduct: (id: string) => request<void>(`/api/products/${id}`, { method: "DELETE" }),
  getTestCases: (productId: string) => request<TestCase[]>(`/api/products/${productId}/cases`),
  createTestCase: (productId: string, input: TestCaseInput) =>
    request<TestCase>(`/api/products/${productId}/cases`, { method: "POST", body: JSON.stringify(input) }),
  updateTestCase: (id: string, input: TestCaseInput) =>
    request<TestCase>(`/api/test-cases/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteTestCase: (id: string) => request<void>(`/api/test-cases/${id}`, { method: "DELETE" }),
  getDeviceResources: () => request<DeviceResource[]>("/api/device-resources"),
  createDeviceResource: (input: DeviceResourceInput) =>
    request<DeviceResource>("/api/device-resources", { method: "POST", body: JSON.stringify(input) }),
  updateDeviceResource: (id: string, input: DeviceResourceInput) =>
    request<DeviceResource>(`/api/device-resources/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteDeviceResource: (id: string) => request<void>(`/api/device-resources/${id}`, { method: "DELETE" }),
  getLabEnvironments: () => request<LabEnvironment[]>("/api/lab-environments"),
  createLabEnvironment: (input: LabEnvironmentInput) =>
    request<LabEnvironment>("/api/lab-environments", { method: "POST", body: JSON.stringify(input) }),
  updateLabEnvironment: (id: string, input: LabEnvironmentInput) =>
    request<LabEnvironment>(`/api/lab-environments/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteLabEnvironment: (id: string) => request<void>(`/api/lab-environments/${id}`, { method: "DELETE" }),
  getTestScenarios: () => request<TestScenario[]>("/api/test-scenarios"),
  createTestScenario: (input: TestScenarioInput) =>
    request<TestScenario>("/api/test-scenarios", { method: "POST", body: JSON.stringify(input) }),
  updateTestScenario: (id: string, input: TestScenarioInput) =>
    request<TestScenario>(`/api/test-scenarios/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteTestScenario: (id: string) => request<void>(`/api/test-scenarios/${id}`, { method: "DELETE" }),
  getTestOrders: () => request<TestOrderSummary[]>("/api/test-orders"),
  getTestOrder: (id: string) => request<TestOrderDetail>(`/api/test-orders/${id}`),
  createTestOrder: (input: TestOrderInput) =>
    request<TestOrderDetail>("/api/test-orders", { method: "POST", body: JSON.stringify(input) }),
  updateTestOrder: (id: string, input: TestOrderInput) =>
    request<TestOrderDetail>(`/api/test-orders/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteTestOrder: (id: string) => request<void>(`/api/test-orders/${id}`, { method: "DELETE" }),
  executeTestOrder: (id: string, testCaseId?: string) =>
    request<RunResponse>(`/api/test-orders/${id}/runs`, {
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
