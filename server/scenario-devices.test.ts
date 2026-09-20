import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceResource, ScenarioRun, TestScenario } from "./catalog-store.js";
import { DeviceToolDriver } from "./device-tools.js";
import { resolveScenarioDevices } from "./scenario-devices.js";
import { createToolEvidence } from "./tool-evidence.js";

const devices: DeviceResource[] = ["dut", "src", "unused"].map((id) => ({
  id, productId: "product", name: id, types: ["TAU"], model: "", description: "",
  controlInterfaces: [{ id: `${id}-ssh`, name: "SSH", type: "ssh", address: "192.0.2.1", username: "root", password: "" }],
  createdAt: "", updatedAt: "",
}));
const scenario: TestScenario = {
  id: "scene", productId: "product", isDefault: false, name: "场景", category: "基础", description: "",
  roles: [{ id: "r1", key: "DUT", deviceId: "dut" }, { id: "r2", key: "src", deviceId: "src" }],
  parameters: [], setupInstructions: "配置", verificationInstructions: "检查", cleanupInstructions: "", createdAt: "", updatedAt: "",
};
const run: ScenarioRun = {
  id: "scene-run", testScenarioId: "scene", scenarioNameSnapshot: "场景", isDefault: false, status: "queued",
  roleBindings: { DUT: "dut", src: "src" }, parameterValues: {}, caseRunIds: [],
};

test("exposes only the fixed scene devices to device tools", () => {
  const boundDevices = resolveScenarioDevices(scenario, run, devices);
  assert.deepEqual(boundDevices.map((device) => device.id), ["dut", "src"]);
  const driver = new DeviceToolDriver(boundDevices, createToolEvidence());
  assert.equal(driver.resolve("dut", "dut-ssh", "ssh").device.id, "dut");
  assert.throws(() => driver.resolve("unused", "unused-ssh", "ssh"), /不在当前 Agent 可用范围/);
});

test("rejects missing, rebound, duplicate, and foreign scene devices before execution", () => {
  assert.throws(() => resolveScenarioDevices(scenario, { ...run, roleBindings: {} }, devices), /未绑定设备/);
  assert.throws(() => resolveScenarioDevices(scenario, { ...run, roleBindings: { DUT: "unused", src: "src" } }, devices), /执行快照不一致/);
  assert.throws(() => resolveScenarioDevices(scenario, run, devices.filter((device) => device.id !== "src")), /不存在/);
  assert.throws(() => resolveScenarioDevices(scenario, run, devices.map((device) => ({ ...device, productId: "other-product" }))), /不属于当前产品/);
  assert.throws(() => resolveScenarioDevices(scenario, run, devices.map((device) => ({ ...device, archivedAt: "now" }))), /不存在/);
  const duplicate = { ...scenario, roles: [scenario.roles[0], { id: "r2", key: "src", deviceId: "dut" }] };
  assert.throws(() => resolveScenarioDevices(duplicate, { ...run, roleBindings: { DUT: "dut", src: "dut" } }, devices), /重复绑定设备/);
  assert.deepEqual(resolveScenarioDevices({ ...scenario, isDefault: true, roles: [] }, { ...run, roleBindings: {} }, devices), []);
});
