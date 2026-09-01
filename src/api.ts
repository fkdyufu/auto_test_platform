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
  caseIds: string[];
}

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
