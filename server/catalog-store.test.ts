import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    types: ["TAU"],
    controlInterfaces: [],
  });
  const physicalEnvironment = {
    id: "legacy-environment",
    productId: product.id,
    name: "旧版物理环境",
    deviceIds: [device.id],
    connections: [],
  };
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
  data.labEnvironments = [physicalEnvironment];
  delete data.physicalEnvironments;
  data.testOrders[0].environmentId = physicalEnvironment.id;
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
  assert.equal("physicalEnvironmentId" in detail, false);
  const [defaultScenario] = await new CatalogStore(filePath).listTestScenarios(product.id);
  assert.match(defaultScenario.description, /原物理环境：旧版物理环境/);
  assert.equal("targetUrl" in detail, false);
  assert.equal("password" in detail, false);
  assert.equal("scenarioId" in detail, false);
  assert.equal("roleBindings" in detail, false);
});

test("migrates a legacy slash-separated device type into multiple types", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-catalog-device-types-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "catalog.json");
  const store = new CatalogStore(filePath);
  const [product] = await store.listProducts();
  const device = await store.createDeviceResource(product.id, {
    name: "多角色终端",
    types: ["peer", "host"],
    controlInterfaces: [],
  });
  const data = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    deviceResources: Array<Record<string, unknown>>;
  };
  const storedDevice = data.deviceResources.find((item) => item.id === device.id);
  assert.ok(storedDevice);
  data.version = 8;
  storedDevice.type = "peer/host";
  delete storedDevice.types;
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);

  const [migratedDevice] = await new CatalogStore(filePath).listDeviceResources(product.id);

  assert.deepEqual(migratedDevice.types, ["peer", "host"]);
  assert.equal("type" in migratedDevice, false);
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
    precondition: "原始前置条件",
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
    precondition: "修改后的前置条件",
    steps: "修改后的步骤",
    expectedResult: "修改后的预期",
  });

  assert.equal(run.caseRuns[0].caseNameSnapshot, "原始名称");
  assert.equal(run.caseRuns[0].preconditionSnapshot, "原始前置条件");
  assert.equal(run.caseRuns[0].stepsSnapshot, "原始步骤");
  assert.equal(run.caseRuns[0].expectedResultSnapshot, "原始预期");
});

test("marks active test runs as failed after a service restart", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const testCase = await store.createTestCase(product.id, {
    name: "重启恢复用例",
    steps: "执行一个长时间任务",
    expectedResult: "任务完成",
  });
  const order = await store.createTestOrder(product.id, {
    name: "重启恢复测试单",
    caseIds: [testCase.id],
  });
  const run = await store.createTestRun("interrupted-run", order.id);
  await store.updateTestRun(run.id, (storedRun) => {
    storedRun.status = "running";
    storedRun.scenarioRuns[0].status = "running";
    storedRun.caseRuns[0].status = "running";
  });

  const recoveredIds = await store.failInterruptedTestRuns("平台服务重启");
  const detail = await store.getTestOrderDetail(product.id, order.id);
  const recoveredRun = detail.runs.find((item) => item.id === run.id);

  assert.deepEqual(recoveredIds, [run.id]);
  assert.equal(recoveredRun?.status, "failed");
  assert.equal(recoveredRun?.outcome, "failed");
  assert.equal(recoveredRun?.scenarioRuns[0].status, "failed");
  assert.match(recoveredRun?.scenarioRuns[0].summary || "", /执行中断：平台服务重启/);
  assert.equal(recoveredRun?.caseRuns[0].status, "failed");
  assert.equal(recoveredRun?.caseRuns[0].summary, "执行中断：平台服务重启");
});

