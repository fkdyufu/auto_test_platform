import { randomUUID } from "node:crypto";
import { CatalogError } from "./catalog-store.js";
import type { LabChange, LabOperation, LabPortRef } from "../shared/assistant.js";
import { CONTROL_KINDS, controlSummary, type ControlInterface } from "../shared/control-interfaces.js";
import { checkPhysicalLab, describeLabIssue } from "../shared/lab-checks.js";
import {
  LAB_LINK_ROLES,
  LAB_LINK_ROLE_LABELS,
  LAB_PORT_KINDS,
  LAB_PORT_KIND_LABELS,
  defaultLinkRole,
  endLabel,
  expandPortNames,
  findLinkAt,
  otherEnd,
  resolveControlPath,
  type LabLink,
  type LabLinkEnd,
  type LabNode,
  type LabPort,
  type PhysicalLab,
} from "../shared/physical-lab.js";

export type LabContent = Pick<PhysicalLab, "rules" | "nodes" | "links">;
export type LabDevice = { id: string; name: string; templateName?: string; controlInterfaces: Pick<ControlInterface, "id" | "name" | "kind" | "settings">[] };

export const MAX_LAB_OPERATIONS = 200;

function findNode(lab: LabContent, ref: unknown): LabNode {
  const text = typeof ref === "string" ? ref.trim() : "";
  if (!text) throw new CatalogError("缺少节点名称");
  const lower = text.toLowerCase();
  const node = lab.nodes.find((item) => item.name.toLowerCase() === lower) || lab.nodes.find((item) => item.id === text);
  if (!node) throw new CatalogError(`物理环境中没有节点“${text}”`);
  return node;
}

function findNodePort(node: LabNode, ref: unknown): LabPort {
  const text = typeof ref === "string" ? ref.trim() : "";
  if (!text) throw new CatalogError(`缺少“${node.name}”的端口名`);
  // "10 口" is how the lab labels numbered ports.
  const candidates = [text, text.replace(/^(\d+)\s*口$/, "$1")].map((item) => item.toLowerCase());
  const port = node.ports.find((item) => candidates.includes(item.name.toLowerCase())) || node.ports.find((item) => item.id === text);
  if (!port) throw new CatalogError(`“${node.name}”没有端口“${text}”`);
  return port;
}

function findEnd(lab: LabContent, ref: LabPortRef | undefined): LabLinkEnd {
  const node = findNode(lab, ref?.node);
  return { nodeId: node.id, portId: findNodePort(node, ref?.port).id };
}

function touches(link: LabLink, end: LabLinkEnd): boolean {
  return [link.a, link.b].some((side) => side.nodeId === end.nodeId && side.portId === end.portId);
}

function text(value: unknown, label: string, maxLength: number): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new CatalogError(`${label}格式不正确`);
  if (value.trim().length > maxLength) throw new CatalogError(`${label}不能超过 ${maxLength} 个字符`);
  return value.trim();
}

function portKind(value: unknown): LabPort["kind"] {
  if (!LAB_PORT_KINDS.includes(value as LabPort["kind"])) throw new CatalogError(`端口类型须为 ${LAB_PORT_KINDS.join("/")}`);
  return value as LabPort["kind"];
}

function linkRole(value: unknown): LabLink["role"] {
  if (!LAB_LINK_ROLES.includes(value as LabLink["role"])) throw new CatalogError(`连线用途须为 ${LAB_LINK_ROLES.join("/")}`);
  return value as LabLink["role"];
}

