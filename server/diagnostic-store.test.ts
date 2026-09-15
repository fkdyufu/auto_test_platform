import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogError } from "./catalog-store.js";
import { DiagnosticStore } from "./diagnostic-store.js";

async function createStore(t: test.TestContext): Promise<DiagnosticStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new DiagnosticStore(path.join(directory, "diagnostics.json"));
}

test("persists a multi-turn diagnostic conversation", async (t) => {
  const store = await createStore(t);
  const conversation = await store.create("product-1", "run-1", "case-run-1", "用例一");
  await store.startTurn("product-1", conversation.id, "为什么失败？", "diagnostic-run-1");
  const completed = await store.finishTurn(
    "product-1",
    conversation.id,
    "diagnostic-run-1",
    "设备返回值与预期不一致。",
  );

  assert.equal(completed.status, "idle");
  assert.deepEqual(completed.messages.map((item) => [item.role, item.content]), [
    ["user", "为什么失败？"],
    ["assistant", "设备返回值与预期不一致。"],
  ]);
  assert.equal((await store.list("product-1", "run-1", "case-run-1"))[0].id, conversation.id);
  await assert.rejects(store.get("product-2", conversation.id), (error: unknown) => {
    return error instanceof CatalogError && error.status === 404;
  });
});

test("rejects overlapping turns and recovers interrupted conversations", async (t) => {
  const store = await createStore(t);
  const conversation = await store.create("product-1", "run-1", "case-run-1", "用例一");
  await store.startTurn("product-1", conversation.id, "继续检查", "diagnostic-run-1");

  await assert.rejects(
    store.startTurn("product-1", conversation.id, "重复问题", "diagnostic-run-2"),
    (error: unknown) => error instanceof CatalogError && error.status === 409,
  );
  assert.equal(await store.failInterruptedConversations("服务重启，诊断已中断"), 1);
  const recovered = await store.get("product-1", conversation.id);
  assert.equal(recovered.status, "idle");
  assert.equal(recovered.messages.at(-1)?.error, true);
  assert.equal(recovered.messages.at(-1)?.content, "服务重启，诊断已中断");
});

test("atomically reuses the conversation for the same case execution", async (t) => {
  const store = await createStore(t);
  const conversations = await Promise.all([
    store.getOrCreate("product-1", "run-1", "case-run-1", "用例一"),
    store.getOrCreate("product-1", "run-1", "case-run-1", "用例一"),
  ]);

  assert.equal(conversations[0].id, conversations[1].id);
  assert.equal((await store.list("product-1", "run-1", "case-run-1")).length, 1);
});