test("resolves diagnostic context without crossing product boundaries", async (t) => {
  const store = await createStore(t);
  const [product, otherProduct] = await store.listProducts();
  const testCase = await store.createTestCase(product.id, {
    name: "待诊断用例",
    steps: "检查设备状态",
    expectedResult: "设备正常",
  });
  const order = await store.createTestOrder(product.id, {
    name: "诊断测试单",
    caseIds: [testCase.id],
  });
  const run = await store.createTestRun("diagnostic-source-run", order.id);

  const context = await store.getDiagnosticExecutionContext(product.id, run.id, run.caseRuns[0].id);
  assert.equal(context.product.id, product.id);
  assert.equal(context.testOrder.id, order.id);
  assert.equal(context.caseRun.caseNameSnapshot, "待诊断用例");
  assert.equal(context.scenarioRun.id, run.caseRuns[0].scenarioRunId);
  await assert.rejects(
    store.getDiagnosticExecutionContext(otherProduct.id, run.id, run.caseRuns[0].id),
    (error: unknown) => error instanceof CatalogError && error.status === 404,
  );
});

test("creates structured resources and a scenario with fixed device bindings", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const master = await store.createDeviceResource(product.id, {
    name: "TAU-01",
    types: ["TAU"],
    model: "WKCJ-II",
    controlInterfaces: [{ name: "Web 管理", type: "web", address: "http://192.168.1.10", username: "root", password: "secret" }],
  });
  const backup = await store.createDeviceResource(product.id, {
    name: "TAU-02",
    types: ["TAU"],
    controlInterfaces: [{ name: "Telnet 管理", type: "telnet", address: "192.168.1.11:23", username: "", password: "" }],
  });
  const scenario = await store.createTestScenario(product.id, {
    name: "VRRP 双机主备",
    category: "VRRP",
    roles: [
      { key: "master", deviceId: master.id },
      { key: "backup", deviceId: backup.id },
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
    caseIds: [testCase.id],
  });

  const detail = await store.getTestOrderDetail(product.id, order.id);
  const context = await store.getTestOrderExecutionContext(order.id);
  assert.equal("physicalEnvironmentId" in detail, false);
  assert.equal(context.devices.length, 2);
  assert.ok((await store.listTestScenarios(product.id)).some((item) => item.id === scenario.id));
  assert.equal(context.scenarios.find((item) => item.id === scenario.id)?.name, "VRRP 双机主备");
  assert.equal(master.controlInterfaces[0].hasPassword, true);
  assert.equal("password" in master.controlInterfaces[0], false);
  assert.equal(context.devices.find((item) => item.id === master.id)?.controlInterfaces[0].password, "secret");

  await store.updateDeviceResource(product.id, master.id, {
    name: master.name,
    types: master.types,
    model: master.model,
    description: master.description,
    controlInterfaces: [{ ...master.controlInterfaces[0], password: "" }],
  });
  const contextAfterUpdate = await store.getTestOrderExecutionContext(order.id);
  assert.equal(contextAfterUpdate.devices.find((item) => item.id === master.id)?.controlInterfaces[0].password, "secret");

  await assert.rejects(
    store.archiveDeviceResource(product.id, master.id),
    (error: unknown) => error instanceof CatalogError && error.message.includes("测试场景"),
  );
});

test("rejects relay as a control interface type", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  await assert.rejects(
    store.createDeviceResource(product.id, {
      name: "错误接口设备",
      types: ["TAU"],
      controlInterfaces: [{ name: "继电器", type: "relay", address: "relay-01:1" }],
    }),
    (error: unknown) => error instanceof CatalogError && error.message === "控制接口类型不正确",
  );
});

test("does not attach scenarios or role bindings to test orders", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const device = await store.createDeviceResource(product.id, { name: "环境内设备", types: ["TAU"], controlInterfaces: [] });
  const scenario = await store.createTestScenario(product.id, {
    name: "单设备场景",
    category: "基础",
    roles: [{ key: "dut", deviceId: device.id }],
    setupInstructions: "检查设备状态",
    verificationInstructions: "设备在线",
  });
  const testCase = await store.createTestCase(product.id, { name: "在线检查", steps: "打开页面", expectedResult: "页面可见" });

  const order = await store.createTestOrder(product.id, {
    name: "独立场景测试单",
    physicalEnvironmentId: "旧字段应被忽略",
    scenarioId: scenario.id,
    roleBindings: { dut: device.id },
    caseIds: [testCase.id],
  });

  assert.equal("scenarioId" in order, false);
  assert.equal("roleBindings" in order, false);
  assert.equal("physicalEnvironmentId" in order, false);
  await store.archiveTestScenario(product.id, scenario.id);
});