function applyOperation(lab: LabContent, operation: LabOperation, devices: Map<string, LabDevice>): void {
  switch (operation.op) {
    case "add_ports": {
      const node = findNode(lab, operation.node);
      const names = expandPortNames(text(operation.ports, "端口名", 4_000));
      if (!names.length) throw new CatalogError("缺少端口名");
      const existing = new Set(node.ports.map((port) => port.name.toLowerCase()));
      const fresh = names.filter((name) => !existing.has(name.toLowerCase()));
      if (!fresh.length) throw new CatalogError(`“${node.name}”已有这些端口`);
      if (fresh.some((name) => name.length > 60)) throw new CatalogError("端口名不能超过 60 个字符");
      const kind = operation.kind === undefined ? "ethernet" : portKind(operation.kind);
      const note = text(operation.note, "端口备注", 200);
      node.ports.push(...fresh.map((name) => ({ id: randomUUID(), name, kind, note })));
      return;
    }
    case "remove_ports": {
      const node = findNode(lab, operation.node);
      const names = expandPortNames(text(operation.ports, "端口名", 4_000));
      if (!names.length) throw new CatalogError("缺少端口名");
      const removed = new Set(names.map((name) => findNodePort(node, name).id));
      node.ports = node.ports.filter((port) => !removed.has(port.id));
      node.controlPorts = Object.fromEntries(Object.entries(node.controlPorts).filter(([, portId]) => !removed.has(portId)));
      lab.links = lab.links.filter((link) => ![link.a, link.b].some((end) => end.nodeId === node.id && removed.has(end.portId)));
      return;
    }
    case "update_port": {
      const node = findNode(lab, operation.node);
      const port = findNodePort(node, operation.port);
      if (operation.name === undefined && operation.kind === undefined && operation.note === undefined) throw new CatalogError("没有要修改的端口内容");
      if (operation.name !== undefined) {
        const name = text(operation.name, "端口名", 60);
        if (!name) throw new CatalogError("端口名不能为空");
        if (node.ports.some((item) => item.id !== port.id && item.name.toLowerCase() === name.toLowerCase())) throw new CatalogError(`“${node.name}”已有端口“${name}”`);
        port.name = name;
      }
      if (operation.kind !== undefined) port.kind = portKind(operation.kind);
      if (operation.note !== undefined) port.note = text(operation.note, "端口备注", 200);
      return;
    }
    case "connect": {
      const a = findEnd(lab, operation.a);
      const b = findEnd(lab, operation.b);
      for (const end of [a, b]) {
        const existing = findLinkAt(lab, end);
        if (existing) throw new CatalogError(`${endLabel(lab, end)} 已接 ${endLabel(lab, otherEnd(existing, end))}，需要先断开`);
      }
      const kind = lab.nodes.find((node) => node.id === a.nodeId)!.ports.find((port) => port.id === a.portId)!.kind;
      lab.links.push({ id: randomUUID(), a, b, role: operation.role === undefined ? defaultLinkRole(kind) : linkRole(operation.role), note: text(operation.note, "连线备注", 300) });
      return;
    }
    case "disconnect": {
      const node = findNode(lab, operation.node);
      const end = { nodeId: node.id, portId: findNodePort(node, operation.port).id };
      if (!findLinkAt(lab, end)) throw new CatalogError(`${endLabel(lab, end)} 没有接线`);
      lab.links = lab.links.filter((link) => !touches(link, end));
      return;
    }
    case "update_link": {
      const node = findNode(lab, operation.node);
      const end = { nodeId: node.id, portId: findNodePort(node, operation.port).id };
      const link = findLinkAt(lab, end);
      if (!link) throw new CatalogError(`${endLabel(lab, end)} 没有接线`);
      if (operation.role === undefined && operation.note === undefined) throw new CatalogError("没有要修改的连线内容");
      if (operation.role !== undefined) link.role = linkRole(operation.role);
      if (operation.note !== undefined) link.note = text(operation.note, "连线备注", 300);
      return;
    }
    case "set_control_port": {
      const node = findNode(lab, operation.node);
      const device = devices.get(node.id);
      if (node.kind !== "device" || !device) throw new CatalogError(`“${node.name}”不是设备，没有控制接口`);
      const reference = text(operation.controlInterfaceId, "控制接口 ID", 100);
      const control = device.controlInterfaces.find((item) => item.id === reference)
        || device.controlInterfaces.find((item) => item.name && item.name.toLowerCase() === reference.toLowerCase());
      if (!control) throw new CatalogError(`“${node.name}”没有控制接口“${reference}”`);
      if (operation.port?.trim()) node.controlPorts[control.id] = findNodePort(node, operation.port).id;
      else delete node.controlPorts[control.id];
      return;
    }
    case "set_rules":
      if (typeof operation.rules !== "string") throw new CatalogError("缺少环境规则内容");
      lab.rules = text(operation.rules, "环境规则", 10_000);
      return;
    case "add_node": {
      const name = text(operation.name, "节点名称", 60);
      if (!name) throw new CatalogError("节点名称不能为空");
      lab.nodes.push({ id: randomUUID(), kind: "external", name, ports: [], controlPorts: {} });
      return;
    }
    case "rename_node": {
      const node = findNode(lab, operation.node);
      if (node.kind === "device") throw new CatalogError(`“${node.name}”是设备，请修改设备名称`);
      const name = text(operation.name, "节点名称", 60);
      if (!name) throw new CatalogError("节点名称不能为空");
      node.name = name;
      return;
    }
    case "remove_node": {
      const node = findNode(lab, operation.node);
      if (node.kind !== "external") throw new CatalogError(`只能删除外部节点，“${node.name}”不是外部节点`);
      lab.nodes = lab.nodes.filter((item) => item.id !== node.id);
      lab.links = lab.links.filter((link) => link.a.nodeId !== node.id && link.b.nodeId !== node.id);
      return;
    }
    default:
      throw new CatalogError("操作类型不正确");
  }
}

