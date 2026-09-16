import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { CatalogError, CatalogStore } from "./catalog-store.js";
import { AssistantStore } from "./assistant-store.js";
import { AssistantAssetReader, createAssistantTools, normalizeAssistantContext } from "./assistant-tools.js";
import { createAssistantRouter } from "./assistant-routes.js";
import { applyDraftPatch } from "../shared/assistant-draft.js";
import { buildAssistantPrompt } from "./assistant-context.js";
import { sanitizeToolEvent } from "./event-sanitizer.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-assistant-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "catalog.json");
  const catalog = new CatalogStore(filePath);
  const store = new AssistantStore(path.join(directory, "assistant.json"));
  const [product, other] = await catalog.listProducts();
  const device = await catalog.createDeviceResource(product.id, { name: "DUT", types: ["TAU"], controlInterfaces: [{ id: "ssh", name: "SSH", type: "ssh", address: "192.0.2.1", username: "root", password: "secret-value" }] });
  const scenario = await catalog.createTestScenario(product.id, { name: "镜像场景", category: "镜像", roles: [{ key: "DUT", deviceId: device.id }], setupInstructions: "配置镜像", verificationInstructions: "验证镜像" });
  const first = await catalog.createTestCase(product.id, { scenarioId: scenario.id, name: "用例一", steps: "原步骤", expectedResult: "原预期" });
  const second = await catalog.createTestCase(product.id, { scenarioId: scenario.id, name: "用例二", steps: "原步骤", expectedResult: "原预期" });
  const order = await catalog.createTestOrder(product.id, { name: "测试单", caseIds: [first.id, second.id] });
  return { directory, filePath, catalog, store, product, other, device, scenario, first, second, order };
}

test("assistant queries relationships and pagination without crossing products or exposing passwords", async (t) => {
  const f = await fixture(t);
  const foreign = await f.catalog.createTestCase(f.other.id, { name: "外部用例", steps: "步骤", expectedResult: "结果" });
  const reader = new AssistantAssetReader(f.catalog, f.product.id);
  const page = await reader.query("case", { scenarioId: f.scenario.id, limit: 1, offset: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.equal((await reader.query("case", { orderId: f.order.id })).total, 2);
  assert.equal((await reader.query("scenario", { deviceId: f.device.id })).items[0].id, f.scenario.id);
  assert.deepEqual((await reader.get("scenario", f.scenario.id) as { caseIds: string[] }).caseIds, [f.first.id, f.second.id]);
  assert.equal(JSON.stringify(await reader.get("device", f.device.id)).includes("secret-value"), false);
  await assert.rejects(reader.get("case", foreign.id), CatalogError);
  await assert.rejects(reader.query("case", { scenarioId: "foreign-scenario" }), CatalogError);
});

test("asset previews are non-mutating and partial batch edits preserve historical snapshots", async (t) => {
  const f = await fixture(t);
  const execution = await f.catalog.createTestRun("historical", f.order.id);
  const original = await readFile(f.filePath, "utf8");
  const preview = await f.catalog.previewAssetChanges(f.product.id, [
    { kind: "case", operation: "update", id: f.first.id, values: { precondition: "检查环境" } },
    { kind: "case", operation: "update", id: f.second.id, values: { steps: "新步骤" } },
  ]);
  assert.equal(await readFile(f.filePath, "utf8"), original);
  assert.equal(preview.differences.length, 2);
  await f.catalog.applyAssetChanges(f.product.id, preview);
  const cases = await f.catalog.listTestCases(f.product.id);
  assert.equal(cases.find((item) => item.id === f.first.id)?.steps, "原步骤");
  assert.equal(cases.find((item) => item.id === f.first.id)?.precondition, "检查环境");
  assert.deepEqual((await f.catalog.getTestOrderDetail(f.product.id, f.order.id)).runs[0], execution);
});

test("generic asset operations support creation, relationship edits, and deletion side effects", async (t) => {
  const f = await fixture(t);
  const preview = await f.catalog.previewAssetChanges(f.product.id, [
    { kind: "device", operation: "update", id: f.device.id, values: { description: "新描述" } },
    { kind: "scenario", operation: "update", id: f.scenario.id, values: { caseIds: [f.first.id] } },
    { kind: "case", operation: "delete", id: f.second.id },
    { kind: "order", operation: "update", id: f.order.id, values: { description: "更新测试单" } },
    { kind: "case", operation: "create", values: { name: "新用例", steps: "步骤", expectedResult: "结果" } },
  ]);
  assert.ok(preview.differences.some((item) => item.kind === "order" && (item.after?.caseIds as string[]).length === 1));
  assert.equal(JSON.stringify(preview).includes("secret-value"), false);
  await f.catalog.applyAssetChanges(f.product.id, preview);
  assert.deepEqual((await f.catalog.getTestOrder(f.product.id, f.order.id)).caseIds, [f.first.id]);
  assert.ok((await f.catalog.listTestCases(f.product.id)).some((item) => item.name === "新用例"));
  assert.equal((await f.catalog.getTestOrderExecutionContext(f.order.id)).devices[0].controlInterfaces[0].password, "secret-value");
});

test("invalid batches, foreign assets and stale previews never partially commit", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.filePath, "utf8");
  await assert.rejects(f.catalog.previewAssetChanges(f.product.id, [
    { kind: "case", operation: "update", id: f.first.id, values: { name: "不要保存" } },
    { kind: "device", operation: "delete", id: f.device.id },
  ]), CatalogError);
  assert.equal(await readFile(f.filePath, "utf8"), original);
  const preview = await f.catalog.previewAssetChanges(f.product.id, [{ kind: "case", operation: "update", id: f.first.id, values: { steps: "助手修改" } }]);
  await f.catalog.updateTestCase(f.product.id, f.first.id, { ...f.first, steps: "用户较新的修改" });
  await assert.rejects(f.catalog.applyAssetChanges(f.product.id, preview), (error: unknown) => error instanceof CatalogError && error.status === 409);
  assert.equal((await f.catalog.listTestCases(f.product.id))[0].steps, "用户较新的修改");
  await assert.rejects(f.catalog.previewAssetChanges(f.other.id, [{ kind: "case", operation: "update", id: f.first.id, values: { steps: "跨产品" } }]), CatalogError);
  await assert.rejects(f.catalog.previewAssetChanges(f.product.id, [{ kind: "case", operation: "update", id: f.first.id, values: { productId: f.other.id } }]), CatalogError);
});