test("isolates resources, scenario bindings, and orders by product", async (t) => {
  const store = await createStore(t);
  const [firstProduct, secondProduct] = await store.listProducts();
  const firstDevice = await store.createDeviceResource(firstProduct.id, {
    name: "同名设备",
    types: ["TAU"],
    controlInterfaces: [],
  });
  const secondDevice = await store.createDeviceResource(secondProduct.id, {
    name: "同名设备",
    types: ["TAU"],
    controlInterfaces: [],
  });

  assert.deepEqual((await store.listDeviceResources(firstProduct.id)).map((item) => item.id), [firstDevice.id]);
  assert.deepEqual((await store.listDeviceResources(secondProduct.id)).map((item) => item.id), [secondDevice.id]);

  await assert.rejects(
    store.createTestScenario(firstProduct.id, {
      name: "跨产品场景",
      category: "基础",
      roles: [{ key: "dut", deviceId: secondDevice.id }],
      setupInstructions: "检查设备",
      verificationInstructions: "设备在线",
    }),
    (error: unknown) => error instanceof CatalogError && error.message.includes("不属于当前产品"),
  );

  const testCase = await store.createTestCase(firstProduct.id, {
    name: "第一产品用例",
    steps: "打开页面",
    expectedResult: "页面可见",
  });
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
  const device = await store.createDeviceResource(firstProduct.id, { name: "TAU", types: ["TAU"], controlInterfaces: [] });
  const scenario = await store.createTestScenario(firstProduct.id, {
    name: "端口转发",
    category: "转发",
    roles: [{ key: "dut", deviceId: device.id }],
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

test("updates a scenario and its case assignments atomically", async (t) => {
  const store = await createStore(t);
  const [product, otherProduct] = await store.listProducts();
  const device = await store.createDeviceResource(product.id, { name: "TAU", types: ["TAU"], controlInterfaces: [] });
  const firstScenario = await store.createTestScenario(product.id, {
    name: "端口镜像",
    category: "交换",
    roles: [{ key: "dut", deviceId: device.id }],
    setupInstructions: "配置端口镜像",
    verificationInstructions: "确认镜像报文",
  });
  const secondScenario = await store.createTestScenario(product.id, {
    name: "端口转发",
    category: "转发",
    roles: [{ key: "dut", deviceId: device.id }],
    setupInstructions: "配置端口转发",
    verificationInstructions: "确认报文转发",
  });
  const originalCase = await store.createTestCase(product.id, {
    scenarioId: firstScenario.id,
    name: "原镜像用例",
    steps: "发送流量",
    expectedResult: "收到镜像流量",
  });
  const movedCase = await store.createTestCase(product.id, {
    scenarioId: secondScenario.id,
    name: "待移动用例",
    steps: "发送流量",
    expectedResult: "流量正常",
  });
  const defaultCase = await store.createTestCase(product.id, {
    name: "默认场景用例",
    steps: "读取状态",
    expectedResult: "状态正常",
  });
  const foreignCase = await store.createTestCase(otherProduct.id, {
    name: "其他产品用例",
    steps: "读取状态",
    expectedResult: "状态正常",
  });

  const updatedScenario = await store.updateTestScenario(product.id, firstScenario.id, {
    name: "端口镜像批量场景",
    category: firstScenario.category,
    description: firstScenario.description,
    roles: firstScenario.roles,
    parameters: firstScenario.parameters,
    setupInstructions: firstScenario.setupInstructions,
    verificationInstructions: firstScenario.verificationInstructions,
    cleanupInstructions: firstScenario.cleanupInstructions,
    caseIds: [movedCase.id, defaultCase.id],
  });
  const cases = await store.listTestCases(product.id);
  const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const defaultScenario = (await store.listTestScenarios(product.id)).find((scenario) => scenario.isDefault);

  assert.equal(updatedScenario.name, "端口镜像批量场景");
  assert.equal(caseById.get(originalCase.id)?.scenarioId, defaultScenario?.id);
  assert.equal(caseById.get(movedCase.id)?.scenarioId, firstScenario.id);
  assert.equal(caseById.get(defaultCase.id)?.scenarioId, firstScenario.id);

  await assert.rejects(
    store.updateTestScenario(product.id, firstScenario.id, {
      ...updatedScenario,
      name: "不应保存的名称",
      caseIds: [foreignCase.id],
    }),
    (error: unknown) => error instanceof CatalogError && error.message.includes("其他产品"),
  );
  const scenarioAfterFailure = (await store.listTestScenarios(product.id)).find((scenario) => scenario.id === firstScenario.id);
  assert.equal(scenarioAfterFailure?.name, "端口镜像批量场景");
});

test("imports Zentao cases without overwriting local changes by default", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const firstImport = await store.importZentaoTestCases(product.id, [{
    zentaoCaseId: 101,
    name: "禅道原始名称",
    precondition: "设备已经启动",
    steps: "1. 原始步骤",
    expectedResult: "1. 原始结果",
  }]);
  assert.deepEqual(firstImport, { created: 1, updated: 0, skipped: 0 });

  const [imported] = await store.listTestCases(product.id);
  assert.equal(imported.source, "zentao");
  assert.equal(imported.zentaoCaseId, 101);
  assert.equal(imported.precondition, "设备已经启动");
  assert.ok(imported.lastImportedAt);
  await store.updateTestCase(product.id, imported.id, {
    scenarioId: imported.scenarioId,
    name: "平台修改名称",
    precondition: "平台修改前置条件",
    steps: "平台修改步骤",
    expectedResult: "平台修改结果",
  });

  const skipped = await store.importZentaoTestCases(product.id, [{
    zentaoCaseId: 101,
    name: "禅道新名称",
    precondition: "禅道新前置条件",
    steps: "禅道新步骤",
    expectedResult: "禅道新结果",
  }]);
  assert.deepEqual(skipped, { created: 0, updated: 0, skipped: 1 });
  assert.equal((await store.listTestCases(product.id))[0].name, "平台修改名称");
  assert.equal((await store.listTestCases(product.id))[0].precondition, "平台修改前置条件");

  const overwritten = await store.importZentaoTestCases(product.id, [{
    zentaoCaseId: 101,
    name: "禅道新名称",
    precondition: "禅道新前置条件",
    steps: "禅道新步骤",
    expectedResult: "禅道新结果",
  }], true);
  const [updated] = await store.listTestCases(product.id);
  assert.deepEqual(overwritten, { created: 0, updated: 1, skipped: 0 });
  assert.equal(updated.name, "禅道新名称");
  assert.equal(updated.precondition, "禅道新前置条件");
  assert.equal(updated.scenarioId, imported.scenarioId);
});

test("keeps local and same-named Zentao cases as separate records", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const local = await store.createTestCase(product.id, {
    name: "重复名称",
    steps: "本地步骤",
    expectedResult: "本地结果",
  });
  await store.importZentaoTestCases(product.id, [{
    zentaoCaseId: 202,
    name: "重复名称",
    precondition: "",
    steps: "禅道步骤",
    expectedResult: "禅道结果",
  }]);

  const cases = await store.listTestCases(product.id);
  assert.equal(cases.length, 2);
  assert.equal(cases.find((item) => item.id === local.id)?.source, "local");
  assert.equal(cases.find((item) => item.zentaoCaseId === 202)?.source, "zentao");
});

test("groups a test run by each case scenario", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const device = await store.createDeviceResource(product.id, { name: "TAU", types: ["TAU"], controlInterfaces: [] });
  const firstScenario = await store.createTestScenario(product.id, {
    name: "场景 A",
    category: "路由",
    roles: [{ key: "dut", deviceId: device.id }],
    parameters: [{ key: "area", name: "区域", defaultValue: "0" }],
    setupInstructions: "搭建场景 A",
    verificationInstructions: "验证场景 A",
  });
  const secondScenario = await store.createTestScenario(product.id, {
    name: "场景 B",
    category: "转发",
    roles: [{ key: "dut", deviceId: device.id }],
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
  assert.deepEqual(order.caseIds, [firstCase.id, thirdCase.id, secondCase.id]);
  const run = await store.createTestRun("multi-scenario-run", order.id);

  assert.deepEqual(run.scenarioRuns.map((item) => item.testScenarioId), [firstScenario.id, secondScenario.id]);
  assert.deepEqual(run.scenarioRuns.map((item) => item.caseRunIds.length), [2, 1]);
  assert.deepEqual(run.caseRuns.map((item) => item.testCaseId), [firstCase.id, thirdCase.id, secondCase.id]);
  assert.equal(run.scenarioRuns[0].parameterValues.area, "0");
  assert.deepEqual(run.scenarioRuns[0].roleBindings, { dut: device.id });
  assert.equal(run.scenarioRuns[0].scenarioSnapshot?.roles[0].deviceId, device.id);
  assert.ok(run.caseRuns.every((caseRun) => run.scenarioRuns.some((scenarioRun) => scenarioRun.id === caseRun.scenarioRunId)));
  assert.deepEqual(
    run.scenarioRuns[0].caseRunIds.map((id) => run.caseRuns.find((caseRun) => caseRun.id === id)?.testCaseId),
    [firstCase.id, thirdCase.id],
  );

  await store.updateTestOrder(product.id, order.id, {
    name: order.name,
    description: order.description,
    caseIds: [secondCase.id, thirdCase.id, firstCase.id],
  });
  const reordered = await store.createTestRun("reordered-multi-scenario-run", order.id);
  assert.deepEqual(reordered.scenarioRuns.map((item) => item.testScenarioId), [secondScenario.id, firstScenario.id]);
  assert.deepEqual(reordered.caseRuns.map((item) => item.testCaseId), [secondCase.id, thirdCase.id, firstCase.id]);
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
  delete data.testCases[0].precondition;
  delete data.testRuns[0].scenarioRuns;
  delete data.testRuns[0].caseRuns[0].scenarioRunId;
  delete data.testRuns[0].caseRuns[0].preconditionSnapshot;
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);

  const migratedStore = new CatalogStore(filePath);
  const detail = await migratedStore.getTestOrderDetail(product.id, order.id);
  const [defaultScenario] = await migratedStore.listTestScenarios(product.id);
  assert.equal(defaultScenario.isDefault, true);
  assert.equal(detail.cases[0].scenarioId, defaultScenario.id);
  assert.equal(detail.cases[0].source, "local");
  assert.equal(detail.cases[0].precondition, "");
  assert.equal(detail.runs[0].scenarioRuns.length, 1);
  assert.equal(detail.runs[0].scenarioRuns[0].testScenarioId, defaultScenario.id);
  assert.equal(detail.runs[0].caseRuns[0].scenarioRunId, detail.runs[0].scenarioRuns[0].id);
  assert.equal(detail.runs[0].caseRuns[0].preconditionSnapshot, "");
  assert.equal(detail.runs[0].caseRuns[0].summary, "历史结论");
});

test("extracts the precondition embedded by the legacy Zentao importer", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-catalog-precondition-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "catalog.json");
  const store = new CatalogStore(filePath);
  const [product] = await store.listProducts();
  await store.importZentaoTestCases(product.id, [{
    zentaoCaseId: 303,
    name: "旧版禅道用例",
    precondition: "",
    steps: "占位步骤",
    expectedResult: "预期结果",
  }]);
  const data = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    testCases: Array<Record<string, unknown>>;
  };
  data.version = 9;
  delete data.testCases[0].precondition;
  data.testCases[0].steps = "前置条件：设备已启动\n测试网络已连接\n1. 打开页面\n2. 检查状态";
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);

  const [migrated] = await new CatalogStore(filePath).listTestCases(product.id);

  assert.equal(migrated.precondition, "设备已启动\n测试网络已连接");
  assert.equal(migrated.steps, "1. 打开页面\n2. 检查状态");
});

