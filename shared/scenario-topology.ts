import { findLinkAt, otherEnd, type LabLink, type LabLinkEnd, type PhysicalLab } from "./physical-lab.js";

/** An interface of a role, as the scenario and its cases name it, and the device port it is mapped to. */
export interface ScenarioInterface {
  id: string;
  roleId: string;
  /** Name used in the scenario and its cases, such as lan or fe1. */
  name: string;
  /** IPv4 address without prefix; empty for an interface that keeps no address, like a mirror destination. */
  address: string;
  /** Port of the role's device; empty until mapped. */
  portId: string;
}

/** One layer-2 domain of the scenario. A point-to-point link is a segment with two interfaces. */
export interface ScenarioSegment {
  id: string;
  name: string;
  /** VLAN the segment uses on the switch; a direct cable needs none. */
  vlan: string;
  /** Address range such as 192.168.181.0/24; empty when no interface has an address. */
  subnet: string;
  interfaces: ScenarioInterface[];
}

export interface TopologyRole {
  id: string;
  key: string;
  deviceId: string;
}

export interface TopologyDevice {
  id: string;
  name: string;
  template: string;
  controlInterfaces: readonly { kind: string; portId?: string }[];
  ports?: readonly { id: string; name: string; kind?: string }[];
}

/** Where a problem is fixed in the scenario editor. */
export type TopologyArea = "topology" | "addresses" | "mapping";

export interface TopologyProblem {
  area: TopologyArea;
  text: string;
}

/**
 * How a mapped port reaches the rest of its segment: into a switch the platform configures, through a switch it does
 * not control on to one it does, or straight to another device.
 */
export type TopologyPath =
  | { kind: "switch"; links: LabLink[]; access: LabLinkEnd }
  | { kind: "via"; links: LabLink[]; via: LabLinkEnd; trunk: LabLinkEnd }
  | { kind: "direct"; links: LabLink[]; peer: LabLinkEnd };

export interface AnalyzedInterface {
  item: ScenarioInterface;
  role?: TopologyRole;
  device?: TopologyDevice;
  portName: string;
  path?: TopologyPath;
  problems: TopologyProblem[];
}

export interface AnalyzedSegment {
  segment: ScenarioSegment;
  interfaces: AnalyzedInterface[];
  problems: TopologyProblem[];
  /** The two interfaces are the two ends of one cable, so no switch is involved. */
  direct: boolean;
}

export interface TopologyInput {
  lab?: Pick<PhysicalLab, "nodes" | "links">;
  roles: readonly TopologyRole[];
  devices: readonly TopologyDevice[];
  segments: readonly ScenarioSegment[];
}

export function ipv4ToNumber(value: string): number | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value.trim());
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return undefined;
  return parts[0] * 16_777_216 + parts[1] * 65_536 + parts[2] * 256 + parts[3];
}

export function parseSubnet(value: string): { network: number; size: number; bits: number } | undefined {
  const [address, length] = value.trim().split("/");
  const base = ipv4ToNumber(address || "");
  const bits = Number(length);
  if (base === undefined || !Number.isInteger(bits) || bits < 1 || bits > 32) return undefined;
  const size = 2 ** (32 - bits);
  return { network: Math.floor(base / size) * size, size, bits };
}

export function inSubnet(address: string, subnet: string): boolean {
  const value = ipv4ToNumber(address);
  const range = parseSubnet(subnet);
  return value !== undefined && range !== undefined && value >= range.network && value < range.network + range.size;
}

export function isVlanId(value: string): boolean {
  return /^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= 4094;
}

const isSwitch = (device?: TopologyDevice) => device?.template === "switch";
const isManagedSwitch = (device?: TopologyDevice) => isSwitch(device) && device!.controlInterfaces.length > 0;
const nodeName = (lab: Pick<PhysicalLab, "nodes">, nodeId: string) => lab.nodes.find((node) => node.id === nodeId)?.name || "未知节点";

export function portLabel(name: string): string {
  return /^\d+$/.test(name) ? `${name} 口` : name;
}

