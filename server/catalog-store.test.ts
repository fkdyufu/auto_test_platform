import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  for (const product of products) {
    const scenarios = await store.listTestScenarios(product.id);
    assert.equal(scenarios.length, 1);
    assert.equal(scenarios[0].name, "默认场景");
    assert.equal(scenarios[0].isDefault, true);
  }
});

test("creates product cases and a test order collection", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const testCase = await store.createTestCase(product.id, {
    name: "检查版本",
    steps: "访问设备并查看版本",
    expectedResult: "版本信息可见",
  });
  const order = await store.createTestOrder(product.id, {
    name: "冒烟测试",
    description: "",
    targetUrl: "旧字段应被忽略",
    username: "旧字段应被忽略",
    password: "旧字段应被忽略",
    caseIds: [testCase.id],
  });
  const detail = await store.getTestOrderDetail(product.id, order.id);

  assert.equal("targetUrl" in detail, false);
  assert.equal("username" in detail, false);
  assert.equal("password" in detail, false);
  assert.equal("scenarioId" in detail, false);
  assert.equal("roleBindings" in detail, false);
  assert.equal(detail.cases[0].id, testCase.id);
});

test("migrates legacy test order fields without losing the collection", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-catalog-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "catalog.json");
  const store = new CatalogStore(filePath);
  const [product] = await store.listProducts();
  const device = await store.createDeviceResource(product.id, {
    name: "旧版设备",
    type: "TAU",
    controlInterfaces: [],
  });
  const physicalEnvironment = await store.createPhysicalEnvironment(product.id, {
    name: "旧版物理环境",
    deviceIds: [device.id],
    connections: [],
  });
  const testCase = await store.createTestCase(product.id, {
    name: "旧版用例",
    steps: "执行检查",
    expectedResult: "检查通过",
  });
  const order = await store.createTestOrder(product.id, {
    name: "旧版测试单",
    physicalEnvironmentId: physicalEnvironment.id,
    caseIds: [testCase.id],
  });
  const data = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    physicalEnvironments?: Array<Record<string, unknown>>;
    labEnvironments?: Array<Record<string, unknown>>;
    testOrders: Array<Record<string, unknown>>;
  };
  data.version = 4;
  data.labEnvironments = data.physicalEnvironments;
  delete data.physicalEnvironments;
  data.testOrders[0].environmentId = data.testOrders[0].physicalEnvironmentId;
  delete data.testOrders[0].physicalEnvironmentId;
  Object.assign(data.testOrders[0], {
    targetUrl: "http://192.168.1.1",
    username: "root",
    password: "secret",
    scenarioId: "legacy-scenario",
    roleBindings: { dut: "legacy-device" },
  });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);

  const detail = await new CatalogStore(filePath).getTestOrderDetail(product.id, order.id);
  assert.equal(detail.name, "旧版测试单");
  assert.deepEqual(detail.caseIds, [testCase.id]);
  assert.equal(detail.physicalEnvironmentName, "旧版物理环境");
  assert.equal("targetUrl" in detail, false);
  assert.equal("password" in detail, false);
  assert.equal("scenarioId" in detail, false);
  assert.equal("roleBindings" in detail, false);
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
    store.createTestOrder(firstProduct.id, {
      name: "错误测试单",
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
  const order = await store.createTestOrder(product.id, {
    name: "回归测试",
    caseIds: [testCase.id],
  });
  const run = await store.createTestRun("run-1", order.id);

  await store.updateTestCase(product.id, testCase.id, {
    name: "修改后的名称",
    steps: "修改后的步骤",
    expectedResult: "修改后的预期",
  });

  assert.equal(run.caseRuns[0].caseNameSnapshot, "原始名称");
  assert.equal(run.caseRuns[0].stepsSnapshot, "原始步骤");
  assert.equal(run.caseRuns[0].expectedResultSnapshot, "原始预期");
});