test("validates fixed role bindings on both scene creation and update", async (t) => {
  const store = await createStore(t);
  const [product, otherProduct] = await store.listProducts();
  const device = await store.createDeviceResource(product.id, { name: "DUT", types: ["TAU"], controlInterfaces: [] });
  const foreignDevice = await store.createDeviceResource(otherProduct.id, { name: "Other DUT", types: ["host"], controlInterfaces: [] });
  const input = {
    name: "固定场景",
    category: "基础",
    roles: [{ key: "DUT", deviceId: device.id }],
    setupInstructions: "按指定 SSH 接口初始化设备",
    verificationInstructions: "查询配置和连通性",
  };
  for (const [roles, message] of [
    [[{ key: "DUT", deviceId: "" }], /绑定设备/],
    [[{ key: "DUT", deviceId: device.id }, { key: "src", deviceId: device.id }], /重复绑定设备/],
    [[{ key: "DUT", deviceId: device.id }, { key: "dut", deviceId: foreignDevice.id }], /角色标识不能重复/],
    [[{ key: "DUT", deviceId: foreignDevice.id }], /不属于当前产品/],
    [[{ key: "DUT", deviceId: "missing-device" }], /不属于当前产品或不存在/],
  ] as const) {
    await assert.rejects(store.createTestScenario(product.id, { ...input, roles }), message);
  }
  const scenario = await store.createTestScenario(product.id, input);
  assert.equal("name" in scenario.roles[0], false);
  assert.equal("deviceType" in scenario.roles[0], false);
  await assert.rejects(store.updateTestScenario(product.id, scenario.id, {
    ...scenario,
    roles: [{ key: "DUT", deviceId: device.id }, { key: "src", deviceId: device.id }],
  }), /重复绑定设备/);
  assert.deepEqual((await store.listTestScenarios(product.id)).find((item) => item.id === scenario.id)?.roles, scenario.roles);
  await store.archiveTestScenario(product.id, scenario.id);
  await store.archiveDeviceResource(product.id, device.id);
  await assert.rejects(store.createTestScenario(product.id, input), /不属于当前产品或不存在/);
});

