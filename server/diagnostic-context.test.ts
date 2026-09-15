import assert from "node:assert/strict";
import test from "node:test";
import type { DiagnosticExecutionContext } from "./catalog-store.js";
import { buildDiagnosticPrompt } from "./diagnostic-context.js";

const context = {
  product: { id: "product-1", name: "WKCJ-II", description: "测试产品" },
  testOrder: { id: "order-1", name: "VRRP 回归" },
  testRun: { id: "run-1" },
  caseRun: {
    id: "case-run-1",
    caseNameSnapshot: "检查主备切换",
    stepsSnapshot: "断开主设备上联",
    expectedResultSnapshot: "备设备接管",
    status: "completed",
    outcome: "failed",
    summary: "未观察到接管",
  },
  scenarioRun: {
    id: "scenario-run-1",
    scenarioNameSnapshot: "VRRP 双机",
    roleBindings: { dut: "device-1" },
    parameterValues: { vlan: "100" },
    summary: "场景已搭建",
  },
  scenario: {
    name: "VRRP 双机",
    category: "VRRP",
    description: "双机主备",
    roles: [{ key: "dut", name: "被测设备", deviceType: "TAU" }],
    parameters: [{ key: "vlan", name: "业务 VLAN" }],
    setupInstructions: "配置二层连通",
    verificationInstructions: "检查邻居状态",
  },
  physicalEnvironment: {
    name: "网络实验室",
    description: "固定布线",
    connections: [],
  },
  devices: [{
    id: "device-1",
    name: "TAU1",
    type: "TAU",
    model: "WKCJ-II",
    controlInterfaces: [{
      id: "ssh-1",
      name: "管理 SSH",
      type: "ssh",
      address: "192.0.2.10",
      username: "root",
      password: "top-secret",
    }],
  }],
  scenarios: [],
} as unknown as DiagnosticExecutionContext;

test("builds a scoped diagnostic prompt without credentials or unrelated case evidence", () => {
  const prompt = buildDiagnosticPrompt(context, [
    {
      timestamp: "2026-09-15T01:00:00.000Z",
      type: "tool_end",
      tool: "device_ssh_exec",
      message: "ip link: DOWN",
      caseRunId: "case-run-1",
      scenarioRunId: "scenario-run-1",
    },
    {
      timestamp: "2026-09-15T01:00:01.000Z",
      type: "tool_end",
      tool: "device_ssh_exec",
      message: "不应出现的其他用例内容",
      caseRunId: "case-run-2",
      scenarioRunId: "scenario-run-1",
    },
    {
      timestamp: "2026-09-15T01:00:02.000Z",
      type: "assistant_delta",
      message: "不应携带的模型流式文本",
      caseRunId: "case-run-1",
    },
  ], [{
    id: "message-1",
    role: "user",
    content: "为什么没有切换？",
    runId: "diagnostic-1",
    createdAt: "2026-09-15T02:00:00.000Z",
  }]);

  assert.match(prompt, /检查主备切换/);
  assert.match(prompt, /ip link: DOWN/);
  assert.match(prompt, /为什么没有切换/);
  assert.match(prompt, /管理 SSH\[ssh, ID: ssh-1/);
  assert.doesNotMatch(prompt, /top-secret/);
  assert.doesNotMatch(prompt, /其他用例内容/);
  assert.doesNotMatch(prompt, /模型流式文本/);
});

test("keeps the newest question when diagnostic context must be truncated", () => {
  const largeContext = structuredClone(context);
  largeContext.caseRun.stepsSnapshot = "步骤".repeat(30_000);
  const messages = Array.from({ length: 12 }, (_, index) => ({
    id: `message-${index}`,
    role: (index % 2 ? "assistant" : "user") as "assistant" | "user",
    content: `历史内容 ${index} ${"内容".repeat(2_000)}`,
    runId: `diagnostic-${index}`,
    createdAt: "2026-09-15T02:00:00.000Z",
  }));
  messages.push({
    id: "latest",
    role: "user",
    content: "LATEST_QUESTION 必须保留",
    runId: "diagnostic-latest",
    createdAt: "2026-09-15T03:00:00.000Z",
  });

  const prompt = buildDiagnosticPrompt(largeContext, [], messages);
  assert.match(prompt, /LATEST_QUESTION 必须保留/);
  assert.ok(prompt.length < 48_100);
});