test("creates structured resources, a physical environment, and an independent scenario", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const master = await store.createDeviceResource(product.id, {
    name: "TAU-01",
    type: "TAU",
    model: "WKCJ-II",
    controlInterfaces: [{ name: "Web 管理", type: "web", address: "http://192.168.1.10", username: "root", password: "secret" }],
  });
  const backup = await store.createDeviceResource(product.id, {
    name: "TAU-02",
    type: "TAU",
    controlInterfaces: [{ name: "Telnet 管理", type: "telnet", address: "192.168.1.11:23", username: "", password: "" }],
  });
  const physicalEnvironment = await store.createPhysicalEnvironment(product.id, {
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
  const scenario = await store.createTestScenario(product.id, {
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
    scenarioId: scenario.id,
    name: "主设备断电切换",
    steps: "关闭主设备并持续检测虚拟 IP",
    expectedResult: "备设备接管虚拟 IP",
  });
  const order = await store.createTestOrder(product.id, {
    name: "VRRP 回归",
    physicalEnvironmentId: physicalEnvironment.id,
    caseIds: [testCase.id],
  });

  const detail = await store.getTestOrderDetail(product.id, order.id);
  const context = await store.getTestOrderExecutionContext(order.id);
  assert.equal(detail.physicalEnvironmentName, "双机网络实验室");
  assert.equal(context.devices.length, 2);
  assert.ok((await store.listTestScenarios(product.id)).some((item) => item.id === scenario.id));
  assert.equal(context.scenarios.find((item) => item.id === scenario.id)?.name, "VRRP 双机主备");
  assert.equal(master.controlInterfaces[0].hasPassword, true);
  assert.equal("password" in master.controlInterfaces[0], false);
  assert.equal(context.devices.find((item) => item.id === master.id)?.controlInterfaces[0].password, "secret");

  await store.updateDeviceResource(product.id, master.id, {
    name: master.name,
    type: master.type,
    model: master.model,
    description: master.description,
    controlInterfaces: [{ ...master.controlInterfaces[0], password: "" }],
  });
  const contextAfterUpdate = await store.getTestOrderExecutionContext(order.id);
  assert.equal(contextAfterUpdate.devices.find((item) => item.id === master.id)?.controlInterfaces[0].password, "secret");

  await assert.rejects(
    store.archiveDeviceResource(product.id, master.id),
    (error: unknown) => error instanceof CatalogError && error.message.includes("物理环境"),
  );
  await assert.rejects(
    store.archivePhysicalEnvironment(product.id, physicalEnvironment.id),
    (error: unknown) => error instanceof CatalogError && error.message.includes("测试单"),
  );
});

test("rejects relay as a control interface type", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  await assert.rejects(
    store.createDeviceResource(product.id, {
      name: "错误接口设备",
      type: "TAU",
      controlInterfaces: [{ name: "继电器", type: "relay", address: "relay-01:1" }],
    }),
    (error: unknown) => error instanceof CatalogError && error.message === "控制接口类型不正确",
  );
});

test("does not attach scenarios or role bindings to test orders", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const device = await store.createDeviceResource(product.id, { name: "环境内设备", type: "TAU", controlInterfaces: [] });
  const physicalEnvironment = await store.createPhysicalEnvironment(product.id, {
    name: "隔离环境",
    deviceIds: [device.id],
    connections: [],
  });
  const scenario = await store.createTestScenario(product.id, {
    name: "单设备场景",
    category: "基础",
    roles: [{ key: "dut", name: "被测设备", deviceType: "TAU" }],
    setupInstructions: "检查设备状态",
    verificationInstructions: "设备在线",
  });
  const testCase = await store.createTestCase(product.id, { name: "在线检查", steps: "打开页面", expectedResult: "页面可见" });

  const order = await store.createTestOrder(product.id, {
    name: "独立场景测试单",
    physicalEnvironmentId: physicalEnvironment.id,
    scenarioId: scenario.id,
    roleBindings: { dut: device.id },
    caseIds: [testCase.id],
  });

  assert.equal("scenarioId" in order, false);
  assert.equal("roleBindings" in order, false);
  await store.archiveTestScenario(product.id, scenario.id);
});