test("keeps scene and device bindings in execution snapshots after scene edits", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const original = await store.createDeviceResource(product.id, { name: "TAU1", types: ["TAU"], controlInterfaces: [] });
  const replacement = await store.createDeviceResource(product.id, { name: "TAU2", types: ["TAU"], controlInterfaces: [] });
  await store.createDeviceResource(product.id, { name: "Unused host", types: ["host"], controlInterfaces: [] });
  const scenario = await store.createTestScenario(product.id, {
    name: "原场景",
    category: "基础",
    roles: [{ key: "DUT", deviceId: original.id }],
    setupInstructions: "原搭建步骤",
    verificationInstructions: "原验证步骤",
  });
  const testCase = await store.createTestCase(product.id, { scenarioId: scenario.id, name: "检查", steps: "读取状态", expectedResult: "状态正常" });
  const order = await store.createTestOrder(product.id, { name: "回归", caseIds: [testCase.id] });
  const run = await store.createTestRun("snapshot-run", order.id);
  await store.updateTestScenario(product.id, scenario.id, {
    ...scenario,
    name: "新场景",
    roles: [{ key: "DUT", deviceId: replacement.id }],
    setupInstructions: "新搭建步骤",
  });
  const context = await store.getDiagnosticExecutionContext(product.id, run.id, run.caseRuns[0].id);
  assert.equal(context.scenario?.name, "原场景");
  assert.equal(context.scenario?.setupInstructions, "原搭建步骤");
  assert.deepEqual(context.scenarioRun.roleBindings, { DUT: original.id });
  assert.deepEqual(context.devices.map((device) => device.id), [original.id]);
  const nextRun = await store.createTestRun("new-snapshot-run", order.id);
  assert.deepEqual(nextRun.scenarioRuns[0].roleBindings, { DUT: replacement.id });
});

