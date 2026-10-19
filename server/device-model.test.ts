import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogStore } from "./catalog-store.js";
import { controlFromLegacy, controlSummary, describeControlSettings } from "../shared/control-interfaces.js";
import { templateFromLegacyTypes } from "../shared/device-templates.js";

async function createStore(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-device-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "catalog.json");
  const store = new CatalogStore(file);
  const products = await store.listProducts();
  return { store, file, product: products.find((item) => item.name === "WKCJ-II")! };
}

test("converts address-style interfaces into each method's settings", () => {
  const base = { id: "c", name: "" };
  assert.deepEqual(controlFromLegacy({ ...base, type: "ssh", address: "192.168.176.11", username: "root", password: "x" }).settings, { host: "192.168.176.11", port: "22", username: "root", password: "x" });
  assert.deepEqual(controlFromLegacy({ ...base, type: "telnet", address: "telnet://192.168.176.1:2323" }).settings, { host: "192.168.176.1", port: "2323", username: "", password: "" });
  assert.deepEqual(controlFromLegacy({ ...base, type: "serial", address: "/dev/ttyUSB0?baudRate=9600&dataBits=7&parity=even&stopBits=1" }).settings, { device: "/dev/ttyUSB0", baudRate: "9600", frame: "7E1", username: "", password: "" });
  assert.equal(controlFromLegacy({ ...base, type: "serial", address: "/dev/ttyACM0" }).settings.frame, "8N1");
  assert.deepEqual(controlFromLegacy({ ...base, type: "api", address: "http://h/api", password: "tk" }).settings, { baseUrl: "http://h/api", auth: "token", username: "", password: "", token: "tk" });
  assert.equal(controlFromLegacy({ ...base, type: "api", address: "http://h/api", username: "u", password: "p" }).settings.auth, "basic");
  assert.deepEqual(controlFromLegacy({ ...base, type: "other", address: "经跳板机登录" }).kind, "other");
});

test("maps only unambiguous legacy type labels to a type card", () => {
  assert.equal(templateFromLegacyTypes(["交换机"], "", "WKCJ-II"), "switch");
  assert.equal(templateFromLegacyTypes(["虚拟交换机"], "", "WKCJ-II"), "switch");
  assert.equal(templateFromLegacyTypes(["host"], "", "WKCJ-II"), "linux");
  assert.equal(templateFromLegacyTypes(["TAU"], "WKCJ-II", "WKCJ-II"), "product");
  assert.equal(templateFromLegacyTypes(["peer", "host"], "", "WKCJ-II"), "custom");
  assert.equal(templateFromLegacyTypes(["TAU"], "", "WKCJ-II"), "custom");
});

test("upgrades stored devices to type cards and structured interfaces with a backup", async (t) => {
  const { store, file, product } = await createStore(t);
  const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const legacyDevice = (id: string, name: string, types: string[], model: string, description: string, controlInterfaces: unknown[]) => ({
    id, productId: product.id, name, types, model, description, controlInterfaces, createdAt: "", updatedAt: "",
  });
  data.version = 13;
  data.deviceResources = [
    legacyDevice("sw", "switch", ["交换机"], "S5735", "华为", [{ id: "t", name: "主控制", type: "telnet", address: "192.168.176.1", username: "admin", password: "pw" }]),
    legacyDevice("tau1", "TAU1", ["TAU"], "", "", [
      { id: "w", name: "Luci", type: "web", address: "http://192.168.176.2/cgi-bin/luci/", username: "root", password: "" },
      { id: "s", name: "seiral", type: "serial", address: "/dev/ttyACM0", username: "", password: "" },
    ]),
    legacyDevice("tau2", "TAU2", ["peer", "host"], "", "", [{ id: "x", name: "ssh", type: "ssh", address: "192.168.176.3", username: "root", password: "" }]),
  ];
  await writeFile(file, JSON.stringify(data));

  const upgraded = new CatalogStore(file);
  const devices = await upgraded.listDeviceResources(product.id);
  const byName = new Map(devices.map((device) => [device.name, device]));
  assert.equal(byName.get("switch")?.template, "switch");
  assert.equal(byName.get("switch")?.description, "华为\n型号：S5735");
  assert.deepEqual(byName.get("switch")?.controlInterfaces[0], { id: "t", name: "主控制", kind: "telnet", settings: { host: "192.168.176.1", port: "23", username: "admin" }, secretsSet: ["password"] });
  assert.equal(byName.get("TAU1")?.template, "custom");
  assert.equal(byName.get("TAU1")?.description, "原类型：TAU");
  assert.deepEqual(byName.get("TAU1")?.controlInterfaces.map((control) => control.kind), ["web", "serial"]);
  assert.equal(byName.get("TAU1")?.controlInterfaces[1].settings.device, "/dev/ttyACM0");
  assert.equal(byName.get("TAU2")?.description, "原类型：peer、host");
  const [executionDevice] = (await upgraded.getProductDeviceControlResources(product.id)).filter((device) => device.id === "sw");
  assert.equal(executionDevice.controlInterfaces[0].settings.password, "pw");

  // Saving writes the new shape; a later read does not migrate again.
  await upgraded.updateDeviceResource(product.id, "tau1", { name: "TAU1", template: "product", description: "", controlInterfaces: byName.get("TAU1")!.controlInterfaces });
  const stored = JSON.parse(await readFile(file, "utf8")) as { version: number; deviceResources: Record<string, unknown>[] };
  assert.equal(stored.version, 14);
  const storedSwitch = stored.deviceResources.find((device) => device.id === "sw")!;
  assert.equal("types" in storedSwitch || "model" in storedSwitch, false);
  assert.equal(JSON.parse(await readFile(`${file}.v13.bak`, "utf8")).version, 13);
  assert.equal((await new CatalogStore(file).listDeviceResources(product.id)).find((device) => device.id === "tau1")?.template, "product");
});

