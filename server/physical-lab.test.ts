import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogStore, type DeviceResource, type PhysicalLab } from "./catalog-store.js";
import { formatPhysicalLab } from "./physical-lab-prompt.js";
import { expandPortNames, resolveControlPath, serialDeviceName } from "../shared/physical-lab.js";

async function createStore(t: test.TestContext): Promise<{ store: CatalogStore; file: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-lab-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "catalog.json");
  return { store: new CatalogStore(file), file };
}

async function seedLab(store: CatalogStore) {
  const [product] = await store.listProducts();
  const tau = await store.createDeviceResource(product.id, {
    name: "TAU1",
    types: ["DUT"],
    controlInterfaces: [
      { name: "Web 管理", type: "web", address: "http://192.168.176.2/" },
      { name: "调试串口", type: "serial", address: "/dev/ttyACM0?baudRate=115200" },
    ],
  });
  const sw = await store.createDeviceResource(product.id, { name: "switch", types: ["交换机"], controlInterfaces: [] });
  const lab = await store.getPhysicalLab(product.id);
  const port = (name: string, kind = "ethernet") => ({ id: `${name}-id`, name, kind, note: "" });
  const nodes = lab.nodes.map((node) => {
    if (node.id === tau.id) return { ...node, ports: [port("fe1"), port("ge2"), port("console", "serial")], controlPorts: { [tau.controlInterfaces[0].id]: "ge2-id" } };
    if (node.id === sw.id) return { ...node, ports: [port("9"), port("10"), port("12")] };
    return { ...node, ports: [port("ttyACM0", "serial")] };
  });
  const saved = await store.updatePhysicalLab(product.id, {
    rules: "控制面 VLAN 176，场景不得修改",
    nodes,
    links: [
      { a: { nodeId: sw.id, portId: "9-id" }, b: { nodeId: tau.id, portId: "fe1-id" }, role: "data", note: "" },
      { a: { nodeId: sw.id, portId: "12-id" }, b: { nodeId: tau.id, portId: "ge2-id" }, role: "control", note: "" },
      { a: { nodeId: "platform", portId: "ttyACM0-id" }, b: { nodeId: tau.id, portId: "console-id" }, role: "control", note: "USB 串口" },
    ],
    baseUpdatedAt: lab.updatedAt,
  });
  return { product, tau, sw, lab: saved };
}

test("expands port ranges and keeps other names", () => {
  assert.deepEqual(expandPortNames("1-3, fe1-2 console、DC-IN RS-232 GE0/0/1-2 eth01-03"), [
    "1", "2", "3", "fe1", "fe2", "console", "DC-IN", "RS-232", "GE0/0/1", "GE0/0/2", "eth01", "eth02", "eth03",
  ]);
  assert.deepEqual(expandPortNames("ge1 GE1"), ["ge1"]);
  assert.equal(serialDeviceName("/dev/ttyACM0?baudRate=115200"), "ttyACM0");
  assert.equal(serialDeviceName("COM3"), "COM3");
});

test("lists every product device and the platform in a new lab", async (t) => {
  const { store } = await createStore(t);
  const [product, other] = await store.listProducts();
  const device = await store.createDeviceResource(product.id, { name: "TAU1", types: ["DUT"], controlInterfaces: [] });
  await store.createDeviceResource(other.id, { name: "其他产品设备", types: ["host"], controlInterfaces: [] });
  const lab = await store.getPhysicalLab(product.id);
  assert.deepEqual(lab.nodes.map((node) => [node.kind, node.name]), [["device", "TAU1"], ["platform", "平台服务器"]]);
  assert.equal(lab.nodes[0].id, device.id);
  assert.equal(lab.updatedAt, "");
});

test("saves wiring, resolves control paths and stores the catalog as version 14", async (t) => {
  const { store, file } = await createStore(t);
  const { tau, sw, lab } = await seedLab(store);
  assert.equal(lab.links.length, 3);
  assert.equal(lab.nodes.find((node) => node.id === sw.id)?.name, "switch");
  const stored = JSON.parse(await readFile(file, "utf8")) as { version: number; physicalLabs: PhysicalLab[] };
  assert.equal(stored.version, 14);
  assert.equal(stored.physicalLabs[0].nodes.find((node) => node.id === tau.id)?.name, "", "device names are resolved on read, not stored");

  const web = resolveControlPath(lab, tau.id, tau.controlInterfaces[0]);
  assert.equal(web.source, "manual");
  assert.equal(web.band, "in-band");
  assert.deepEqual(web.peer, { nodeId: sw.id, portId: "12-id" });
  const serial = resolveControlPath(lab, tau.id, tau.controlInterfaces[1]);
  assert.equal(serial.source, "serial");
  assert.equal(serial.portId, "console-id");
  assert.equal(serial.band, "out-of-band");
  assert.equal(serial.addressMatches, true);
});

test("rejects busy ports, mismatched port kinds and stale revisions", async (t) => {
  const { store } = await createStore(t);
  const { product, tau, sw, lab } = await seedLab(store);
  const base = { rules: lab.rules, nodes: lab.nodes, baseUpdatedAt: lab.updatedAt };
  await assert.rejects(store.updatePhysicalLab(product.id, {
    ...base,
    links: [...lab.links, { a: { nodeId: sw.id, portId: "10-id" }, b: { nodeId: tau.id, portId: "fe1-id" }, role: "data", note: "" }],
  }), /一个端口只能接一根线/);
  await assert.rejects(store.updatePhysicalLab(product.id, {
    ...base,
    links: [{ a: { nodeId: sw.id, portId: "10-id" }, b: { nodeId: tau.id, portId: "console-id" }, role: "data", note: "" }],
  }), /不能连接串口/);
  await assert.rejects(store.updatePhysicalLab(product.id, {
    ...base,
    nodes: lab.nodes.map((node) => node.id === sw.id ? { ...node, ports: [...node.ports, { id: "dup", name: "9", kind: "ethernet", note: "" }] } : node),
  }), /端口“9”重复/);
  await store.updatePhysicalLab(product.id, { ...base, links: lab.links });
  await assert.rejects(store.updatePhysicalLab(product.id, { ...base, links: lab.links }), /已在其他地方修改/);
});