test("allows device bindings in the default scene without allowing deletion or renaming", async (t) => {
  const store = await createStore(t);
  const [product] = await store.listProducts();
  const device = await store.createDeviceResource(product.id, { name: "TAU", types: ["TAU"], controlInterfaces: [] });
  const [defaultScene] = await store.listTestScenarios(product.id);
  const updated = await store.updateTestScenario(product.id, defaultScene.id, {
    ...defaultScene,
    name: "不可修改的名称",
    roles: [{ key: "DUT", deviceId: device.id }],
  });
  assert.equal(updated.name, "默认场景");
  const testCase = await store.createTestCase(product.id, { name: "默认用例", steps: "检查", expectedResult: "通过" });
  const order = await store.createTestOrder(product.id, { name: "默认测试单", caseIds: [testCase.id] });
  const run = await store.createTestRun("default-bound-run", order.id);
  assert.deepEqual(run.scenarioRuns[0].roleBindings, { DUT: device.id });
  await assert.rejects(store.archiveTestScenario(product.id, defaultScene.id), /默认场景不能删除/);
});

test("migrates v10 environments and roles without guessing bindings or changing historical evidence", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-fixed-roles-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "catalog.json");
  const store = new CatalogStore(filePath);
  const [product] = await store.listProducts();
  const device = await store.createDeviceResource(product.id, { name: "TAU1", types: ["TAU"], controlInterfaces: [] });
  const scenario = await store.createTestScenario(product.id, {
    name: "端口镜像", category: "交换", roles: [{ key: "DUT", deviceId: device.id }],
    setupInstructions: "配置镜像", verificationInstructions: "查询规则",
  });
  const testCase = await store.createTestCase(product.id, { scenarioId: scenario.id, name: "检查镜像", steps: "抓包", expectedResult: "有镜像报文" });
  const order = await store.createTestOrder(product.id, { name: "旧测试单", caseIds: [testCase.id] });
  const run = await store.createTestRun("legacy-bound-run", order.id);
  const data = JSON.parse(await readFile(filePath, "utf8"));
  data.version = 10;
  data.physicalEnvironments = [{
    id: "old-env", productId: product.id, name: "正式", description: "固定接线",
    deviceIds: [device.id],
    connections: [{ sourceDeviceId: device.id, sourcePort: "ge1", targetDeviceId: device.id, targetPort: "ge2", description: "回环" }],
  }];
  data.testOrders[0].physicalEnvironmentId = "old-env";
  data.testScenarios.find((item: { id: string }) => item.id === scenario.id).roles = [{ id: "old-role", key: "DUT", name: "被测设备", deviceType: "TAU" }];
  delete data.testRuns[0].scenarioRuns[0].scenarioSnapshot;
  const originalData = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(filePath, originalData);
  const migratedStore = new CatalogStore(filePath);
  const migrated = (await migratedStore.listTestScenarios(product.id)).find((item) => item.id === scenario.id)!;
  assert.deepEqual(migrated.roles, [{ id: "old-role", key: "DUT", deviceId: "" }]);
  assert.match(migrated.description, /TAU1.ge1 <-> TAU1.ge2（回环）/);
  assert.equal(await readFile(`${filePath}.v10.bak`, "utf8"), originalData);
  assert.equal((await stat(`${filePath}.v10.bak`)).mode & 0o777, 0o600);
  await assert.rejects(migratedStore.createTestRun("invalid-legacy-scene", order.id), /绑定设备/);
  const diagnostic = await migratedStore.getDiagnosticExecutionContext(product.id, run.id, run.caseRuns[0].id);
  assert.deepEqual(diagnostic.scenarioRun.roleBindings, { DUT: device.id });
  assert.equal(diagnostic.scenarioRun.scenarioSnapshot, undefined);
  assert.deepEqual(diagnostic.devices.map((item) => item.id), [device.id]);
  await migratedStore.updateTestScenario(product.id, scenario.id, { ...migrated, roles: [{ ...migrated.roles[0], deviceId: device.id }] });
  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(persisted.version, 11);
  assert.equal("physicalEnvironments" in persisted, false);
  assert.equal("physicalEnvironmentId" in persisted.testOrders[0], false);
  assert.equal((await migratedStore.listTestScenarios(product.id)).find((item) => item.id === scenario.id)?.description, migrated.description);
  assert.equal(await readFile(`${filePath}.v10.bak`, "utf8"), originalData);
});
