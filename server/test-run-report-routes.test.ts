import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import JSZip from "jszip";
import { CatalogError, CatalogStore } from "./catalog-store.js";
import { createTestRunReportRouter } from "./test-run-report-routes.js";
import { DOCX_CONTENT_TYPE } from "./test-run-docx.js";

test("report download is scoped to product, requires a terminal run and uses saved case snapshots", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CatalogStore(path.join(directory, "catalog.json"));
  const [product, otherProduct] = await store.listProducts();
  const testCase = await store.createTestCase(product.id, {
    name: "执行时名称", precondition: "执行时前置条件", stepRows: [{ step: "原步骤", expected: "原预期" }],
  });
  const order = await store.createTestOrder(product.id, { name: "报告下载验证", caseIds: [testCase.id] });
  await store.createTestRun("report-run", order.id);
  const app = express();
  app.use("/api", createTestRunReportRouter(store));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof CatalogError ? error.status : 500).json({ error: error instanceof Error ? error.message : "error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = (productId: string, runId = "report-run") => `http://127.0.0.1:${address.port}/api/products/${productId}/test-runs/${runId}/report.docx`;
  assert.equal((await fetch(endpoint(otherProduct.id))).status, 404);
  assert.equal((await fetch(endpoint(product.id, "not-found"))).status, 404);
  const pending = await fetch(endpoint(product.id));
  assert.equal(pending.status, 409);
  assert.match((await pending.json()).error, /执行结束后/);
  await store.updateTestCase(product.id, testCase.id, { name: "编辑后名称", stepRows: [{ step: "编辑后步骤", expected: "编辑后预期" }] });
  for (const status of ["completed", "failed", "cancelled"] as const) {
    await store.updateTestRun("report-run", (run) => {
      run.status = status;
      run.caseRuns[0].status = status;
      run.caseRuns[0].summary = "执行已结束\n可导出";
    });
    const response = await fetch(endpoint(product.id));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), DOCX_CONTENT_TYPE);
    const disposition = response.headers.get("content-disposition")!;
    assert.match(disposition, /^attachment;.*filename\*=UTF-8''/);
    assert.match(decodeURIComponent(disposition.split("UTF-8''")[1]), /报告下载验证.*\.docx$/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const xml = await zip.file("word/document.xml")!.async("string");
    assert.match(xml, /执行时名称/);
    assert.match(xml, /执行时前置条件/);
    assert.match(xml, /原步骤/);
    assert.doesNotMatch(xml, /编辑后名称|编辑后步骤/);
  }
});