test("assistant persists conversations and confirms each proposal only once", async (t) => {
  const f = await fixture(t);
  const conversation = await f.store.create(f.product.id);
  await f.store.startTurn(f.product.id, conversation.id, "修改步骤", "assistant-turn", { page: "cases", title: "用例一" });
  await assert.rejects(f.store.startTurn(f.product.id, conversation.id, "重复", "overlap", { page: "cases", title: "用例一" }), CatalogError);
  const preview = await f.catalog.previewAssetChanges(f.product.id, [{ kind: "case", operation: "update", id: f.first.id, values: { steps: "新步骤" } }]);
  const proposal = await f.store.propose(f.product.id, conversation.id, { runId: "assistant-turn", target: "assets", summary: "修改步骤", preview });
  await assert.rejects(f.store.resolveProposal(f.product.id, conversation.id, proposal.id, "apply", async () => {}), CatalogError);
  await f.store.finishTurn(f.product.id, conversation.id, "assistant-turn", "请确认修改");
  let count = 0;
  const apply = async () => { count += 1; await f.catalog.applyAssetChanges(f.product.id, preview); };
  const results = await Promise.allSettled([
    f.store.resolveProposal(f.product.id, conversation.id, proposal.id, "apply", apply),
    f.store.resolveProposal(f.product.id, conversation.id, proposal.id, "apply", apply),
  ]);
  assert.equal(count, 1);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const restored = await new AssistantStore(path.join(f.directory, "assistant.json")).get(f.product.id, conversation.id);
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.proposals[0].status, "applied");
  await assert.rejects(f.store.get(f.other.id, conversation.id), CatalogError);
});

test("assistant recovers interrupted turns and rejects abandoned proposals", async (t) => {
  const f = await fixture(t);
  const conversation = await f.store.create(f.product.id);
  await f.store.startTurn(f.product.id, conversation.id, "继续", "interrupted", { page: "cases", title: "用例" });
  await f.store.propose(f.product.id, conversation.id, { runId: "interrupted", summary: "草稿修改", target: "draft", values: { name: "新名称" } });
  assert.equal(await f.store.failInterruptedConversations("服务重启"), 1);
  const recovered = await f.store.get(f.product.id, conversation.id);
  assert.equal(recovered.status, "idle");
  assert.equal(recovered.proposals[0].status, "rejected");
  assert.equal(recovered.messages.at(-1)?.error, true);
});

test("assistant exposes only generic tools and proposes drafts without saving assets", async (t) => {
  const f = await fixture(t);
  const conversation = await f.store.create(f.product.id);
  const context = normalizeAssistantContext({ page: "cases", title: "草稿", assetKind: "case", assetId: f.first.id, draftToken: "draft-token", draft: { name: "未保存名称", steps: "未保存步骤", precondition: "", expectedResult: "结果", scenarioId: f.scenario.id } });
  await f.store.startTurn(f.product.id, conversation.id, "补充前置条件", "tools-run", context);
  const tools = createAssistantTools({ catalog: f.catalog, store: f.store, productId: f.product.id, conversationId: conversation.id, runId: "tools-run", context, isCancelled: () => false });
  assert.deepEqual(tools.map((tool) => tool.name), ["platform_context", "platform_query", "platform_get", "platform_propose_changes", "platform_propose_draft"]);
  const tool = tools.find((item) => item.name === "platform_propose_draft")!;
  await tool.execute("call", { summary: "补充前置条件", values: { precondition: "检查环境" } } as never, undefined, undefined, {} as never);
  assert.equal((await f.store.get(f.product.id, conversation.id)).proposals[0].context?.draft?.name, "未保存名称");
  assert.equal((await f.catalog.listTestCases(f.product.id))[0].precondition, "");
  await assert.rejects(tool.execute("call", { summary: "错误", values: { steps: 123 } } as never, undefined, undefined, {} as never));
  const cancelled = createAssistantTools({ catalog: f.catalog, store: f.store, productId: f.product.id, conversationId: conversation.id, runId: "tools-run", context, isCancelled: () => true });
  await assert.rejects(cancelled[4].execute("call", { summary: "取消", values: { name: "不应用" } } as never, undefined, undefined, {} as never), CatalogError);
});

