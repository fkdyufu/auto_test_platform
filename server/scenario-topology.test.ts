import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogStore } from "./catalog-store.js";
import { formatOtherCleanup, formatScenarioTopology, formatTopologyCleanup, formatTopologySetup, scenarioTransitDeviceIds } from "./scenario-topology-prompt.js";
import { analyzeScenarioTopology, planScenarioTopology, topologyProblems, type ScenarioSegment } from "../shared/scenario-topology.js";

const port = (name: string, kind = "ethernet") => ({ id: `${name}-id`, name, kind, specification: "", note: "" });

/** A lab wired like 9.176: two TAUs and a managed switch, hosts behind a vswitch the platform cannot configure. */
async function seed(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-topology-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "catalog.json");
  const store = new CatalogStore(file);
  const [product] = await store.listProducts();
  const tauPorts = ["FE1", "FE2", "GE1", "GE2"].map((name) => port(name));
  const tau1 = await store.createDeviceResource(product.id, { name: "TAU1", template: "product", ports: tauPorts, controlInterfaces: [{ id: "tau1-web", name: "", kind: "web", settings: { url: "http://192.168.176.2/" }, portId: "GE2-id" }] });
  const tau2 = await store.createDeviceResource(product.id, { name: "TAU2", template: "product", ports: tauPorts, controlInterfaces: [{ id: "tau2-web", name: "", kind: "web", settings: { url: "http://192.168.176.3/" }, portId: "GE2-id" }] });
  const sw = await store.createDeviceResource(product.id, { name: "switch", template: "switch", ports: ["9", "10", "11", "12", "13", "14", "15", "16"].map((name) => port(name)), controlInterfaces: [{ id: "sw-telnet", name: "", kind: "telnet", settings: { host: "192.168.176.1", port: "23" }, portId: "16-id" }] });
  const vswitch = await store.createDeviceResource(product.id, { name: "vswitch", template: "switch", ports: ["1", "2", "3", "4", "5", "6"].map((name) => port(name)), controlInterfaces: [] });
  const hostPorts = [port("ens224"), port("ens256")];
  const host1 = await store.createDeviceResource(product.id, { name: "host1", template: "linux", ports: hostPorts, controlInterfaces: [{ id: "h1-ssh", name: "", kind: "ssh", settings: { host: "192.168.176.11", port: "22", username: "root" }, portId: "ens256-id" }] });
  const host2 = await store.createDeviceResource(product.id, { name: "host2", template: "linux", ports: hostPorts, controlInterfaces: [{ id: "h2-ssh", name: "", kind: "ssh", settings: { host: "192.168.176.12", port: "22", username: "root" }, portId: "ens256-id" }] });
  const lab = await store.getPhysicalLab(product.id);
  const cable = (a: [string, string], b: [string, string]) => ({ a: { nodeId: a[0], portId: `${a[1]}-id` }, b: { nodeId: b[0], portId: `${b[1]}-id` }, note: "" });
  await store.updatePhysicalLab(product.id, {
    rules: "",
    nodes: lab.nodes.map((node) => node.kind === "platform" ? { ...node, ports: [port("control")] } : node),
    links: [
      cable([tau1.id, "FE1"], [sw.id, "9"]), cable([tau1.id, "GE1"], [sw.id, "11"]), cable([tau1.id, "GE2"], [sw.id, "12"]),
      cable([tau1.id, "FE2"], [tau2.id, "FE2"]),
      cable([tau2.id, "FE1"], [sw.id, "13"]), cable([tau2.id, "GE1"], [sw.id, "14"]), cable([tau2.id, "GE2"], [sw.id, "15"]),
      cable([sw.id, "16"], [vswitch.id, "1"]),
      cable([vswitch.id, "2"], [host1.id, "ens224"]), cable([vswitch.id, "3"], [host1.id, "ens256"]),
      cable([vswitch.id, "4"], [host2.id, "ens224"]), cable([vswitch.id, "5"], [host2.id, "ens256"]),
      cable(["platform", "control"], [vswitch.id, "6"]),
    ],
    baseUpdatedAt: lab.updatedAt,
  });
  const roles = [
    { id: "r-tau", key: "TAU", deviceId: tau1.id },
    { id: "r-src", key: "src", deviceId: host1.id },
    { id: "r-dst", key: "dst", deviceId: host2.id },
    { id: "r-obs", key: "observer", deviceId: tau2.id },
  ];
  const member = (id: string, roleId: string, name: string, address: string, portId: string) => ({ id, roleId, name, address, portId });
  const segments: ScenarioSegment[] = [
    { id: "s-src", name: "源侧", vlan: "181", subnet: "192.168.181.0/24", interfaces: [member("i1", "r-tau", "fe1", "192.168.181.2", "FE1-id"), member("i2", "r-src", "ens224", "192.168.181.3", "ens224-id")] },
    { id: "s-dst", name: "目的侧", vlan: "182", subnet: "192.168.182.0/24", interfaces: [member("i3", "r-tau", "ge1", "192.168.182.2", "GE1-id"), member("i4", "r-dst", "ens224", "192.168.182.3", "ens224-id")] },
    { id: "s-mirror", name: "镜像", vlan: "", subnet: "", interfaces: [member("i5", "r-tau", "fe2", "", "FE2-id"), member("i6", "r-obs", "fe2", "", "FE2-id")] },
  ];
  return { store, file, product, tau1, tau2, sw, vswitch, host1, host2, roles, segments };
}