function tracePort(lab: Pick<PhysicalLab, "nodes" | "links">, deviceById: Map<string, TopologyDevice>, end: LabLinkEnd): TopologyPath | { error: string } {
  const link = findLinkAt(lab, end);
  if (!link) return { error: "没有接线" };
  if (link.role === "control") return { error: "是控制通道，不能放进业务网段" };
  const peer = otherEnd(link, end);
  const peerDevice = deviceById.get(peer.nodeId);
  if (!peerDevice) return { error: `接到了${nodeName(lab, peer.nodeId)}，平台无法在上面搭建网段` };
  if (isManagedSwitch(peerDevice)) return { kind: "switch", links: [link], access: peer };
  if (isSwitch(peerDevice)) {
    // A switch the platform does not control passes the segment on to the one switch it does control.
    const uplinks = lab.links.filter((item) => {
      if (item === link) return false;
      const near = item.a.nodeId === peer.nodeId ? item.a : item.b.nodeId === peer.nodeId ? item.b : undefined;
      return near ? isManagedSwitch(deviceById.get(otherEnd(item, near).nodeId)) : false;
    });
    if (uplinks.length !== 1) return { error: `经过 ${peerDevice.name} 后${uplinks.length ? "有多条" : "没有"}通往可配置交换机的线` };
    const near = uplinks[0].a.nodeId === peer.nodeId ? uplinks[0].a : uplinks[0].b;
    return { kind: "via", links: [link, uplinks[0]], via: peer, trunk: otherEnd(uplinks[0], near) };
  }
  return { kind: "direct", links: [link], peer };
}

/** Checks each segment against the roles, the device ports and the registered wiring. */
export function analyzeScenarioTopology({ lab, roles, devices, segments }: TopologyInput): AnalyzedSegment[] {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const portUse = new Map<string, number>();
  for (const segment of segments) {
    for (const item of segment.interfaces) {
      const role = roleById.get(item.roleId);
      if (role && item.portId) portUse.set(`${role.deviceId}\u0000${item.portId}`, (portUse.get(`${role.deviceId}\u0000${item.portId}`) || 0) + 1);
    }
  }
  return segments.map((segment) => {
    const problems: TopologyProblem[] = [];
    const subnet = segment.subnet.trim();
    const addressCount = new Map<string, number>();
    segment.interfaces.forEach((item) => { if (item.address) addressCount.set(item.address, (addressCount.get(item.address) || 0) + 1); });
    const interfaces = segment.interfaces.map((item): AnalyzedInterface => {
      const found: AnalyzedInterface = { item, portName: "", problems: [] };
      const role = roleById.get(item.roleId);
      const label = `${role?.key || "?"} ${item.name}`;
      if (!role) found.problems.push({ area: "topology", text: `${segment.name} 中的接口 ${item.name} 没有对应的角色` });
      const device = role ? deviceById.get(role.deviceId) : undefined;
      Object.assign(found, { role, device });
      if (role && !device) found.problems.push({ area: "mapping", text: `角色 ${role.key} 还没有绑定设备` });
      else if (device && !item.portId) found.problems.push({ area: "mapping", text: `${label} 还没有选择物理端口` });
      else if (device) {
        const port = device.ports?.find((candidate) => candidate.id === item.portId);
        if (!port) found.problems.push({ area: "mapping", text: `${label} 选择的端口已不在 ${device.name} 上` });
        else {
          found.portName = port.name;
          const path = lab ? tracePort(lab, deviceById, { nodeId: device.id, portId: port.id }) : { error: "没有接线" };
          if ("error" in path) found.problems.push({ area: "mapping", text: `${device.name} ${port.name} ${path.error}` });
          else found.path = path;
          if ((portUse.get(`${device.id}\u0000${port.id}`) || 0) > 1) found.problems.push({ area: "mapping", text: `${device.name} ${port.name} 被多个接口占用` });
        }
      }
      if (item.address) {
        if (ipv4ToNumber(item.address) === undefined) found.problems.push({ area: "addresses", text: `${label} 的地址格式不正确` });
        else if (!subnet) found.problems.push({ area: "addresses", text: `${segment.name} 没有填地址范围` });
        else if (parseSubnet(subnet) && !inSubnet(item.address, subnet)) found.problems.push({ area: "addresses", text: `${label} 的地址不在 ${subnet} 内` });
        if ((addressCount.get(item.address) || 0) > 1) found.problems.push({ area: "addresses", text: `${label} 的地址与本网段其他接口重复` });
      }
      return found;
    });
    const direct = interfaces.filter((item) => item.path?.kind === "direct");
    const pair = direct.length === 2 && interfaces.length === 2 && direct.every((item, index) => {
      const other = direct[1 - index];
      return item.path?.kind === "direct" && item.path.peer.nodeId === other.device?.id && item.path.peer.portId === other.item.portId;
    });
    if (direct.length && !pair) {
      for (const item of direct) {
        if (item.path?.kind !== "direct") continue;
        item.problems.push({ area: "mapping", text: `${item.device?.name} ${item.portName} 直连 ${nodeName(lab!, item.path.peer.nodeId)}，只能和对端单独组成网段` });
      }
    }
    if (interfaces.length < 2) problems.push({ area: "topology", text: `${segment.name} 至少需要两个接口` });
    if (!pair) {
      if (!segment.vlan) problems.push({ area: "mapping", text: `${segment.name} 经过交换机，需要 VLAN` });
      else if (!isVlanId(segment.vlan)) problems.push({ area: "mapping", text: `${segment.name} 的 VLAN 须为 1–4094` });
    }
    if (subnet && !parseSubnet(subnet)) problems.push({ area: "addresses", text: `${segment.name} 的地址范围格式应为 192.168.181.0/24` });
    return { segment, interfaces, problems, direct: pair };
  });
}

