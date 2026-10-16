import type { DeviceResource, PhysicalLab } from "./catalog-store.js";
import {
  LAB_LINK_ROLE_LABELS,
  LAB_PORT_KIND_LABELS,
  endLabel,
  findLinkAt,
  resolveControlPath,
  type LabLinkEnd,
} from "../shared/physical-lab.js";

const MAX_LINES = 300;

type PromptDevice = Pick<DeviceResource, "id" | "name" | "controlInterfaces">;

/**
 * Wiring the agent needs for the devices bound to the current scenario. Returns an empty string when nothing was
 * registered, so prompts for products without a lab stay unchanged.
 */
export function formatPhysicalLab(lab: PhysicalLab | undefined, devices: PromptDevice[]): string {
  if (!lab) return "";
  const focus = new Set(devices.map((device) => device.id));
  const order = new Map<string, number>();
  lab.nodes.forEach((node, nodeIndex) => node.ports.forEach((port, portIndex) => order.set(`${node.id}\u0000${port.id}`, nodeIndex * 10_000 + portIndex)));
  const rank = (end: LabLinkEnd) => order.get(`${end.nodeId}\u0000${end.portId}`) ?? Number.MAX_SAFE_INTEGER;

  const links = lab.links
    .filter((link) => focus.has(link.a.nodeId) || focus.has(link.b.nodeId))
    .map((link) => {
      // Read each cable from the bound device's side.
      const [near, far] = focus.has(link.a.nodeId) && (!focus.has(link.b.nodeId) || rank(link.a) <= rank(link.b)) ? [link.a, link.b] : [link.b, link.a];
      return { link, near, far };
    })
    .sort((left, right) => rank(left.near) - rank(right.near));
  const linkLines = links.map(({ link, near, far }) =>
    `- ${endLabel(lab, near)} ↔ ${endLabel(lab, far)}（${LAB_LINK_ROLE_LABELS[link.role]}${link.note ? `；${link.note}` : ""}）`);

  // A node without any cable is most likely not registered yet, so its ports are not reported as idle.
  const idleLines = lab.nodes
    .filter((node) => focus.has(node.id) && lab.links.some((link) => link.a.nodeId === node.id || link.b.nodeId === node.id))
    .map((node) => {
      const idle = node.ports
        .filter((port) => !findLinkAt(lab, { nodeId: node.id, portId: port.id }))
        .map((port) => port.kind === "ethernet" ? port.name : `${port.name}（${LAB_PORT_KIND_LABELS[port.kind]}）`);
      return idle.length ? `- ${node.name}：${idle.join("、")}` : "";
    })
    .filter(Boolean);

  const controlLines = devices.flatMap((device) => device.controlInterfaces.map((control) => {
    const path = resolveControlPath(lab, device.id, control);
    const port = path.portId ? lab.nodes.find((node) => node.id === device.id)?.ports.find((item) => item.id === path.portId) : undefined;
    if (!port) return "";
    const band = path.band === "out-of-band" ? "带外" : path.band === "in-band" ? "带内，依赖该端口及其 IP/VLAN 配置" : "";
    return `- ${device.name} ${control.name}（${control.type}，接口 ID: ${control.id}）：经 ${port.name}${path.peer ? ` ↔ ${endLabel(lab, path.peer)}` : ""}${band ? `，${band}` : ""}`;
  }).filter(Boolean));

  if (!lab.rules && !linkLines.length) return "";
  const sections = [
    linkLines.length
      ? "物理环境（实验室的实际接线，所有场景共用）：\n接线由人工登记。场景只能通过设备配置改变逻辑拓扑，不能改动接线；没有列出的连接不要假设存在。场景说明中的接线描述与这里不一致时，以这里为准。"
      : "物理环境（所有场景共用）：\n本场景设备的接线尚未登记，接线以场景说明为准。",
    lab.rules && `环境规则：\n${lab.rules}`,
    linkLines.length && `本场景设备的接线：\n${linkLines.slice(0, MAX_LINES).join("\n")}${linkLines.length > MAX_LINES ? `\n（另有 ${linkLines.length - MAX_LINES} 条已省略）` : ""}`,
    links.some(({ link }) => link.role === "control") && "控制连线是平台访问设备的通道。不得关闭这些连线两端的端口，也不得修改其 VLAN、IP 或路由，以免失去控制。",
    idleLines.length && `本场景设备未接线的端口：\n${idleLines.join("\n")}`,
    controlLines.length && `控制接口所经端口：\n${controlLines.join("\n")}`,
  ];
  return sections.filter(Boolean).join("\n\n");
}
