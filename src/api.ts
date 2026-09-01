export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
  type: "status" | "assistant_delta" | "assistant" | "tool_start" | "tool_end" | "run_state" | "result" | "error";
  message?: string;
  tool?: string;
  toolCallId?: string;
  args?: unknown;
  error?: boolean;
  status?: RunStatus;
  outcome?: "passed" | "failed";
}

export interface RunResponse {
  id: string;
  requirement: string;
  status: RunStatus;
  createdAt: string;
  events: RunEvent[];
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
  createRun: (requirement: string) =>
    request<RunResponse>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ requirement }),
    }),
  cancelRun: (id: string) => request<{ ok: true }>(`/api/runs/${id}/cancel`, { method: "POST" }),
};