test("keeps devices with wiring and drops the node of a deleted device", async (t) => {
  const { store } = await createStore(t);
  const { product, tau, sw, lab } = await seedLab(store);
  await assert.rejects(store.archiveDeviceResource(product.id, tau.id), /仍有接线/);
  const loose = await store.createDeviceResource(product.id, { name: "备用", types: ["host"], controlInterfaces: [] });
  const withLoose = await store.getPhysicalLab(product.id);
  await store.updatePhysicalLab(product.id, {
    rules: withLoose.rules,
    nodes: withLoose.nodes.map((node) => node.id === loose.id ? { ...node, ports: [{ id: "p", name: "eth0", kind: "ethernet", note: "" }] } : node),
    links: withLoose.links,
    baseUpdatedAt: withLoose.updatedAt,
  });
  await store.archiveDeviceResource(product.id, loose.id);
  const after = await store.getPhysicalLab(product.id);
  assert.equal(after.nodes.some((node) => node.id === loose.id), false);
  assert.equal(after.links.length, lab.links.length);
  assert.ok(after.nodes.some((node) => node.id === sw.id));
});

test("snapshots the wiring into new runs without sending it to the browser", async (t) => {
  const { store } = await createStore(t);
  const { product, tau } = await seedLab(store);
  const scenario = await store.createTestScenario(product.id, {
    name: "端口镜像",
    category: "镜像",
    roles: [{ key: "DUT", deviceId: tau.id }],
    setupInstructions: "配置镜像",
    verificationInstructions: "检查镜像",
  });
  const testCase = await store.createTestCase(product.id, { name: "镜像", scenarioId: scenario.id, steps: "抓包", expectedResult: "收到报文" });
  const order = await store.createTestOrder(product.id, { name: "镜像测试", caseIds: [testCase.id] });
  const run = await store.createTestRun("lab-run", order.id);
  assert.equal(run.physicalLabSnapshot?.links.length, 3);
  const detail = await store.getTestOrderDetail(product.id, order.id);
  assert.equal("physicalLabSnapshot" in detail.runs[0], false);
  assert.equal(detail.latestRun && "physicalLabSnapshot" in detail.latestRun, false);
  const diagnostic = await store.getDiagnosticExecutionContext(product.id, run.id, run.caseRuns[0].id);
  assert.equal(diagnostic.physicalLabSource, "snapshot");
  assert.equal(diagnostic.physicalLab?.rules, "控制面 VLAN 176，场景不得修改");
});

test("formats the wiring of bound devices for the agent", async (t) => {
  const { store } = await createStore(t);
  const { tau, sw, lab } = await seedLab(store);
  const devices = (await store.getProductDeviceControlResources(lab.productId)) as DeviceResource[];
  const tauOnly = formatPhysicalLab(lab, devices.filter((device) => device.id === tau.id));
  assert.match(tauOnly, /环境规则：\n控制面 VLAN 176/);
  assert.match(tauOnly, /- TAU1 fe1 ↔ switch 9 口（业务）/);
  assert.match(tauOnly, /- TAU1 ge2 ↔ switch 12 口（控制）/);
  assert.match(tauOnly, /- TAU1 console ↔ 平台服务器 ttyACM0（控制；USB 串口）/);
  assert.match(tauOnly, /不得关闭这些连线两端的端口/);
  assert.match(tauOnly, /- TAU1 Web 管理（web，接口 ID: [^）]+）：经 ge2 ↔ switch 12 口，带内/);
  assert.match(tauOnly, /- TAU1 调试串口（serial，接口 ID: [^）]+）：经 console ↔ 平台服务器 ttyACM0，带外/);
  assert.doesNotMatch(tauOnly, /未接线的端口/);

  const withSwitch = formatPhysicalLab(lab, devices.filter((device) => device.id === tau.id || device.id === sw.id));
  assert.match(withSwitch, /本场景设备未接线的端口：\n- switch：10/);
  assert.equal(formatPhysicalLab(undefined, devices), "");
  assert.equal(formatPhysicalLab({ ...lab, rules: "", links: [] }, devices), "");
  const rulesOnly = formatPhysicalLab({ ...lab, links: [] }, devices);
  assert.match(rulesOnly, /接线尚未登记/);
  assert.doesNotMatch(rulesOnly, /没有列出的连接不要假设存在|未接线的端口/);
});

test("upgrades a v12 catalog with a backup and an empty lab list", async (t) => {
  const { store, file } = await createStore(t);
  await store.listProducts();
  const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  delete data.physicalLabs;
  data.version = 12;
  await writeFile(file, JSON.stringify(data));
  const upgraded = new CatalogStore(file);
  const [product] = await upgraded.listProducts();
  assert.equal((await upgraded.getPhysicalLab(product.id)).links.length, 0);
  assert.equal(JSON.parse(await readFile(`${file}.v12.bak`, "utf8")).version, 12);
});