/** Applies the operations in order to a copy of the lab. Node and port names are matched case-insensitively. */
export function applyLabOperations(lab: LabContent, operations: LabOperation[], devices: LabDevice[]): LabContent {
  if (!Array.isArray(operations) || !operations.length || operations.length > MAX_LAB_OPERATIONS) {
    throw new CatalogError(`单次须包含 1 至 ${MAX_LAB_OPERATIONS} 项操作`);
  }
  const next = structuredClone({ rules: lab.rules, nodes: lab.nodes, links: lab.links });
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  operations.forEach((operation, index) => {
    try {
      if (!operation || typeof operation !== "object") throw new CatalogError("操作格式不正确");
      applyOperation(next, operation, deviceById);
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      throw new CatalogError(`第 ${index + 1} 项操作（${operation?.op || "未知"}）：${error.message}`, error.status);
    }
  });
  return next;
}

/** ["1", "2", "3", "fe1", "fe2", "console"] -> "1–3、fe1–2、console" */
export function compactPortNames(names: string[]): string {
  const parts: string[] = [];
  let index = 0;
  while (index < names.length) {
    const match = /^(.*?)(\d+)$/.exec(names[index]);
    let end = index;
    if (match) {
      while (end + 1 < names.length) {
        const next = /^(.*?)(\d+)$/.exec(names[end + 1]);
        if (!next || next[1] !== match[1] || Number(next[2]) !== Number(match[2]) + (end + 1 - index)) break;
        end += 1;
      }
    }
    parts.push(end - index >= 2 ? `${names[index]}–${/^(.*?)(\d+)$/.exec(names[end])![2]}` : names.slice(index, end + 1).join("、"));
    index = end + 1;
  }
  return parts.join("、");
}

const portText = (port: LabPort) => `${port.name}（${LAB_PORT_KIND_LABELS[port.kind]}${port.note ? `，${port.note}` : ""}）`;
const linkText = (link: LabLink) => `${LAB_LINK_ROLE_LABELS[link.role]}${link.note ? `，${link.note}` : ""}`;
const linkKey = (link: LabLink) => [link.a, link.b].map((end) => `${end.nodeId}\u0000${end.portId}`).sort().join("\u0001");

/** What changes between two views of the same lab, worded for the person confirming it. */
export function diffPhysicalLab(before: LabContent, after: LabContent, devices: LabDevice[]): LabChange[] {
  const changes: LabChange[] = [];
  if (before.rules !== after.rules) changes.push({ type: "update", text: "修改环境规则", before: before.rules || "（空）", after: after.rules || "（空）" });

  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  for (const node of before.nodes) if (!afterNodes.has(node.id)) changes.push({ type: "remove", text: `删除外部节点 ${node.name}` });
  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id);
    if (!previous) {
      changes.push({ type: "add", text: `新增外部节点 ${node.name}` });
    } else if (previous.name !== node.name) {
      changes.push({ type: "update", text: `重命名${node.kind === "platform" ? "平台节点" : "外部节点"}`, before: previous.name, after: node.name });
    }
    const previousPorts = new Map((previous?.ports || []).map((port) => [port.id, port]));
    const currentPorts = new Map(node.ports.map((port) => [port.id, port]));
    const added = node.ports.filter((port) => !previousPorts.has(port.id));
    for (const kind of LAB_PORT_KINDS) {
      const names = added.filter((port) => port.kind === kind).map((port) => port.name);
      if (names.length) changes.push({ type: "add", text: `新增 ${node.name} 端口 ${compactPortNames(names)}（${LAB_PORT_KIND_LABELS[kind]}）` });
    }
    const removed = (previous?.ports || []).filter((port) => !currentPorts.has(port.id)).map((port) => port.name);
    if (removed.length) changes.push({ type: "remove", text: `删除 ${node.name} 端口 ${compactPortNames(removed)}` });
    for (const port of node.ports) {
      const old = previousPorts.get(port.id);
      if (old && portText(old) !== portText(port)) changes.push({ type: "update", text: `修改 ${node.name} 端口 ${old.name}`, before: portText(old), after: portText(port) });
    }
  }

  const beforeLinks = new Map(before.links.map((link) => [linkKey(link), link]));
  const afterLinks = new Map(after.links.map((link) => [linkKey(link), link]));
  for (const [key, link] of beforeLinks) {
    if (!afterLinks.has(key)) changes.push({ type: "remove", text: `断开 ${endLabel(before, link.a)} ↔ ${endLabel(before, link.b)}（${linkText(link)}）` });
  }
  for (const [key, link] of afterLinks) {
    const old = beforeLinks.get(key);
    if (!old) changes.push({ type: "add", text: `连接 ${endLabel(after, link.a)} ↔ ${endLabel(after, link.b)}（${linkText(link)}）` });
    else if (linkText(old) !== linkText(link)) changes.push({ type: "update", text: `修改连线 ${endLabel(after, link.a)} ↔ ${endLabel(after, link.b)}`, before: linkText(old), after: linkText(link) });
  }

  const route = (lab: LabContent, nodeId: string, control: LabDevice["controlInterfaces"][number]) => {
    const path = resolveControlPath(lab, nodeId, control);
    const port = path.portId ? lab.nodes.find((node) => node.id === nodeId)?.ports.find((item) => item.id === path.portId) : undefined;
    return {
      key: `${path.portId || ""}\u0000${path.source || ""}`,
      text: port ? `${port.name}${path.source === "serial" ? "（按串口自动识别）" : ""}${path.peer ? ` ↔ ${endLabel(lab, path.peer)}` : "（未接线）"}` : "未指定",
    };
  };
  for (const device of devices) {
    if (!afterNodes.has(device.id) || !beforeNodes.has(device.id)) continue;
    for (const control of device.controlInterfaces) {
      const old = route(before, device.id, control);
      const current = route(after, device.id, control);
      if (old.key !== current.key) {
        changes.push({ type: "update", text: `${device.name} 的 ${control.name || CONTROL_KINDS[control.kind].label} 接口所经端口`, before: old.text, after: current.text });
      }
    }
  }
  return changes;
}

