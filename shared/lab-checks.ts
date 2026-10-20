import { CONTROL_KINDS, type ControlInterface } from "./control-interfaces.js";
import { endLabel, findLinkAt, otherEnd, resolveControlPath, serialDeviceName, type LabNode, type PhysicalLab } from "./physical-lab.js";

export interface LabCheckDevice {
  id: string;
  name: string;
  controlInterfaces: Pick<ControlInterface, "id" | "name" | "kind" | "settings">[];
}

export interface LabIssue {
  key: string;
  text: string;
  nodeId: string;
  portId?: string;
  /** A port that probably carries the control interface, because its cable or port note mentions the address. */
  suggestion?: { controlId: string; portId: string; portName: string; reason: string };
}

function controlHost(control: LabCheckDevice["controlInterfaces"][number]): string {
  const settings = control.settings;
  if (control.kind === "ssh" || control.kind === "telnet") return (settings.host || "").trim();
  const address = (control.kind === "web" ? settings.url : control.kind === "api" ? settings.baseUrl : "")?.trim();
  if (!address) return "";
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `http://${address}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

function suggestPort(lab: Pick<PhysicalLab, "nodes" | "links">, node: LabNode, host: string) {
  if (!host) return undefined;
  const pattern = new RegExp(`(?<![\\w.-])${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
  const matches = node.ports.flatMap((port) => {
    const link = findLinkAt(lab, { nodeId: node.id, portId: port.id });
    if (pattern.test(port.note)) return [{ port, reason: `${port.name} 的备注里有 ${host}` }];
    if (link && pattern.test(link.note)) return [{ port, reason: `${port.name} 的连线备注里有 ${host}` }];
    return [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Gaps a person should fix before the agent can rely on the lab: devices with no cables and control interfaces whose
 * path cannot be traced. Nothing is reported until at least one cable is registered.
 */
export function checkPhysicalLab(lab: Pick<PhysicalLab, "nodes" | "links">, devices: LabCheckDevice[]): LabIssue[] {
  if (!lab.links.length) return [];
  const issues: LabIssue[] = [];
  const platform = lab.nodes.find((node) => node.kind === "platform");
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  for (const node of lab.nodes) {
    const device = deviceById.get(node.id);
    if (node.kind !== "device" || !device) continue;
    if (!lab.links.some((link) => link.a.nodeId === node.id || link.b.nodeId === node.id)) {
      issues.push({ key: `unwired:${node.id}`, nodeId: node.id, text: `${device.name} 还没有登记接线` });
      continue;
    }
    for (const control of device.controlInterfaces) {
      const label = `${device.name} 的 ${control.name || CONTROL_KINDS[control.kind].label} 接口`;
      const path = resolveControlPath(lab, node.id, control);
      const port = path.portId ? node.ports.find((item) => item.id === path.portId) : undefined;
      if (port) {
        if (!path.peer) {
          issues.push({ key: `uncabled:${control.id}`, nodeId: node.id, portId: port.id, text: `${label}经 ${port.name}，但 ${port.name} 没有接线` });
        } else if (path.addressMatches === false) {
          issues.push({ key: `serial-mismatch:${control.id}`, nodeId: node.id, portId: port.id, text: `${label}地址是 ${serialDeviceName(control.settings.device || "")}，接线却到 ${endLabel(lab, path.peer)}` });
        }
        continue;
      }
      const serialName = control.kind === "serial" ? serialDeviceName(control.settings.device || "") : "";
      if (serialName && platform) {
        const platformPort = platform.ports.find((item) => item.name.toLowerCase() === serialName.toLowerCase());
        const link = platformPort && findLinkAt(lab, { nodeId: platform.id, portId: platformPort.id });
        const text = !platformPort
          ? `${platform.name}没有登记串口 ${serialName}，${label}找不到接线`
          : link
            ? `${platform.name} ${platformPort.name} 接的是 ${endLabel(lab, otherEnd(link, { nodeId: platform.id, portId: platformPort.id }))}，${label}找不到接线`
            : `${platform.name} ${platformPort.name} 没有接到 ${device.name}`;
        issues.push({ key: `serial:${control.id}`, nodeId: node.id, text });
        continue;
      }
      const match = suggestPort(lab, node, controlHost(control));
      issues.push({
        key: `control:${control.id}`,
        nodeId: node.id,
        text: `${label}未指定所经端口`,
        ...(match ? { suggestion: { controlId: control.id, portId: match.port.id, portName: match.port.name, reason: match.reason } } : {}),
      });
    }
  }
  return issues;
}

/** One line per issue, for the assistant or a prompt. */
export function describeLabIssue(issue: LabIssue): string {
  return issue.suggestion ? `${issue.text}（${issue.suggestion.reason}，可能经 ${issue.suggestion.portName}）` : issue.text;
}
