import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { CatalogError, CatalogStore } from "./catalog-store.js";
import { AssistantStore } from "./assistant-store.js";
import { createAssistantTools } from "./assistant-tools.js";
import { createAssistantRouter } from "./assistant-routes.js";
import { compactPortNames, describeLabForAssistant } from "./lab-changes.js";
import type { LabOperation } from "../shared/assistant.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-lab-changes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "catalog.json");
  const catalog = new CatalogStore(filePath);
  const store = new AssistantStore(path.join(directory, "assistant.json"));
  const [product] = await catalog.listProducts();
  const tau = await catalog.createDeviceResource(product.id, {
    name: "TAU1",
    template: "product",
    controlInterfaces: [
      { kind: "web", name: "Luci", settings: { url: "http://192.168.176.2/", username: "root", password: "web-secret" } },
      { kind: "serial", name: "", settings: { device: "/dev/ttyACM0", baudRate: "115200", frame: "8N1", username: "root", password: "console-secret" } },
    ],
  });
  const sw = await catalog.createDeviceResource(product.id, { name: "S5735", template: "switch", controlInterfaces: [] });
  return { directory, filePath, catalog, store, product, tau, sw };
}

const cabling: LabOperation[] = [
  { op: "add_ports", node: "s5735", ports: "1-4" },
  { op: "add_ports", node: "TAU1", ports: "fe1-2, ge1" },
  { op: "add_ports", node: "TAU1", ports: "console", kind: "serial" },
  { op: "add_ports", node: "平台服务器", ports: "ttyACM0", kind: "serial" },
  { op: "connect", a: { node: "S5735", port: "1 口" }, b: { node: "TAU1", port: "fe1" } },
  { op: "connect", a: { node: "TAU1", port: "console" }, b: { node: "平台服务器", port: "ttyACM0" } },
  { op: "set_control_port", node: "TAU1", controlInterfaceId: "Luci", port: "fe1" },
  { op: "set_rules", rules: "控制面 VLAN 176，场景不得修改" },
];

test("lab operations preview readable changes without saving, then save exactly what was shown", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.filePath, "utf8");
  const preview = await f.catalog.previewPhysicalLabChanges(f.product.id, cabling);
  assert.equal(await readFile(f.filePath, "utf8"), original, "a preview never writes");
  assert.deepEqual(preview.changes.map((change) => change.text), [
    "修改环境规则",
    "新增 S5735 端口 1–4（以太网）",
    "新增 TAU1 端口 fe1、fe2、ge1（以太网）",
    "新增 TAU1 端口 console（串口）",
    "新增 平台服务器 端口 ttyACM0（串口）",
    "连接 S5735 1 口 ↔ TAU1 fe1（业务）",
    "连接 TAU1 console ↔ 平台服务器 ttyACM0（控制）",
    "TAU1 的 Luci 接口所经端口",
    "TAU1 的 串口 接口所经端口",
  ]);
  const serialPath = preview.changes.find((change) => change.text === "TAU1 的 串口 接口所经端口")!;
  assert.deepEqual([serialPath.before, serialPath.after], ["未指定", "console（按串口自动识别） ↔ 平台服务器 ttyACM0"]);

  const applied = await f.catalog.applyPhysicalLabChanges(f.product.id, preview);
  assert.deepEqual(applied, preview.changes);
  const lab = await f.catalog.getPhysicalLab(f.product.id);
  assert.equal(lab.rules, "控制面 VLAN 176，场景不得修改");
  assert.equal(lab.links.length, 2);
  const tauNode = lab.nodes.find((node) => node.id === f.tau.id)!;
  assert.equal(tauNode.ports.find((port) => port.id === tauNode.controlPorts[f.tau.controlInterfaces[0].id])?.name, "fe1");
});

