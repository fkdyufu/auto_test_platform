import type { ControlInterface } from "./control-interfaces.js";

export type LabPortKind = "ethernet" | "serial" | "usb" | "power" | "rf" | "other";
export type LabLinkRole = "data" | "control" | "power";
export type LabNodeKind = "device" | "platform" | "external";

export interface LabPort {
  id: string;
  name: string;
  kind: LabPortKind;
  note: string;
}

export interface LabNode {
  /** Device nodes reuse the device ID; the platform node is always `platform`. */
  id: string;
  kind: LabNodeKind;
  name: string;
  ports: LabPort[];
  /** Control interface ID -> port ID the platform reaches it through. */
  controlPorts: Record<string, string>;
}

export interface LabLinkEnd {
  nodeId: string;
  portId: string;
}

export interface LabLink {
  id: string;
  a: LabLinkEnd;
  b: LabLinkEnd;
  role: LabLinkRole;
  note: string;
}

export interface PhysicalLab {
  productId: string;
  rules: string;
  nodes: LabNode[];
  links: LabLink[];
  updatedAt: string;
}

export type LabControlInterface = Pick<ControlInterface, "id" | "name" | "kind" | "settings">;

export const PLATFORM_NODE_ID = "platform";
export const DEFAULT_PLATFORM_NAME = "平台服务器";

export const LAB_PORT_KINDS: LabPortKind[] = ["ethernet", "serial", "usb", "power", "rf", "other"];
export const LAB_LINK_ROLES: LabLinkRole[] = ["data", "control", "power"];

export const LAB_PORT_KIND_LABELS: Record<LabPortKind, string> = {
  ethernet: "以太网",
  serial: "串口",
  usb: "USB",
  power: "电源",
  rf: "射频",
  other: "其他",
};

export const LAB_CABLE_LABELS: Record<LabPortKind, string> = {
  ethernet: "网线",
  serial: "串口线",
  usb: "USB 线",
  power: "电源线",
  rf: "射频线",
  other: "线缆",
};

export const LAB_LINK_ROLE_LABELS: Record<LabLinkRole, string> = {
  data: "业务",
  control: "控制",
  power: "供电",
};

/** "1-16, fe1-2, console" -> 1…16, fe1, fe2, console. A trailing numeric range expands; other text is kept as is. */
export function expandPortNames(input: string): string[] {
  const names: string[] = [];
  for (const token of input.split(/[\s,，、;；]+/).map((item) => item.trim()).filter(Boolean)) {
    const match = /^(.*?)(\d+)-(\d+)$/.exec(token);
    if (match) {
      const [, prefix, startText, endText] = match;
      const start = Number(startText);
      const end = Number(endText);
      if (end > start && end - start < 256) {
        const width = startText.length > 1 && startText.startsWith("0") ? startText.length : 0;
        for (let value = start; value <= end; value += 1) names.push(`${prefix}${String(value).padStart(width, "0")}`);
        continue;
      }
    }
    names.push(token);
  }
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `other` ports accept any cable; every other kind only connects to its own kind. */
export function portKindsCompatible(left: LabPortKind, right: LabPortKind): boolean {
  return left === right || left === "other" || right === "other";
}

export function defaultLinkRole(kind: LabPortKind): LabLinkRole {
  if (kind === "power") return "power";
  if (kind === "serial" || kind === "usb") return "control";
  return "data";
}

export function sameEnd(left: LabLinkEnd, right: LabLinkEnd): boolean {
  return left.nodeId === right.nodeId && left.portId === right.portId;
}

export function findLinkAt(lab: Pick<PhysicalLab, "links">, end: LabLinkEnd): LabLink | undefined {
  return lab.links.find((link) => sameEnd(link.a, end) || sameEnd(link.b, end));
}

export function otherEnd(link: LabLink, end: LabLinkEnd): LabLinkEnd {
  return sameEnd(link.a, end) ? link.b : link.a;
}

export function findPort(lab: Pick<PhysicalLab, "nodes">, end: LabLinkEnd): { node: LabNode; port: LabPort } | undefined {
  const node = lab.nodes.find((item) => item.id === end.nodeId);
  const port = node?.ports.find((item) => item.id === end.portId);
  return node && port ? { node, port } : undefined;
}

export function endLabel(lab: Pick<PhysicalLab, "nodes">, end: LabLinkEnd): string {
  const found = findPort(lab, end);
  if (!found) return "未知端口";
  return `${found.node.name} ${/^\d+$/.test(found.port.name) ? `${found.port.name} 口` : found.port.name}`;
}

/** `/dev/ttyACM0?baudRate=115200` -> `ttyACM0`; `COM3` -> `COM3`. */
export function serialDeviceName(address: string): string {
  const path = address.split("?")[0].trim();
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

export type ControlBand = "in-band" | "out-of-band";

export interface ControlPath {
  portId?: string;
  /** How the port was found: picked by a person, or matched from a serial address and the platform's cabling. */
  source?: "manual" | "serial";
  band?: ControlBand;
  /** The far end of the cable on the chosen port. */
  peer?: LabLinkEnd;
  /** For serial interfaces: whether the address names the platform port this cable reaches. */
  addressMatches?: boolean;
}

export function controlBand(kind: LabPortKind): ControlBand | undefined {
  if (kind === "serial" || kind === "usb") return "out-of-band";
  if (kind === "ethernet") return "in-band";
  return undefined;
}

export function resolveControlPath(lab: Pick<PhysicalLab, "nodes" | "links">, nodeId: string, control: LabControlInterface): ControlPath {
  const node = lab.nodes.find((item) => item.id === nodeId);
  if (!node) return {};
  let portId = node.controlPorts[control.id];
  let source: ControlPath["source"] = portId && node.ports.some((port) => port.id === portId) ? "manual" : undefined;
  if (!source) portId = "";
  const serialName = control.kind === "serial" ? serialDeviceName(control.settings.device || "").toLowerCase() : "";
  const platform = lab.nodes.find((item) => item.kind === "platform");
  if (!source && serialName && platform) {
    const platformPort = platform.ports.find((port) => port.name.toLowerCase() === serialName);
    const link = platformPort && findLinkAt(lab, { nodeId: platform.id, portId: platformPort.id });
    const peer = link && platformPort && otherEnd(link, { nodeId: platform.id, portId: platformPort.id });
    if (peer?.nodeId === nodeId) {
      portId = peer.portId;
      source = "serial";
    }
  }
  if (!source || !portId) return {};
  const port = node.ports.find((item) => item.id === portId)!;
  const link = findLinkAt(lab, { nodeId, portId });
  const peer = link ? otherEnd(link, { nodeId, portId }) : undefined;
  let addressMatches: boolean | undefined;
  if (serialName && peer && platform && peer.nodeId === platform.id) {
    addressMatches = platform.ports.find((item) => item.id === peer.portId)?.name.toLowerCase() === serialName;
  }
  return { portId, source, band: controlBand(port.kind), peer, addressMatches };
}
