import assert from "node:assert/strict";
import test from "node:test";
import { checkPhysicalLab, describeLabIssue, type LabCheckDevice } from "../shared/lab-checks.js";
import type { LabNode, PhysicalLab } from "../shared/physical-lab.js";

const port = (name: string, kind: LabNode["ports"][number]["kind"] = "ethernet", note = "") => ({ id: `${name}-id`, name, kind, note });

function wkcj(): { lab: Pick<PhysicalLab, "nodes" | "links">; devices: LabCheckDevice[] } {
  const devices: LabCheckDevice[] = [
    { id: "host1", name: "host1", controlInterfaces: [{ id: "host1-ssh", name: "控制端口", kind: "ssh", settings: { host: "192.168.176.11" } }] },
    { id: "switch", name: "switch", controlInterfaces: [{ id: "switch-telnet", name: "主控制", kind: "telnet", settings: { host: "192.168.176.1" } }] },
    {
      id: "tau1",
      name: "TAU1",
      controlInterfaces: [
        { id: "tau1-web", name: "Luci", kind: "web", settings: { url: "http://192.168.176.2/cgi-bin/luci/" } },
        { id: "tau1-serial", name: "", kind: "serial", settings: { device: "/dev/ttyACM0" } },
      ],
    },
    { id: "tau2", name: "TAU2", controlInterfaces: [{ id: "tau2-ssh", name: "ssh", kind: "ssh", settings: { host: "192.168.176.3" } }] },
    { id: "spare", name: "spare", controlInterfaces: [] },
  ];
  const nodes: LabNode[] = [
    { id: "host1", kind: "device", name: "host1", ports: [port("console", "ethernet", "Control NIC 192.168.176.11/24")], controlPorts: { "host1-ssh": "console-id" } },
    { id: "switch", kind: "device", name: "switch", ports: [port("12"), port("15"), port("16")], controlPorts: {} },
    { id: "tau1", kind: "device", name: "TAU1", ports: [port("GE2"), port("FE1")], controlPorts: {} },
    { id: "tau2", kind: "device", name: "TAU2", ports: [port("GE2")], controlPorts: {} },
    { id: "spare", kind: "device", name: "spare", ports: [], controlPorts: {} },
    { id: "platform", kind: "platform", name: "平台服务器", ports: [port("control")], controlPorts: {} },
  ];
  const link = (id: string, a: [string, string], b: [string, string], note = "") => ({ id, a: { nodeId: a[0], portId: `${a[1]}-id` }, b: { nodeId: b[0], portId: `${b[1]}-id` }, role: "data" as const, note });
  return {
    devices,
    lab: {
      nodes,
      links: [
        link("l1", ["tau1", "GE2"], ["switch", "12"], "DUT GE2 192.168.176.2/24 ↔ switch 12（VLAN 176）"),
        link("l2", ["tau2", "GE2"], ["switch", "15"], "Peer GE2 192.168.176.3/24 ↔ switch 15"),
        link("l3", ["host1", "console"], ["platform", "control"], ""),
      ],
    },
  };
}

test("checks list devices without cables and control interfaces whose path is unknown, with a likely port", () => {
  const { lab, devices } = wkcj();
  const issues = checkPhysicalLab(lab, devices);
  assert.deepEqual(issues.map(describeLabIssue), [
    "switch 的 主控制 接口未指定所经端口",
    "TAU1 的 Luci 接口未指定所经端口（GE2 的连线备注里有 192.168.176.2，可能经 GE2）",
    "平台服务器没有登记串口 ttyACM0，TAU1 的 串口 接口找不到接线",
    "TAU2 的 ssh 接口未指定所经端口（GE2 的连线备注里有 192.168.176.3，可能经 GE2）",
    "spare 还没有登记接线",
  ]);
  assert.deepEqual(issues[1].suggestion, { controlId: "tau1-web", portId: "GE2-id", portName: "GE2", reason: "GE2 的连线备注里有 192.168.176.2" });
});

test("checks follow fixes: a chosen port, a registered serial cable, and wrong serial wiring", () => {
  const { lab, devices } = wkcj();
  const tau1 = lab.nodes.find((node) => node.id === "tau1")!;
  tau1.controlPorts["tau1-web"] = "FE1-id";
  tau1.ports.push(port("console", "serial"));
  const platform = lab.nodes.find((node) => node.id === "platform")!;
  platform.ports.push(port("ttyACM0", "serial"), port("ttyUSB0", "serial"));
  let texts = checkPhysicalLab(lab, devices).map((issue) => issue.text);
  assert.ok(texts.includes("TAU1 的 Luci 接口经 FE1，但 FE1 没有接线"));
  assert.ok(texts.includes("平台服务器 ttyACM0 没有接到 TAU1"));

  lab.links.push({ id: "serial", a: { nodeId: "tau1", portId: "console-id" }, b: { nodeId: "platform", portId: "ttyUSB0-id" }, role: "control", note: "" });
  tau1.controlPorts["tau1-serial"] = "console-id";
  texts = checkPhysicalLab(lab, devices).map((issue) => issue.text);
  assert.ok(texts.includes("TAU1 的 串口 接口地址是 ttyACM0，接线却到 平台服务器 ttyUSB0"));

  lab.links = lab.links.map((link) => link.id === "serial" ? { ...link, b: { nodeId: "platform", portId: "ttyACM0-id" } } : link);
  tau1.controlPorts = { "tau1-web": "GE2-id" };
  texts = checkPhysicalLab(lab, devices).map((issue) => issue.text);
  assert.equal(texts.some((text) => text.startsWith("TAU1")), false, "the serial cable is found from its address and the Web interface has a cabled port");
});

test("checks stay quiet until wiring is registered and do not match a longer address", () => {
  const { lab, devices } = wkcj();
  assert.deepEqual(checkPhysicalLab({ nodes: lab.nodes, links: [] }, devices), []);
  devices[3].controlInterfaces[0].settings.host = "192.168.176.30";
  assert.equal(checkPhysicalLab(lab, devices).find((issue) => issue.nodeId === "tau2")?.suggestion, undefined);
});
