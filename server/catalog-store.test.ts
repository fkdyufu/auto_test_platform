import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogError, CatalogStore } from "./catalog-store.js";

async function createStore(t: test.TestContext): Promise<CatalogStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new CatalogStore(path.join(directory, "catalog.json"));
}

test("initializes the two default products", async (t) => {
  const store = await createStore(t);
  const products = await store.listProducts();

  assert.deepEqual(products.map((product) => product.name), ["WKCJ-I", "WKCJ-II"]);
  assert.ok(products.every((product) => product.caseCount === 0));
});

test("creates product cases and a normalized test order", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const testCase = await store.createTestCase(product.id, {
    name: "检查版本",
    steps: "访问 {{baseUrl}} 并查看版本",
    expectedResult: "版本信息可见",
  });
  const order = await store.createTestOrder({
    productId: product.id,
    name: "冒烟测试",
    description: "",
    targetUrl: "192.168.1.1",
    username: "root",
    password: "secret",
    caseIds: [testCase.id],
  });
  const detail = await store.getTestOrderDetail(order.id);

  assert.equal(detail.targetUrl, "http://192.168.1.1");
  assert.equal(detail.hasPassword, true);
  assert.equal("password" in detail, false);
  assert.equal(detail.cases[0].id, testCase.id);
});

test("rejects cases from another product", async (t) => {
  const store = await createStore(t);
  const [firstProduct, secondProduct] = await store.listProducts();
  const foreignCase = await store.createTestCase(secondProduct.id, {
    name: "其他产品用例",
    steps: "打开页面",
    expectedResult: "页面可见",
  });

  await assert.rejects(
    store.createTestOrder({
      productId: firstProduct.id,
      name: "错误测试单",
      targetUrl: "http://127.0.0.1",
      caseIds: [foreignCase.id],
    }),
    (error: unknown) => error instanceof CatalogError && error.message === "测试单包含不属于该产品的用例",
  );
});

test("keeps case snapshots stable after the source case changes", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const testCase = await store.createTestCase(product.id, {
    name: "原始名称",
    steps: "原始步骤",
    expectedResult: "原始预期",
  });
  const order = await store.createTestOrder({
    productId: product.id,
    name: "回归测试",
    targetUrl: "http://127.0.0.1",
    caseIds: [testCase.id],
  });
  const run = await store.createTestRun("run-1", order.id);

  await store.updateTestCase(testCase.id, {
    name: "修改后的名称",
    steps: "修改后的步骤",
    expectedResult: "修改后的预期",
  });

  assert.equal(run.caseRuns[0].caseNameSnapshot, "原始名称");
  assert.equal(run.caseRuns[0].stepsSnapshot, "原始步骤");
  assert.equal(run.caseRuns[0].expectedResultSnapshot, "原始预期");
});