test("isolates resources, physical environments, and orders by product", async (t) => {
  const store = await createStore(t);
  const [firstProduct, secondProduct] = await store.listProducts();
  const firstDevice = await store.createDeviceResource(firstProduct.id, {
    name: "同名设备",
    type: "TAU",
    controlInterfaces: [],
  });
  const secondDevice = await store.createDeviceResource(secondProduct.id, {
    name: "同名设备",
    type: "TAU",
    controlInterfaces: [],
  });

  assert.deepEqual((await store.listDeviceResources(firstProduct.id)).map((item) => item.id), [firstDevice.id]);
  assert.deepEqual((await store.listDeviceResources(secondProduct.id)).map((item) => item.id), [secondDevice.id]);

  await assert.rejects(
    store.createPhysicalEnvironment(firstProduct.id, {
      name: "跨产品环境",
      deviceIds: [secondDevice.id],
      connections: [],
    }),
    (error: unknown) => error instanceof CatalogError && error.message.includes("其他产品"),
  );

  const secondPhysicalEnvironment = await store.createPhysicalEnvironment(secondProduct.id, {
    name: "第二产品环境",
    deviceIds: [secondDevice.id],
    connections: [],
  });
  const testCase = await store.createTestCase(firstProduct.id, {
    name: "第一产品用例",
    steps: "打开页面",
    expectedResult: "页面可见",
  });
  await assert.rejects(
    store.createTestOrder(firstProduct.id, {
      name: "跨产品测试单",
      physicalEnvironmentId: secondPhysicalEnvironment.id,
      caseIds: [testCase.id],
    }),
    (error: unknown) => error instanceof CatalogError && error.message.includes("不属于当前产品"),
  );

  const order = await store.createTestOrder(firstProduct.id, {
    name: "第一产品测试单",
    caseIds: [testCase.id],
  });
  await assert.rejects(
    store.getTestOrderDetail(secondProduct.id, order.id),
    (error: unknown) => error instanceof CatalogError && error.status === 404,
  );
});

test("assigns cases to a validated product scenario", async (t) => {
  const store = await createStore(t);
  const [firstProduct, secondProduct] = await store.listProducts();
  const scenario = await store.createTestScenario(firstProduct.id, {
    name: "端口转发",
    category: "转发",
    roles: [{ key: "dut", name: "被测设备", deviceType: "TAU" }],
    setupInstructions: "配置转发路径",
    verificationInstructions: "确认链路连通",
  });
  const testCase = await store.createTestCase(firstProduct.id, {
    scenarioId: scenario.id,
    name: "检查吞吐率",
    steps: "启动打流并读取统计",
    expectedResult: "吞吐率符合预期",
  });

  assert.equal(testCase.scenarioId, scenario.id);
  await assert.rejects(
    store.createTestCase(secondProduct.id, {
      scenarioId: scenario.id,
      name: "跨产品场景用例",
      steps: "执行检查",
      expectedResult: "检查通过",
    }),
    (error: unknown) => error instanceof CatalogError && error.message.includes("不属于当前产品"),
  );
  await assert.rejects(
    store.archiveTestScenario(firstProduct.id, scenario.id),
    (error: unknown) => error instanceof CatalogError && error.message.includes("测试用例"),
  );
  const [defaultScenario] = await store.listTestScenarios(firstProduct.id);
  await assert.rejects(
    store.archiveTestScenario(firstProduct.id, defaultScenario.id),
    (error: unknown) => error instanceof CatalogError && error.message === "默认场景不能删除",
  );
});