test("the platform works out switch VLANs, addresses, checks and cleanup from the segments", async (t) => {
  const f = await seed(t);
  const lab = await f.store.getPhysicalLab(f.product.id);
  const devices = await f.store.listDeviceResources(f.product.id);
  const analysis = analyzeScenarioTopology({ lab, roles: f.roles, devices, segments: f.segments });
  assert.deepEqual(topologyProblems(analysis), []);
  assert.deepEqual(analysis.map((item) => item.direct), [false, false, true]);
  const plan = planScenarioTopology({ lab, devices, roles: f.roles }, analysis);
  // The switch is written out in full: unused business ports shut, the uplink carries only what this scenario needs.
  assert.deepEqual(plan.switches, [{ deviceId: f.sw.id, name: "switch", lines: [
    "VLAN 181（源侧）：9 口清除原有配置后设为 access 并开启",
    "VLAN 182（目的侧）：11 口清除原有配置后设为 access 并开启",
    "16 口 trunk：只放行控制所用的 VLAN 和 181、182，移除其他业务 VLAN",
    "10 口、13 口、14 口关闭（本场景不用的业务口）",
  ] }]);
  assert.deepEqual(plan.passThrough, ["vswitch 2 口须已在 VLAN 181（源侧，平台不配置 vswitch）", "vswitch 4 口须已在 VLAN 182（目的侧，平台不配置 vswitch）"]);
  assert.deepEqual(plan.direct, ["镜像：TAU fe2 ↔ observer fe2 直连，不经过交换机"]);
  assert.ok(plan.addresses.includes("TAU fe1（TAU1 FE1）：开启，192.168.181.2/24"));
  assert.ok(plan.addresses.includes("observer fe2（TAU2 FE2）：开启，清除地址，不配地址"));
  // Unused ports of role devices lose their addresses; management ports never do.
  assert.equal(plan.addresses.at(-1), "observer（TAU2）FE1、GE1：清除地址（本场景不用）");
  assert.ok(!plan.addresses.some((line) => /GE2|ens256/.test(line)));
  assert.deepEqual(plan.verify, ["源侧：TAU fe1、src ens224 之间互相 ping 通", "目的侧：TAU ge1、dst ens224 之间互相 ping 通", "镜像：没有地址，不做连通性验证"]);
  assert.deepEqual(plan.cleanup, ["switch 9 口、11 口关闭并恢复默认 VLAN", "switch 16 口 trunk 移除放行 VLAN 181、182", "删除以上接口地址"]);

  // Without a known management port the device's addresses are left alone rather than risk cutting it off.
  const unknown = devices.map((device) => device.id === f.tau2.id ? { ...device, controlInterfaces: device.controlInterfaces.map(({ portId: _portId, ...control }) => control) } : device);
  assert.ok(!planScenarioTopology({ lab, devices: unknown, roles: f.roles }, analysis).addresses.some((line) => line.startsWith("observer（TAU2）")));
});