test("draft patches preserve interface passwords and validate controlled form shapes", () => {
  const context = normalizeAssistantContext({ page: "resources", title: "设备", assetKind: "device", draft: { controlInterfaces: [{ id: "ssh", password: "hidden", name: "SSH" }] } });
  assert.equal(JSON.stringify(context).includes("hidden"), false);
  const draft = { name: "设备", types: ["TAU"], controlInterfaces: [{ id: "ssh", name: "SSH", type: "ssh", address: "192.0.2.1", username: "root", password: "preserved" }] };
  const next = applyDraftPatch("device", draft, { controlInterfaces: [{ id: "ssh", name: "SSH", type: "ssh", address: "192.0.2.2", username: "root" }] });
  assert.equal((next.controlInterfaces as { password: string }[])[0].password, "preserved");
  assert.throws(() => applyDraftPatch("case", {}, { steps: null }));
  assert.throws(() => applyDraftPatch("scenario", {}, { roles: [{ key: "DUT" }] }));
  assert.throws(() => applyDraftPatch("order", {}, { caseIds: [1] }));
});

test("assistant bounds conversation context without replaying old draft content", async (t) => {
  const f = await fixture(t);
  const conversation = await f.store.create(f.product.id);
  conversation.messages = Array.from({ length: 30 }, (_, index) => ({ id: String(index), runId: String(index), role: "assistant" as const, content: "x".repeat(40_000), createdAt: "2026-09-16", context: { page: "cases", title: "旧页面", assetKind: "case" as const, draft: { steps: "old-draft-marker" } } }));
  conversation.messages.push({ id: "latest", runId: "latest", role: "user", content: "latest-question-marker", createdAt: "2026-09-16" });
  const prompt = buildAssistantPrompt(conversation, { page: "resources", title: "当前场景" });
  assert.ok(prompt.length < 65_000);
  assert.ok(prompt.includes("latest-question-marker"));
  assert.ok(prompt.includes("当前场景"));
  assert.equal(prompt.includes("old-draft-marker"), false);
});

test("assistant events redact nested credentials in generic mutation arguments", () => {
  const event = sanitizeToolEvent({ tool: "platform_propose_changes", args: { changes: [{ values: { controlInterfaces: [{ username: "root", password: "private" }] } }] } });
  assert.equal(JSON.stringify(event).includes("private"), false);
  assert.ok(JSON.stringify(event).includes("[REDACTED]"));
});

test("assistant REST endpoints isolate products and enforce draft confirmation tokens", async (t) => {
  const f = await fixture(t);
  const app = express();
  app.use(express.json());
  app.use("/api", createAssistantRouter({ catalog: f.catalog, store: f.store, startTurn: async () => { throw new Error("Not needed in this test"); } }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(error instanceof CatalogError ? error.status : 500).json({ error: error instanceof Error ? error.message : "error" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api/products/${f.product.id}/assistant/conversations`;
  assert.equal((await fetch(base.replace(f.product.id, "missing"))).status, 404);
  const response = await fetch(base, { method: "POST" });
  assert.equal(response.status, 201);
  const conversation = await response.json() as { id: string };
  assert.equal((await fetch(`${base.replace(f.product.id, f.other.id)}/${conversation.id}`)).status, 404);
  await f.store.startTurn(f.product.id, conversation.id, "修改草稿", "draft-run", { page: "cases", title: "用例" });
  const proposal = await f.store.propose(f.product.id, conversation.id, { runId: "draft-run", target: "draft", summary: "草稿", context: { page: "cases", title: "用例", draftToken: "expected-token" }, values: { name: "新名称" } });
  await f.store.finishTurn(f.product.id, conversation.id, "draft-run", "请确认");
  const decide = (draftToken: string) => fetch(`${base}/${conversation.id}/proposals/${proposal.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "apply", draftToken }) });
  assert.equal((await decide("stale-token")).status, 409);
  assert.equal((await decide("expected-token")).status, 200);
  assert.equal((await decide("expected-token")).status, 409);
});