const MAX_READ_SIZE = 100_000;

/** The lab as the assistant reads it: names it can use in operations, each port's cable, and control paths. No secrets. */
export function describeLabForAssistant(lab: PhysicalLab, devices: LabDevice[], nodeRef?: string): Record<string, unknown> {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const nodes = nodeRef?.trim() ? [findNode(lab, nodeRef)] : lab.nodes;
  const describeNode = (node: LabNode) => {
    const device = deviceById.get(node.id);
    return {
      id: node.id,
      kind: node.kind,
      name: node.name,
      ...(device?.templateName ? { type: device.templateName } : {}),
      ports: node.ports.map((port) => {
        const end = { nodeId: node.id, portId: port.id };
        const link = findLinkAt(lab, end);
        const far = link && otherEnd(link, end);
        const peer = far && lab.nodes.find((item) => item.id === far.nodeId);
        return {
          name: port.name,
          kind: port.kind,
          ...(port.note ? { note: port.note } : {}),
          ...(link && peer ? { to: { node: peer.name, port: peer.ports.find((item) => item.id === far.portId)?.name || "" }, role: link.role, ...(link.note ? { linkNote: link.note } : {}) } : {}),
        };
      }),
      ...(device ? {
        controlInterfaces: device.controlInterfaces.map((control) => {
          const path = resolveControlPath(lab, node.id, control);
          const port = path.portId ? node.ports.find((item) => item.id === path.portId) : undefined;
          return {
            id: control.id,
            name: control.name || CONTROL_KINDS[control.kind].label,
            kind: control.kind,
            address: controlSummary(control),
            ...(port ? {
              port: port.name,
              ...(path.source === "serial" ? { portFoundBy: "串口地址与平台串口接线自动识别" } : {}),
              ...(path.band ? { band: path.band === "out-of-band" ? "带外" : "带内" } : {}),
              ...(path.peer ? { via: endLabel(lab, path.peer) } : {}),
              ...(path.addressMatches === false ? { warning: "串口地址与连线不一致" } : {}),
            } : {}),
          };
        }),
      } : {}),
    };
  };
  const issues = checkPhysicalLab(lab, devices).filter((issue) => nodes.some((node) => node.id === issue.nodeId)).map(describeLabIssue);
  const full = { updatedAt: lab.updatedAt, rules: lab.rules, ...(issues.length ? { issues } : {}), nodes: nodes.map(describeNode) };
  if (nodeRef?.trim() || JSON.stringify(full).length <= MAX_READ_SIZE) return full;
  return {
    updatedAt: lab.updatedAt,
    rules: lab.rules,
    ...(issues.length ? { issues } : {}),
    message: "物理环境较大，以下只列出节点概要；用 node 参数逐个读取节点的端口和接线",
    nodes: lab.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      name: node.name,
      ports: node.ports.length,
      linkedPorts: node.ports.filter((port) => findLinkAt(lab, { nodeId: node.id, portId: port.id })).length,
    })),
  };
}