export function topologyProblems(analysis: readonly AnalyzedSegment[]): TopologyProblem[] {
  return analysis.flatMap((item) => [...item.problems, ...item.interfaces.flatMap((entry) => entry.problems)]);
}

export interface TopologyPlan {
  /** Per switch the platform configures: its name and what to set. */
  switches: { deviceId: string; name: string; lines: string[] }[];
  /** Switches the segments pass through but the platform does not control: what must already be true there. */
  passThrough: string[];
  direct: string[];
  addresses: string[];
  verify: string[];
  cleanup: string[];
}

export interface PlanContext {
  lab?: Pick<PhysicalLab, "nodes" | "links">;
  devices: readonly TopologyDevice[];
  roles: readonly TopologyRole[];
}

/**
 * What the platform will set up, check and undo for the scenario's segments. Switches and addresses are written out
 * in full, so a scenario starts the same whatever the one before it left: business ports a scenario does not use are
 * shut, uplinks carry only control and this scenario's VLANs, and unused ports of role devices lose their addresses.
 */
export function planScenarioTopology({ lab, devices, roles }: PlanContext, analysis: readonly AnalyzedSegment[]): TopologyPlan {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const linkAt = (nodeId: string, portId: string) => (lab && "links" in lab ? findLinkAt(lab, { nodeId, portId }) : undefined);
  const portName = (deviceId: string, portId: string) => deviceById.get(deviceId)?.ports?.find((port) => port.id === portId)?.name || "?";
  const byNumber = (left: string, right: string) => left.localeCompare(right, "zh-CN", { numeric: true });
  const portList = (deviceId: string, portIds: Iterable<string>) => [...portIds].map((portId) => portName(deviceId, portId)).sort(byNumber).map(portLabel).join("、");
  const plan: TopologyPlan = { switches: [], passThrough: [], direct: [], addresses: [], verify: [], cleanup: [] };
  if (!analysis.length) return plan;

  // Access ports per switch and VLAN, and VLANs each uplink to an unmanaged switch must carry.
  const access = new Map<string, Map<string, { segments: string[]; ports: Set<string> }>>();
  const uplinkVlans = new Map<string, Set<string>>();
  const usedPorts = new Set<string>();
  for (const { segment, interfaces, direct } of analysis) {
    for (const entry of interfaces) {
      if (entry.device && entry.item.portId) usedPorts.add(`${entry.device.id}\u0000${entry.item.portId}`);
      const label = `${entry.role?.key || "?"} ${entry.item.name}`;
      const physical = entry.device && entry.portName ? `（${entry.device.name} ${entry.portName}）` : "";
      const range = parseSubnet(segment.subnet);
      if (!entry.item.address) plan.addresses.push(`${label}${physical}：清除地址，不配地址`);
      else if (range) plan.addresses.push(`${label}${physical}：${entry.item.address}/${range.bits}`);
      const path = entry.path;
      if (!path || direct || !segment.vlan) continue;
      if (path.kind === "switch") {
        if (!access.has(path.access.nodeId)) access.set(path.access.nodeId, new Map());
        const vlans = access.get(path.access.nodeId)!;
        if (!vlans.has(segment.vlan)) vlans.set(segment.vlan, { segments: [], ports: new Set() });
        const use = vlans.get(segment.vlan)!;
        if (!use.segments.includes(segment.name)) use.segments.push(segment.name);
        use.ports.add(path.access.portId);
      } else if (path.kind === "via") {
        const key = `${path.trunk.nodeId}\u0000${path.trunk.portId}`;
        if (!uplinkVlans.has(key)) uplinkVlans.set(key, new Set());
        uplinkVlans.get(key)!.add(segment.vlan);
        plan.passThrough.push(`${deviceById.get(path.via.nodeId)?.name || "?"} ${portLabel(portName(path.via.nodeId, path.via.portId))}须已在 VLAN ${segment.vlan}（${segment.name}，平台不配置 ${deviceById.get(path.via.nodeId)?.name || "?"}）`);
      }
    }
    if (direct) plan.direct.push(`${segment.name}：${interfaces.map((entry) => `${entry.role?.key} ${entry.item.name}`).join(" ↔ ")} 直连，不经过交换机`);
    const addressed = interfaces.filter((entry) => entry.item.address);
    if (addressed.length >= 2) plan.verify.push(`${segment.name}：${addressed.map((entry) => `${entry.role?.key} ${entry.item.name}`).join("、")} 之间互相 ping 通`);
    else if (interfaces.length >= 2 && !addressed.length) plan.verify.push(`${segment.name}：没有地址，不做连通性验证`);
  }

  for (const device of devices.filter(isManagedSwitch)) {
    const vlans = access.get(device.id) || new Map<string, { segments: string[]; ports: Set<string> }>();
    const ports = device.ports || [];
    const uplinks = ports.filter((port) => {
      const link = linkAt(device.id, port.id);
      const far = link ? otherEnd(link, { nodeId: device.id, portId: port.id }) : undefined;
      const peer = far ? deviceById.get(far.nodeId) : undefined;
      return isSwitch(peer) && !isManagedSwitch(peer);
    });
    const accessPorts = new Set([...vlans.values()].flatMap((use) => [...use.ports]));
    const idle = ports.filter((port) => !accessPorts.has(port.id) && !uplinks.includes(port) && linkAt(device.id, port.id)?.role !== "control"
      && !device.controlInterfaces.some((control) => control.portId === port.id));
    const lines = [...vlans].sort(([left], [right]) => byNumber(left, right)).map(([vlan, use]) => `VLAN ${vlan}（${use.segments.join("、")}）：${portList(device.id, use.ports)} access 并开启`);
    for (const uplink of uplinks) {
      const carried = [...(uplinkVlans.get(`${device.id}\u0000${uplink.id}`) || [])].sort(byNumber);
      lines.push(`${portLabel(uplink.name)} trunk：只放行控制所用的 VLAN${carried.length ? ` 和 ${carried.join("、")}` : ""}，移除其他业务 VLAN`);
      if (carried.length) plan.cleanup.push(`${device.name} ${portLabel(uplink.name)} trunk 移除放行 VLAN ${carried.join("、")}`);
    }
    if (idle.length) lines.push(`${portList(device.id, idle.map((port) => port.id))}关闭（本场景不用的业务口）`);
    if (accessPorts.size) plan.cleanup.unshift(`${device.name} ${portList(device.id, accessPorts)}关闭并恢复默认 VLAN`);
    if (lines.length) plan.switches.push({ deviceId: device.id, name: device.name, lines });
  }

  // Unused ports of role devices lose their addresses. A device whose network control port is unknown is left alone,
  // since clearing its management address would cut the platform off.
  for (const role of roles) {
    const device = deviceById.get(role.deviceId);
    if (!device || isSwitch(device)) continue;
    if (device.controlInterfaces.some((control) => control.kind !== "serial" && !control.portId)) continue;
    const idle = (device.ports || []).filter((port) => (port.kind || "ethernet") === "ethernet" && !usedPorts.has(`${device.id}\u0000${port.id}`)
      && linkAt(device.id, port.id)?.role !== "control" && !device.controlInterfaces.some((control) => control.portId === port.id));
    if (idle.length) plan.addresses.push(`${role.key}（${device.name}）${idle.map((port) => port.name).join("、")}：清除地址（本场景不用）`);
  }
  if (plan.addresses.some((line) => /\/\d+$/.test(line))) plan.cleanup.push("删除以上接口地址");
  return plan;
}
