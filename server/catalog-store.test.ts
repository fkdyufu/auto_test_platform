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

test("creates structured resources, an environment, a scenario, and role bindings", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const master = await store.createDeviceResource({
    name: "TAU-01",
    type: "TAU",
    model: "WKCJ-II",
    controlInterfaces: [{ name: "Web 管理", type: "web", address: "http://192.168.1.10", username: "root", password: "secret" }],
  });
  const backup = await store.createDeviceResource({
    name: "TAU-02",
    type: "TAU",
    controlInterfaces: [{ name: "Telnet 管理", type: "telnet", address: "192.168.1.11:23", username: "", password: "" }],
  });
  const environment = await store.createLabEnvironment({
    name: "双机网络实验室",
    description: "两台 TAU 已连接到同一交换网络",
    deviceIds: [master.id, backup.id],
    connections: [{
      sourceDeviceId: master.id,
      sourcePort: "eth1",
      targetDeviceId: backup.id,
      targetPort: "eth1",
      description: "业务链路",
    }],
  });
  const scenario = await store.createTestScenario({
    name: "VRRP 双机主备",
    category: "VRRP",
    roles: [
      { key: "master", name: "主设备", deviceType: "TAU" },
      { key: "backup", name: "备设备", deviceType: "TAU" },
    ],
    parameters: [{ key: "virtual_ip", name: "虚拟 IP", defaultValue: "192.168.100.254" }],
    setupInstructions: "配置两台设备组成 VRRP 主备",
    verificationInstructions: "确认主备状态和虚拟 IP 连通性",
    cleanupInstructions: "清除本次 VRRP 配置",
  });
  const testCase = await store.createTestCase(product.id, {
    name: "主设备断电切换",
    steps: "关闭主设备并持续检测虚拟 IP",
    expectedResult: "备设备接管虚拟 IP",
  });
  const order = await store.createTestOrder({
    productId: product.id,
    name: "VRRP 回归",
    targetUrl: "192.168.1.10",
    environmentId: environment.id,
    scenarioId: scenario.id,
    roleBindings: { master: master.id, backup: backup.id },
    caseIds: [testCase.id],
  });

  const detail = await store.getTestOrderDetail(order.id);
  const context = await store.getTestOrderExecutionContext(order.id);
  assert.equal(detail.environmentName, "双机网络实验室");
  assert.equal(detail.scenarioName, "VRRP 双机主备");
  assert.deepEqual(detail.boundDevices.map((item) => item.name).sort(), ["TAU-01", "TAU-02"]);
  assert.equal(context.devices.length, 2);
  assert.equal(context.scenario?.parameters[0].defaultValue, "192.168.100.254");
  assert.equal(master.controlInterfaces[0].hasPassword, true);
  assert.equal("password" in master.controlInterfaces[0], false);
  assert.equal(context.devices.find((item) => item.id === master.id)?.controlInterfaces[0].password, "secret");

  await store.updateDeviceResource(master.id, {
    name: master.name,
    type: master.type,
    model: master.model,
    description: master.description,
    controlInterfaces: [{ ...master.controlInterfaces[0], password: "" }],
  });
  const contextAfterUpdate = await store.getTestOrderExecutionContext(order.id);
  assert.equal(contextAfterUpdate.devices.find((item) => item.id === master.id)?.controlInterfaces[0].password, "secret");

  await assert.rejects(
    store.archiveDeviceResource(master.id),
    (error: unknown) => error instanceof CatalogError && error.message.includes("实验环境"),
  );
  await assert.rejects(
    store.archiveLabEnvironment(environment.id),
    (error: unknown) => error instanceof CatalogError && error.message.includes("测试单"),
  );
});

test("rejects relay as a control interface type", async (t) => {
  const store = await createStore(t);
  await assert.rejects(
    store.createDeviceResource({
      name: "错误接口设备",
      type: "TAU",
      controlInterfaces: [{ name: "继电器", type: "relay", address: "relay-01:1" }],
    }),
    (error: unknown) => error instanceof CatalogError && error.message === "控制接口类型不正确",
  );
});

test("rejects scenario role bindings to devices outside the selected environment", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const inside = await store.createDeviceResource({ name: "环境内设备", type: "交换机", controlInterfaces: [] });
  const outside = await store.createDeviceResource({ name: "环境外设备", type: "TAU", controlInterfaces: [] });
  const environment = await store.createLabEnvironment({ name: "隔离环境", deviceIds: [inside.id], connections: [] });
  const scenario = await store.createTestScenario({
    name: "单设备场景",
    category: "基础",
    roles: [{ key: "dut", name: "被测设备", deviceType: "TAU" }],
    setupInstructions: "检查设备状态",
    verificationInstructions: "设备在线",
  });
  const testCase = await store.createTestCase(product.id, { name: "在线检查", steps: "打开页面", expectedResult: "页面可见" });

  await assert.rejects(
    store.createTestOrder({
      productId: product.id,
      name: "无效绑定",
      targetUrl: "127.0.0.1",
      environmentId: environment.id,
      scenarioId: scenario.id,
      roleBindings: { dut: outside.id },
      caseIds: [testCase.id],
    }),
    (error: unknown) => error instanceof CatalogError && error.message.includes("不属于所选环境"),
  );

  await assert.rejects(
    store.createTestOrder({
      productId: product.id,
      name: "类型不匹配",
      targetUrl: "127.0.0.1",
      environmentId: environment.id,
      scenarioId: scenario.id,
      roleBindings: { dut: inside.id },
      caseIds: [testCase.id],
    }),
    (error: unknown) => error instanceof CatalogError && error.message.includes("需要 TAU 类型设备"),
  );
});