test("validates each method's fields, keeps stored secrets and clears hidden ones", async (t) => {
  const { store, product } = await createStore(t);
  const ssh = { kind: "ssh", name: "", settings: { host: "192.168.176.3", username: "root", password: "first" } };
  const device = await store.createDeviceResource(product.id, { name: "TAU2", template: "product", description: "对端", controlInterfaces: [ssh] });
  assert.equal(device.templateName, "WKCJ-II");
  assert.equal(device.controlInterfaces[0].settings.port, "22", "an empty port takes the method's default");

  await assert.rejects(store.createDeviceResource(product.id, { name: "a", template: "router", controlInterfaces: [{ kind: "ssh", settings: { host: "h" } }] }), /缺少账号/);
  await assert.rejects(store.createDeviceResource(product.id, { name: "b", template: "router", controlInterfaces: [{ kind: "ssh", settings: { host: "h", username: "u", port: "70000" } }] }), /端口不正确/);
  await assert.rejects(store.createDeviceResource(product.id, { name: "c", template: "router", controlInterfaces: [{ kind: "ssh", settings: { host: "h", username: "u", community: "public" } }] }), /未知字段 community/);
  await assert.rejects(store.createDeviceResource(product.id, { name: "d", template: "router", controlInterfaces: [{ kind: "serial", settings: { device: "/dev/ttyS0", frame: "9N1" } }] }), /数据格式不正确/);
  await assert.rejects(store.createDeviceResource(product.id, { name: "e", template: "firewall", controlInterfaces: [] }), /设备类型不正确/);
  const fast = await store.createDeviceResource(product.id, { name: "f", template: "custom", controlInterfaces: [{ kind: "serial", settings: { device: "/dev/ttyS0", baudRate: "3000000" } }] });
  assert.equal(fast.controlInterfaces[0].settings.baudRate, "3000000", "a non-listed numeric baud rate is still accepted");

  const id = device.controlInterfaces[0].id;
  await store.updateDeviceResource(product.id, device.id, { name: "TAU2", template: "product", controlInterfaces: [{ id, kind: "ssh", settings: { host: "192.168.176.3", username: "root", password: "" } }] });
  const kept = (await store.getProductDeviceControlResources(product.id)).find((item) => item.id === device.id)!;
  assert.equal(kept.controlInterfaces[0].settings.password, "first");

  const api = await store.createDeviceResource(product.id, { name: "api", template: "custom", controlInterfaces: [{ kind: "api", settings: { baseUrl: "http://h/api/", auth: "basic", username: "u", password: "p" } }] });
  const apiId = api.controlInterfaces[0].id;
  await store.updateDeviceResource(product.id, api.id, { name: "api", template: "custom", controlInterfaces: [{ id: apiId, kind: "api", settings: { baseUrl: "http://h/api/", auth: "token", token: "t" } }] });
  const switched = (await store.getProductDeviceControlResources(product.id)).find((item) => item.id === api.id)!.controlInterfaces[0].settings;
  assert.deepEqual({ username: switched.username, password: switched.password, token: switched.token }, { username: "", password: "", token: "t" });
});

test("describes interfaces per method and only marks stored secrets as saved", () => {
  const serial = { kind: "serial" as const, settings: { device: "/dev/ttyACM0", baudRate: "115200", frame: "8N1", username: "root", password: "pw-secret" } };
  assert.equal(controlSummary(serial), "/dev/ttyACM0 · 115200 8N1");
  assert.equal(describeControlSettings(serial), "串口设备 /dev/ttyACM0，波特率 115200，数据格式 8N1，登录账号 root，登录密码 已保存");
  assert.equal(describeControlSettings({ ...serial, settings: { ...serial.settings, password: "" } }), "串口设备 /dev/ttyACM0，波特率 115200，数据格式 8N1，登录账号 root");
  const api = { kind: "api" as const, settings: { baseUrl: "http://h/api/", auth: "token", username: "", password: "", token: "tk-secret" } };
  assert.equal(describeControlSettings(api), "接口地址 http://h/api/，认证 Token，Token 已保存");
  assert.equal(controlSummary(api), "http://h/api/ · Token");
});