test("a confirmed lab preview is refused once the lab it describes has changed", async (t) => {
  const f = await fixture(t);
  await f.catalog.applyPhysicalLabChanges(f.product.id, await f.catalog.previewPhysicalLabChanges(f.product.id, cabling));

  const unrelated = await f.catalog.previewPhysicalLabChanges(f.product.id, [{ op: "disconnect", node: "S5735", port: "1" }]);
  const stale = await f.catalog.previewPhysicalLabChanges(f.product.id, [{ op: "update_link", node: "TAU1", port: "console", note: "USB 转串口" }]);
  const current = await f.catalog.getPhysicalLab(f.product.id);
  await f.catalog.updatePhysicalLab(f.product.id, {
    ...current,
    nodes: [...current.nodes, { id: "office", kind: "external", name: "办公网", ports: [], controlPorts: {} }],
    links: current.links.map((link) => link.role === "control" ? { ...link, note: "有人先改了备注" } : link),
  });
  await assert.rejects(f.catalog.applyPhysicalLabChanges(f.product.id, stale), (error: CatalogError) => error.status === 409 && /物理环境已变化/.test(error.message));
  await f.catalog.applyPhysicalLabChanges(f.product.id, unrelated);
  const lab = await f.catalog.getPhysicalLab(f.product.id);
  assert.equal(lab.links.length, 1, "an edit elsewhere in the lab does not block an unrelated change");
  assert.ok(lab.nodes.some((node) => node.name === "办公网"));
});

test("lab operations explain what is wrong and which operation failed", async (t) => {
  const f = await fixture(t);
  await f.catalog.applyPhysicalLabChanges(f.product.id, await f.catalog.previewPhysicalLabChanges(f.product.id, cabling));
  const preview = (operations: LabOperation[]) => f.catalog.previewPhysicalLabChanges(f.product.id, operations);
  await assert.rejects(preview([{ op: "add_ports", node: "S5735", ports: "5" }, { op: "connect", a: { node: "S5735", port: "5" }, b: { node: "TAU1", port: "fe1" } }]), /第 2 项操作（connect）：TAU1 fe1 已接 S5735 1 口，需要先断开/);
  await assert.rejects(preview([{ op: "connect", a: { node: "S5735", port: "2" }, b: { node: "TAU2", port: "fe1" } }]), /物理环境中没有节点“TAU2”/);
  await assert.rejects(preview([{ op: "disconnect", node: "S5735", port: "9" }]), /“S5735”没有端口“9”/);
  await assert.rejects(preview([{ op: "add_ports", node: "S5735", ports: "console", kind: "serial" }, { op: "connect", a: { node: "S5735", port: "2" }, b: { node: "S5735", port: "console" } }]), /“S5735 2”是以太网口，不能连接串口“S5735 console”/);
  await assert.rejects(preview([{ op: "set_rules", rules: "控制面 VLAN 176，场景不得修改" }]), /不会改变物理环境/);
  await assert.rejects(preview([{ op: "remove_node", node: "S5735" }]), /只能删除外部节点/);
  await assert.rejects(preview([{ op: "rename_node", node: "TAU1", name: "TAU-A" }]), /请修改设备名称/);
  await assert.rejects(preview([{ op: "set_control_port", node: "S5735", controlInterfaceId: "x", port: "1" }]), /没有控制接口/);
  await assert.rejects(preview([{ op: "add_node", name: "S5735" }]), /与其他设备或节点重复/);
  await assert.rejects(preview([]), /单次须包含 1 至 200 项操作/);

  const removal = await preview([{ op: "remove_ports", node: "TAU1", ports: "fe1, console" }]);
  assert.deepEqual(removal.changes.map((change) => change.text), [
    "删除 TAU1 端口 fe1、console",
    "断开 S5735 1 口 ↔ TAU1 fe1（业务）",
    "断开 TAU1 console ↔ 平台服务器 ttyACM0（控制）",
    "TAU1 的 Luci 接口所经端口",
    "TAU1 的 串口 接口所经端口",
  ]);
});