test("topology problems say what is wrong and where it is fixed", async (t) => {
  const f = await seed(t);
  const lab = await f.store.getPhysicalLab(f.product.id);
  const devices = await f.store.listDeviceResources(f.product.id);
  const segments = structuredClone(f.segments);
  segments[0].vlan = "";
  segments[0].interfaces[0].portId = "GE2-id";
  segments[1].interfaces[1].address = "192.168.181.9";
  segments[2].interfaces.push({ id: "i7", roleId: "r-src", name: "ens224", address: "", portId: "ens224-id" });
  const problems = topologyProblems(analyzeScenarioTopology({ lab, roles: f.roles, devices, segments }));
  assert.deepEqual(problems.map((problem) => [problem.area, problem.text]), [
    ["mapping", "源侧 经过交换机，需要 VLAN"],
    ["mapping", "TAU1 GE2 是控制通道，不能放进业务网段"],
    ["mapping", "host1 ens224 被多个接口占用"],
    ["addresses", "dst ens224 的地址不在 192.168.182.0/24 内"],
    ["mapping", "镜像 经过交换机，需要 VLAN"],
    ["mapping", "TAU1 FE2 直连 TAU2，只能和对端单独组成网段"],
    ["mapping", "TAU2 FE2 直连 TAU1，只能和对端单独组成网段"],
    ["mapping", "host1 ens224 被多个接口占用"],
  ]);
});

test("a scenario with a topology needs no setup text, runs only once the topology is sound, and lets go of removed ports", async (t) => {
  const f = await seed(t);
  await assert.rejects(f.store.createTestScenario(f.product.id, { name: "只有文字", category: "镜像", roles: f.roles }), /场景准备不能为空/);
  await assert.rejects(f.store.createTestScenario(f.product.id, { name: "错端口", category: "镜像", roles: f.roles, segments: [{ ...f.segments[0], interfaces: [{ ...f.segments[0].interfaces[0], portId: "9-id" }] }] }), /选择的端口不属于绑定的设备/);
  await assert.rejects(f.store.createTestScenario(f.product.id, { name: "无角色", category: "镜像", roles: f.roles, segments: [{ ...f.segments[0], interfaces: [{ ...f.segments[0].interfaces[0], roleId: "nobody" }] }] }), /没有对应的角色/);
  const scenario = await f.store.createTestScenario(f.product.id, { name: "端口镜像", category: "镜像", roles: f.roles, segments: f.segments });
  assert.equal(scenario.setupInstructions, "");
  assert.equal(scenario.segments.length, 3);

  const testCase = await f.store.createTestCase(f.product.id, { name: "入方向镜像", scenarioId: scenario.id, steps: "在 TAU 上把 fe1 入方向镜像到 fe2", expectedResult: "observer 抓到报文" });
  const order = await f.store.createTestOrder(f.product.id, { name: "镜像", caseIds: [testCase.id] });
  await f.store.updateTestScenario(f.product.id, scenario.id, { ...scenario, segments: [{ ...f.segments[0], vlan: "" }, ...f.segments.slice(1)] });
  await assert.rejects(f.store.createTestRun("run-1", order.id), /拓扑还有 1 个问题，需要先处理：源侧 经过交换机，需要 VLAN/);
  await f.store.updateTestScenario(f.product.id, scenario.id, { ...scenario, segments: f.segments });
  const run = await f.store.createTestRun("run-2", order.id);
  assert.equal(run.scenarioRuns[0].scenarioSnapshot?.segments.length, 3);

  // TAU1 loses FE2: the mirror interface keeps its place but is no longer mapped.
  await f.store.updateDeviceResource(f.product.id, f.tau1.id, { name: "TAU1", template: "product", description: "", ports: ["FE1", "GE1", "GE2"].map((name) => port(name)), controlInterfaces: f.tau1.controlInterfaces });
  const [, saved] = await f.store.listTestScenarios(f.product.id);
  assert.equal(saved.segments[2].interfaces[0].portId, "");
});

