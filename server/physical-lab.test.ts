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

const port = (name: string, kind = "ethernet") => ({ id: `${name}-id`, name, kind, specification: "", note: "" });

async function seedLab(store: CatalogStore) {
  const [product] = await store.listProducts();
  // Device ports, and the port each control method goes through, are registered with the device.
  const tau = await store.createDeviceResource(product.id, {
    name: "TAU1",
    types: ["DUT"],
    ports: [port("fe1"), port("ge2"), port("console", "serial")],
    controlInterfaces: [
      { id: "web-id", name: "Web 管理", kind: "web", settings: { url: "http://192.168.176.2/" }, portId: "ge2-id" },
      { id: "serial-id", name: "调试串口", kind: "serial", settings: { device: "/dev/ttyACM0", baudRate: "115200" } },
    ],
  });
  const sw = await store.createDeviceResource(product.id, { name: "switch", types: ["交换机"], ports: [port("9"), port("10"), port("12")], controlInterfaces: [] });
  const lab = await store.getPhysicalLab(product.id);
  const nodes = lab.nodes.map((node) => node.kind === "platform" ? { ...node, ports: [port("ttyACM0", "serial")] } : node);
  const saved = await store.updatePhysicalLab(product.id, {
    rules: "控制面 VLAN 176，场景不得修改",
    nodes,
    links: [
      { a: { nodeId: sw.id, portId: "9-id" }, b: { nodeId: tau.id, portId: "fe1-id" }, note: "" },
      { a: { nodeId: sw.id, portId: "12-id" }, b: { nodeId: tau.id, portId: "ge2-id" }, note: "" },
      { a: { nodeId: "platform", portId: "ttyACM0-id" }, b: { nodeId: tau.id, portId: "console-id" }, note: "USB 串口" },
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

test("saves wiring, resolves control paths and stores the catalog as version 17", async (t) => {
  const { store, file } = await createStore(t);
  const { tau, sw, lab } = await seedLab(store);
  assert.equal(lab.links.length, 3);
  assert.equal(lab.nodes.find((node) => node.id === sw.id)?.name, "switch");
  const stored = JSON.parse(await readFile(file, "utf8")) as { version: number; physicalLabs: PhysicalLab[] };
  assert.equal(stored.version, 17);
  assert.equal(stored.physicalLabs[0].nodes.some((node) => node.kind === "device"), false, "device nodes are built from the devices on read");
  assert.equal(stored.physicalLabs[0].links.some((link) => "role" in link), false, "a cable's role is worked out on read");
  assert.deepEqual(lab.nodes.find((node) => node.id === tau.id)?.ports.map((item) => item.name), ["fe1", "ge2", "console"]);

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

test("works out which cables carry control from the control methods and the platform", async (t) => {
  const { store } = await createStore(t);
  const { product, tau, sw, lab } = await seedLab(store);
  const roles = (current: PhysicalLab) => current.links.map((link) => [link.a.portId, link.role]);
  // ge2 carries the Web method; the console cable plugs into the platform.
  assert.deepEqual(roles(lab), [["9-id", "data"], ["12-id", "control"], ["ttyACM0-id", "control"]]);

  // A role sent with a cable is ignored, and a cable between power ports carries power.
  await store.updateDeviceResource(product.id, sw.id, { name: "switch", template: sw.template, description: "", ports: [port("9"), port("10"), port("12"), port("pwr", "power")], controlInterfaces: [] });
  const current = await store.getPhysicalLab(product.id);
  const saved = await store.updatePhysicalLab(product.id, {
    rules: current.rules,
    nodes: [...current.nodes, { id: "pdu", kind: "external", name: "PDU", ports: [{ id: "o1", name: "o1", kind: "power", note: "" }], controlPorts: {} }],
    links: [
      ...current.links.map((link) => ({ ...link, role: "control" })),
      { a: { nodeId: sw.id, portId: "pwr-id" }, b: { nodeId: "pdu", portId: "o1" }, role: "data", note: "" },
    ],
    baseUpdatedAt: current.updatedAt,
  });
  assert.deepEqual(roles(saved), [["9-id", "data"], ["12-id", "control"], ["ttyACM0-id", "control"], ["pwr-id", "power"]]);

  // Once the Web method no longer names ge2, its cable is an ordinary data cable.
  const device = (await store.listDeviceResources(product.id)).find((item) => item.id === tau.id)!;
  await store.updateDeviceResource(product.id, tau.id, {
    name: "TAU1",
    template: device.template,
    description: "",
    ports: device.ports,
    controlInterfaces: device.controlInterfaces.map((control) => ({ ...control, portId: "" })),
  });
  assert.deepEqual(roles(await store.getPhysicalLab(product.id)).slice(0, 2), [["9-id", "data"], ["12-id", "data"]]);
});

test("rejects busy ports, mismatched port kinds and stale revisions", async (t) => {
  const { store } = await createStore(t);
  const { product, tau, sw, lab } = await seedLab(store);
  const base = { rules: lab.rules, nodes: lab.nodes, baseUpdatedAt: lab.updatedAt };
  await assert.rejects(store.updatePhysicalLab(product.id, {
    ...base,
    links: [...lab.links, { a: { nodeId: sw.id, portId: "10-id" }, b: { nodeId: tau.id, portId: "fe1-id" }, note: "" }],
  }), /一个端口只能接一根线/);
  await assert.rejects(store.updatePhysicalLab(product.id, {
    ...base,
    links: [{ a: { nodeId: sw.id, portId: "10-id" }, b: { nodeId: tau.id, portId: "console-id" }, note: "" }],
  }), /不能连接串口/);
  await assert.rejects(store.updatePhysicalLab(product.id, {
    ...base,
    nodes: lab.nodes.map((node) => node.kind === "platform" ? { ...node, ports: [...node.ports, { id: "dup", name: "ttyACM0", kind: "serial", note: "" }] } : node),
  }), /端口“ttyACM0”重复/);
  // The page cannot change a device's ports or control ports through the lab.
  const saved = await store.updatePhysicalLab(product.id, {
    ...base,
    nodes: lab.nodes.map((node) => node.id === sw.id ? { ...node, ports: [...node.ports, port("11")] } : node.id === tau.id ? { ...node, controlPorts: {} } : node),
    links: lab.links,
  });
  assert.deepEqual(saved.nodes.find((node) => node.id === sw.id)?.ports.map((item) => item.name), ["9", "10", "12"]);
  assert.deepEqual(saved.nodes.find((node) => node.id === tau.id)?.controlPorts, { [tau.controlInterfaces[0].id]: "ge2-id" });
  await assert.rejects(store.updatePhysicalLab(product.id, { ...base, links: lab.links }), /已在其他地方修改/);
});

test("keeps devices with wiring and drops the node of a deleted device", async (t) => {
  const { store } = await createStore(t);
  const { product, tau, sw, lab } = await seedLab(store);
  await assert.rejects(store.archiveDeviceResource(product.id, tau.id), /仍有接线/);
  const loose = await store.createDeviceResource(product.id, { name: "备用", types: ["host"], ports: [port("eth0")], controlInterfaces: [] });
  assert.ok((await store.getPhysicalLab(product.id)).nodes.some((node) => node.id === loose.id));
  await store.archiveDeviceResource(product.id, loose.id);
  const after = await store.getPhysicalLab(product.id);
  assert.equal(after.nodes.some((node) => node.id === loose.id), false);
  assert.equal(after.links.length, lab.links.length);
  assert.ok(after.nodes.some((node) => node.id === sw.id));

  // Removing a cabled port in the device editor removes its cable, so it no longer holds the device.
  await store.updateDeviceResource(product.id, sw.id, { name: "switch", template: sw.template, description: "", ports: [port("10"), port("12")], controlInterfaces: [] });
  assert.deepEqual((await store.getPhysicalLab(product.id)).links.map((link) => link.a.portId), ["12-id", "ttyACM0-id"]);
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

test("moves the device ports a v14 lab kept onto the devices, with a backup", async (t) => {
  const { store, file } = await createStore(t);
  const [product] = await store.listProducts();
  const tau = await store.createDeviceResource(product.id, {
    name: "TAU1",
    types: ["DUT"],
    ports: [port("fe1")],
    controlInterfaces: [{ id: "web-id", name: "Web", kind: "web", settings: { url: "http://192.168.176.2/" } }],
  });
  const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  data.version = 14;
  data.physicalLabs = [{
    productId: product.id,
    rules: "",
    updatedAt: "2026-10-20T00:00:00.000Z",
    nodes: [
      {
        id: tau.id,
        kind: "device",
        name: "",
        ports: [{ id: "lab-fe1", name: "FE1", kind: "ethernet", note: "" }, { id: "lab-ge1", name: "ge1", kind: "ethernet", note: "管理口" }],
        controlPorts: { "web-id": "lab-ge1" },
      },
      { id: "platform", kind: "platform", name: "平台服务器", ports: [port("eth1"), port("eth2")], controlPorts: {} },
    ],
    links: [
      { id: "l1", a: { nodeId: "platform", portId: "eth1-id" }, b: { nodeId: tau.id, portId: "lab-ge1" }, role: "control", note: "" },
      { id: "l2", a: { nodeId: "platform", portId: "eth2-id" }, b: { nodeId: tau.id, portId: "lab-fe1" }, role: "data", note: "" },
    ],
  }];
  await writeFile(file, JSON.stringify(data));

  const upgraded = new CatalogStore(file);
  const [device] = await upgraded.listDeviceResources(product.id);
  assert.deepEqual(device.ports?.map((item) => [item.id, item.name, item.note]), [["fe1-id", "fe1", ""], ["lab-ge1", "ge1", "管理口"]], "a port the device already has is reused");
  assert.equal(device.controlInterfaces[0].portId, "lab-ge1");
  const lab = await upgraded.getPhysicalLab(product.id);
  assert.deepEqual(lab.links.map((link) => link.b.portId), ["lab-ge1", "fe1-id"], "cables stay on their ports");
  assert.equal(JSON.parse(await readFile(`${file}.v14.bak`, "utf8")).version, 14);
});

test("a v15 cable's hand-picked role gives way to the worked-out one", async (t) => {
  const { store, file } = await createStore(t);
  const { product, sw } = await seedLab(store);
  const data = JSON.parse(await readFile(file, "utf8")) as { version: number; physicalLabs: Array<{ links: Array<Record<string, unknown>> }> };
  data.version = 15;
  // fe1 was marked as control by hand, ge2 (which the Web method goes through) as data.
  data.physicalLabs[0].links = data.physicalLabs[0].links.map((link) => ({ ...link, role: (link.b as { portId: string }).portId === "fe1-id" ? "control" : "data" }));
  await writeFile(file, JSON.stringify(data));

  const upgraded = new CatalogStore(file);
  const lab = await upgraded.getPhysicalLab(product.id);
  assert.deepEqual(lab.links.map((link) => [link.b.portId, link.role]), [["fe1-id", "data"], ["ge2-id", "control"], ["console-id", "control"]]);
  assert.equal(JSON.parse(await readFile(`${file}.v15.bak`, "utf8")).version, 15);
  await upgraded.updateDeviceResource(product.id, sw.id, { name: "switch", template: sw.template, description: "", ports: [port("9"), port("10"), port("12")], controlInterfaces: [] });
  const saved = JSON.parse(await readFile(file, "utf8")) as { version: number; physicalLabs: Array<{ links: Array<Record<string, unknown>> }> };
  assert.equal(saved.version, 17);
  assert.equal(saved.physicalLabs[0].links.some((link) => "role" in link), false);
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