test("the assistant reads the lab by name with cables and control paths but no secrets", async (t) => {
  const f = await fixture(t);
  await f.catalog.applyPhysicalLabChanges(f.product.id, await f.catalog.previewPhysicalLabChanges(f.product.id, cabling));
  const lab = await f.catalog.getPhysicalLab(f.product.id);
  const devices = await f.catalog.listDeviceResources(f.product.id);
  const view = describeLabForAssistant(lab, devices) as { rules: string; nodes: Array<{ name: string; type?: string; ports: Array<Record<string, unknown>>; controlInterfaces?: Array<Record<string, unknown>> }> };
  assert.equal(JSON.stringify(view).includes("secret"), false);
  assert.equal(view.rules, "控制面 VLAN 176，场景不得修改");
  const tau = view.nodes.find((node) => node.name === "TAU1")!;
  assert.deepEqual(tau.ports.find((port) => port.name === "fe1"), { name: "fe1", kind: "ethernet", to: { node: "S5735", port: "1" }, role: "data" });
  assert.deepEqual(tau.ports.find((port) => port.name === "fe2"), { name: "fe2", kind: "ethernet" });
  assert.deepEqual(tau.controlInterfaces, [
    { id: f.tau.controlInterfaces[0].id, name: "Luci", kind: "web", address: "http://192.168.176.2/", port: "fe1", band: "带内", via: "S5735 1 口" },
    { id: f.tau.controlInterfaces[1].id, name: "串口", kind: "serial", address: "/dev/ttyACM0 · 115200 8N1", port: "console", portFoundBy: "串口地址与平台串口接线自动识别", band: "带外", via: "平台服务器 ttyACM0" },
  ]);
  const single = describeLabForAssistant(lab, devices, "s5735") as { nodes: unknown[] };
  assert.equal(single.nodes.length, 1);
  assert.throws(() => describeLabForAssistant(lab, devices, "TAU9"), /没有节点“TAU9”/);
});

test("the assistant proposes lab changes that are saved only after confirmation", async (t) => {
  const f = await fixture(t);
  const conversation = await f.store.create(f.product.id);
  await f.store.startTurn(f.product.id, conversation.id, "登记接线", "lab-run", { page: "resources", title: "物理环境" });
  const tools = createAssistantTools({ catalog: f.catalog, store: f.store, productId: f.product.id, conversationId: conversation.id, runId: "lab-run", context: { page: "resources", title: "物理环境" }, isCancelled: () => false });
  const propose = tools.find((tool) => tool.name === "platform_propose_lab")!;
  const output = await propose.execute("call", { summary: "登记 TAU1 接线", operations: cabling } as never, undefined, undefined, {} as never);
  const reply = JSON.parse((output.content[0] as { text: string }).text) as { status: string; changes: string[] };
  assert.equal(reply.status, "pending");
  assert.ok(reply.changes.includes("TAU1 的 串口 接口所经端口：未指定 → console（按串口自动识别） ↔ 平台服务器 ttyACM0"));
  assert.equal((await f.catalog.getPhysicalLab(f.product.id)).links.length, 0, "nothing is saved before the person confirms");
  const read = tools.find((tool) => tool.name === "platform_lab")!;
  assert.ok((await read.execute("call", {} as never, undefined, undefined, {} as never)).content[0]);
  await f.store.finishTurn(f.product.id, conversation.id, "lab-run", "请确认");

  const app = express();
  app.use(express.json());
  app.use("/api", createAssistantRouter({ catalog: f.catalog, store: f.store, startTurn: async () => { throw new Error("Not needed in this test"); } }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(error instanceof CatalogError ? error.status : 500).json({ error: error instanceof Error ? error.message : "error" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  const [proposal] = (await f.store.get(f.product.id, conversation.id)).proposals;
  assert.equal(proposal.target, "lab");
  const response = await fetch(`http://127.0.0.1:${port}/api/products/${f.product.id}/assistant/conversations/${conversation.id}/proposals/${proposal.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "apply" }) });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { proposals: Array<{ status: string }> }).proposals[0].status, "applied");
  assert.equal((await f.catalog.getPhysicalLab(f.product.id)).links.length, 2);
});

test("port lists are shortened into ranges", () => {
  assert.equal(compactPortNames(["1", "2", "3", "4", "fe1", "fe2", "ge1", "ge2", "ge3", "console", "07", "08", "09"]), "1–4、fe1、fe2、ge1–3、console、07–09");
  assert.equal(compactPortNames(["1", "3", "5"]), "1、3、5");
});