test("prompts describe the topology, what to set up and undo, and bring the switches the segments run through", async (t) => {
  const f = await seed(t);
  const lab = await f.store.getPhysicalLab(f.product.id);
  const devices = (await f.store.getProductDeviceControlResources(f.product.id)) as Parameters<typeof formatScenarioTopology>[2];
  const scenario = { roles: f.roles, segments: f.segments };
  assert.deepEqual(scenarioTransitDeviceIds(scenario, lab, devices), [f.sw.id]);
  const description = formatScenarioTopology(scenario, lab, devices);
  assert.match(description, /- 源侧（VLAN 181，192\.168\.181\.0\/24）\n  - TAU fe1 = TAU1 FE1（接 switch 9 口），地址 192\.168\.181\.2\/24\n  - src ens224 = host1 ens224（经 vswitch 2 口接 switch 16 口），地址 192\.168\.181\.3\/24/);
  assert.match(description, /- 镜像（直连）\n  - TAU fe2 = TAU1 FE2（直连 TAU2 FE2），不配地址/);
  assert.match(description, /平台提供 switch 的控制工具用于搭建这些网段，它们不是场景角色/);
  const setup = formatTopologySetup(scenario, lab, devices);
  assert.match(setup, /在 switch 上：\n- VLAN 181（源侧）：9 口清除原有配置后设为 access 并开启\n- VLAN 182（目的侧）：11 口清除原有配置后设为 access 并开启\n- 16 口 trunk：只放行控制所用的 VLAN 和 181、182，移除其他业务 VLAN\n- 10 口、13 口、14 口关闭（本场景不用的业务口）/);
  assert.match(setup, /- observer（TAU2）FE1、GE1：清除地址（本场景不用）/);
  assert.match(setup, /需要确认（平台不配置的设备）：\n- vswitch 2 口须已在 VLAN 181/);
  assert.match(setup, /拓扑验证：\n- 源侧：TAU fe1、src ens224 之间互相 ping 通/);
  assert.match(setup, /只改运行配置，不执行 save/);
  assert.match(formatTopologyCleanup(scenario, lab, devices), /- switch 16 口 trunk 移除放行 VLAN 181、182\n- 删除以上接口地址\n交换机只改运行配置，不执行 save。/);
  assert.equal(formatScenarioTopology({ roles: f.roles, segments: [] }, lab, devices), "");

  // Cleanup undoes the other preparation as well as doing what the cleanup text adds; a text-only scenario is unchanged.
  const texts = { setupInstructions: "src 的默认网关指向 TAU 的 fe1。", cleanupInstructions: "删除 TAU 中的镜像配置。" };
  assert.equal(formatOtherCleanup({ segments: f.segments, ...texts }), "删除 TAU 中的镜像配置。\n\n撤销其他准备所做的配置：\nsrc 的默认网关指向 TAU 的 fe1。");
  assert.equal(formatOtherCleanup({ segments: [], ...texts }), "删除 TAU 中的镜像配置。");
  assert.equal(formatOtherCleanup({ segments: [], setupInstructions: "", cleanupInstructions: "" }), "无");
});

test("upgrading to version 17 gives every scenario a topology and drops the ports roles used to pick", async (t) => {
  const f = await seed(t);
  await f.store.createTestScenario(f.product.id, { name: "旧场景", category: "镜像", roles: f.roles, setupInstructions: "配置交换机", verificationInstructions: "检查" });
  const data = JSON.parse(await readFile(f.file, "utf8")) as { version: number; testScenarios: Array<Record<string, unknown>> };
  data.version = 16;
  for (const scenario of data.testScenarios) {
    delete scenario.segments;
    scenario.roles = (scenario.roles as Array<Record<string, unknown>>).map((role) => ({ ...role, portIds: ["FE1-id"] }));
  }
  await writeFile(f.file, JSON.stringify(data));
  const upgraded = new CatalogStore(f.file);
  const scenarios = await upgraded.listTestScenarios(f.product.id);
  assert.ok(scenarios.every((scenario) => Array.isArray(scenario.segments) && scenario.segments.length === 0));
  assert.ok(scenarios.flatMap((scenario) => scenario.roles).every((role) => !("portIds" in role)));
  assert.equal(JSON.parse(await readFile(`${f.file}.v16.bak`, "utf8")).version, 16);
});
