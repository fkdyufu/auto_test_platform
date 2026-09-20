import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executePiAssistant } from "./pi-runner.js";
import { modelRuntimePaths, type ModelSettings } from "./settings-store.js";
import { CatalogStore } from "./catalog-store.js";
import { AssistantStore } from "./assistant-store.js";
import { createAssistantTools } from "./assistant-tools.js";

test("pi assistant exposes platform and current-product device tools without browser or coding tools", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-assistant-runtime-"));
  const originalPaths = { ...modelRuntimePaths };
  for (const key of Object.keys(modelRuntimePaths) as (keyof typeof modelRuntimePaths)[]) modelRuntimePaths[key] = path.join(directory, key);
  t.after(async () => { Object.assign(modelRuntimePaths, originalPaths); await rm(directory, { recursive: true, force: true }); });
  const requests: Record<string, unknown>[] = [];
  let deviceId = "";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const index = requests.length;
    const delta = index === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: "context-call", type: "function", function: { name: "platform_context", arguments: "{}" } }] }
      : index === 2 ? { role: "assistant", tool_calls: [{ index: 0, id: "device-call", type: "function", function: { name: "device_http_request", arguments: JSON.stringify({ deviceId, interfaceId: "api", method: "GET", path: "status" }) } }] }
        : index === 3 ? { role: "assistant", tool_calls: [{ index: 0, id: "draft-call", type: "function", function: { name: "platform_propose_draft", arguments: JSON.stringify({ summary: "补充前置条件", values: { precondition: "检查环境" } }) } }] }
          : { role: "assistant", content: "设备状态已读取，并生成修改预览，请确认应用到表单。" };
    const chunk = (deltaValue: unknown, finishReason: string | null) => ({ id: `mock-${index}`, object: "chat.completion.chunk", created: 1, model: "mock-assistant", choices: [{ index: 0, delta: deltaValue, finish_reason: finishReason }] });
    response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, index < 4 ? "tool_calls" : "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const deviceRequests: string[] = [];
  const deviceServer = createServer((request, response) => {
    deviceRequests.push(`${request.method} ${request.url} ${request.headers.authorization || ""}`);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "ready" }));
  });
  deviceServer.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => deviceServer.on("listening", resolve));
  t.after(() => new Promise<void>((resolve) => deviceServer.close(() => resolve())));
  const deviceAddress = deviceServer.address() as { port: number };
  const settings: ModelSettings = { providerPreset: "custom", apiType: "openai-completions", reasoningLevel: "off", model: "mock-assistant", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "mock-key", userAgent: "" };
  const catalog = new CatalogStore(path.join(directory, "catalog.json"));
  const [product, otherProduct] = await catalog.listProducts();
  const device = await catalog.createDeviceResource(product.id, { name: "DUT", types: ["TAU"], controlInterfaces: [{ id: "api", name: "API", type: "api", address: `http://127.0.0.1:${deviceAddress.port}/`, username: "assistant", password: "device-secret" }] });
  deviceId = device.id;
  await catalog.createDeviceResource(otherProduct.id, { name: "OTHER", types: ["TAU"], controlInterfaces: [{ id: "telnet", name: "Telnet", type: "telnet", address: "192.0.2.20", username: "root", password: "foreign-secret" }] });
  const store = new AssistantStore(path.join(directory, "assistant.json"));
  const conversation = await store.create(product.id);
  const context = { page: "cases", title: "新增用例", assetKind: "case" as const, draftToken: "draft-token", draft: { name: "草稿", steps: "检查", expectedResult: "通过", precondition: "", scenarioId: "" } };
  await store.startTurn(product.id, conversation.id, "补充前置条件", "runtime-run", context);
  const events: string[] = [];
  const devices = await catalog.getProductDeviceControlResources(product.id);
  const execution = await executePiAssistant({ runId: "runtime-run", prompt: "补充当前草稿的前置条件", settings, devices, customTools: createAssistantTools({ catalog, store, productId: product.id, conversationId: conversation.id, runId: "runtime-run", context, isCancelled: () => false }), onEvent: (event) => events.push(event.type), onAbortReady: () => {} });
  assert.match(execution.finalText, /设备状态已读取/);
  assert.equal(requests.length, 4);
  const names = (requests[0].tools as { function: { name: string } }[]).map((tool) => tool.function.name);
  assert.deepEqual(names, ["platform_context", "platform_query", "platform_get", "platform_propose_changes", "platform_propose_draft", "device_http_request"]);
  assert.equal(names.some((name) => name.startsWith("browser_") || name === "device_telnet_exec" || name === "device_ssh_exec"), false);
  assert.equal(JSON.stringify(requests).includes("device-secret"), false);
  assert.equal(JSON.stringify(requests).includes("foreign-secret"), false);
  assert.deepEqual(deviceRequests, [`GET /status Basic ${Buffer.from("assistant:device-secret").toString("base64")}`]);
  assert.ok(events.includes("tool_start"));
  assert.ok(events.includes("assistant_delta"));
  assert.equal((await store.get(product.id, conversation.id)).proposals[0].status, "pending");
  assert.equal((await catalog.listTestCases(product.id)).length, 0);
});
