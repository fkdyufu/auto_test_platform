import assert from "node:assert/strict";
import test from "node:test";
import { normalizeZentaoText, ZentaoClient } from "./zentao-client.js";

const settings = {
  baseUrl: "https://zentao.example.com",
  account: "tester",
  password: "secret",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("normalizes the HTML returned in Zentao case fields", () => {
  assert.equal(
    normalizeZentaoText("<p>配置&nbsp;接口</p><p>检查 &lt;状态&gt;<br>完成</p>"),
    "配置 接口\n检查 <状态>\n完成",
  );
});

test("loads product cases, test tasks, task cases and case details", async () => {
  let tokenRequests = 0;
  const fetchImplementation = (async (input: URL | RequestInfo) => {
    const url = new URL(input instanceof URL ? input : input.toString());
    if (url.pathname.endsWith("/tokens")) {
      tokenRequests += 1;
      return jsonResponse({ token: "runtime-token" }, 201);
    }
    if (url.pathname.endsWith("/products/8/testcases")) {
      return jsonResponse({
        total: 2,
        testcases: [
          { id: "scene_1", isScene: true, title: "场景" },
          { id: "case_28", caseID: 28, isScene: false, title: "检查&lt;状态&gt;", status: "normal" },
        ],
      });
    }
    if (url.pathname.endsWith("/testtasks") && url.searchParams.has("product")) {
      return jsonResponse({ total: 1, testtasks: [{ id: 16, name: "回归测试", status: "doing", begin: "2026-01-01", end: "2026-01-02" }] });
    }
    if (url.pathname.endsWith("/testtasks/16")) {
      return jsonResponse({ product: 8, testcases: [{ id: 229, case: 28, product: 8, title: "检查状态", caseStatus: "normal" }] });
    }
    if (url.pathname.endsWith("/testcases/28")) {
      return jsonResponse({
        id: 28,
        caseID: 28,
        product: 8,
        title: "接口检查",
        precondition: "<p>设备已启动</p>",
        steps: [
          { desc: "<p>打开页面</p>", expect: "页面正常" },
          { desc: "查看状态", expect: "<strong>状态正常</strong>" },
        ],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const client = new ZentaoClient(settings, fetchImplementation);

  assert.deepEqual(await client.listProductCases(8), [
    { id: 28, title: "检查<状态>", status: "normal", moduleId: undefined },
  ]);
  assert.deepEqual(await client.listTestTasks(8), [
    { id: 16, name: "回归测试", status: "doing", begin: "2026-01-01", end: "2026-01-02" },
  ]);
  assert.deepEqual(await client.listTestTaskCases(16, 8), [
    { id: 28, title: "检查状态", status: "normal", moduleId: undefined },
  ]);
  assert.deepEqual(await client.getCaseImportData(28, 8), {
    zentaoCaseId: 28,
    name: "接口检查",
    steps: "前置条件：设备已启动\n1. 打开页面\n2. 查看状态",
    expectedResult: "1. 页面正常\n2. 状态正常",
  });
  assert.equal(tokenRequests, 1);
});

test("refreshes the token once after an authentication failure", async () => {
  let tokenRequests = 0;
  let productRequests = 0;
  const fetchImplementation = (async (input: URL | RequestInfo) => {
    const url = new URL(input instanceof URL ? input : input.toString());
    if (url.pathname.endsWith("/tokens")) {
      tokenRequests += 1;
      return jsonResponse({ token: `token-${tokenRequests}` }, 201);
    }
    if (url.pathname.endsWith("/products")) {
      productRequests += 1;
      return productRequests === 1 ? jsonResponse({ error: "expired" }, 401) : jsonResponse({ products: [] });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  await new ZentaoClient(settings, fetchImplementation).testConnection();
  assert.equal(tokenRequests, 2);
  assert.equal(productRequests, 2);
});

test("rejects cases and test tasks from another product", async () => {
  const fetchImplementation = (async (input: URL | RequestInfo) => {
    const url = new URL(input instanceof URL ? input : input.toString());
    if (url.pathname.endsWith("/tokens")) return jsonResponse({ token: "runtime-token" }, 201);
    if (url.pathname.endsWith("/testtasks/16")) return jsonResponse({ product: 9, testcases: [] });
    if (url.pathname.endsWith("/testcases/28")) return jsonResponse({ id: 28, product: 9, title: "其他产品用例", steps: [] });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const client = new ZentaoClient(settings, fetchImplementation);

  await assert.rejects(client.listTestTaskCases(16, 8), /不属于当前产品/);
  await assert.rejects(client.getCaseImportData(28, 8), /不属于当前产品/);
});