test("groups a test run by each case scenario", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const firstScenario = await store.createTestScenario(product.id, {
    name: "场景 A",
    category: "路由",
    roles: [{ key: "dut", name: "被测设备", deviceType: "TAU" }],
    parameters: [{ key: "area", name: "区域", defaultValue: "0" }],
    setupInstructions: "搭建场景 A",
    verificationInstructions: "验证场景 A",
  });
  const secondScenario = await store.createTestScenario(product.id, {
    name: "场景 B",
    category: "转发",
    roles: [{ key: "dut", name: "被测设备", deviceType: "TAU" }],
    setupInstructions: "搭建场景 B",
    verificationInstructions: "验证场景 B",
  });
  const firstCase = await store.createTestCase(product.id, {
    scenarioId: firstScenario.id,
    name: "用例 A1",
    steps: "执行 A1",
    expectedResult: "A1 通过",
  });
  const secondCase = await store.createTestCase(product.id, {
    scenarioId: secondScenario.id,
    name: "用例 B1",
    steps: "执行 B1",
    expectedResult: "B1 通过",
  });
  const thirdCase = await store.createTestCase(product.id, {
    scenarioId: firstScenario.id,
    name: "用例 A2",
    steps: "执行 A2",
    expectedResult: "A2 通过",
  });
  const order = await store.createTestOrder(product.id, {
    name: "多场景回归",
    caseIds: [firstCase.id, secondCase.id, thirdCase.id],
  });
  const run = await store.createTestRun("multi-scenario-run", order.id);

  assert.deepEqual(run.scenarioRuns.map((item) => item.testScenarioId), [firstScenario.id, secondScenario.id]);
  assert.deepEqual(run.scenarioRuns.map((item) => item.caseRunIds.length), [2, 1]);
  assert.equal(run.scenarioRuns[0].parameterValues.area, "0");
  assert.ok(run.caseRuns.every((caseRun) => run.scenarioRuns.some((scenarioRun) => scenarioRun.id === caseRun.scenarioRunId)));
  assert.deepEqual(
    run.scenarioRuns[0].caseRunIds.map((id) => run.caseRuns.find((caseRun) => caseRun.id === id)?.testCaseId),
    [firstCase.id, thirdCase.id],
  );
});

test("migrates legacy cases and runs into the default scenario", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-catalog-scenario-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "catalog.json");
  const store = new CatalogStore(filePath);
  const [product] = await store.listProducts();
  const testCase = await store.createTestCase(product.id, {
    name: "旧用例",
    steps: "执行旧步骤",
    expectedResult: "旧结果通过",
  });
  const order = await store.createTestOrder(product.id, { name: "旧测试单", caseIds: [testCase.id] });
  const run = await store.createTestRun("legacy-run", order.id);
  await store.updateTestRun(run.id, (storedRun) => {
    storedRun.status = "completed";
    storedRun.outcome = "passed";
    storedRun.caseRuns[0].status = "completed";
    storedRun.caseRuns[0].outcome = "passed";
    storedRun.caseRuns[0].summary = "历史结论";
  });

  const data = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    testCases: Array<Record<string, unknown>>;
    testScenarios: Array<Record<string, unknown>>;
    testRuns: Array<Record<string, unknown> & { caseRuns: Array<Record<string, unknown>> }>;
  };
  data.version = 6;
  data.testScenarios = [];
  delete data.testCases[0].scenarioId;
  delete data.testRuns[0].scenarioRuns;
  delete data.testRuns[0].caseRuns[0].scenarioRunId;
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);

  const migratedStore = new CatalogStore(filePath);
  const detail = await migratedStore.getTestOrderDetail(product.id, order.id);
  const [defaultScenario] = await migratedStore.listTestScenarios(product.id);
  assert.equal(defaultScenario.isDefault, true);
  assert.equal(detail.cases[0].scenarioId, defaultScenario.id);
  assert.equal(detail.runs[0].scenarioRuns.length, 1);
  assert.equal(detail.runs[0].scenarioRuns[0].testScenarioId, defaultScenario.id);
  assert.equal(detail.runs[0].caseRuns[0].scenarioRunId, detail.runs[0].scenarioRuns[0].id);
  assert.equal(detail.runs[0].caseRuns[0].summary, "历史结论");
});
