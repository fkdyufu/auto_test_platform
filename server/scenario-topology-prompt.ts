import type { DeviceResource, PhysicalLab, TestScenario } from "./catalog-store.js";
import { analyzeScenarioTopology, parseSubnet, planScenarioTopology, portLabel, type AnalyzedInterface, type TopologyPath } from "../shared/scenario-topology.js";

type TopologyScenario = Pick<TestScenario, "roles" | "segments">;

function analyze(scenario: TopologyScenario, lab: PhysicalLab | undefined, devices: DeviceResource[]) {
  return analyzeScenarioTopology({ lab, roles: scenario.roles, devices, segments: scenario.segments });
}

function describePath(lab: PhysicalLab | undefined, path: TopologyPath | undefined): string {
  if (!path || !lab) return "";
  const end = (nodeId: string, portId: string) => {
    const node = lab.nodes.find((item) => item.id === nodeId);
    return `${node?.name || "?"} ${portLabel(node?.ports.find((port) => port.id === portId)?.name || "?")}`;
  };
  if (path.kind === "switch") return `接 ${end(path.access.nodeId, path.access.portId)}`;
  if (path.kind === "via") return `经 ${end(path.via.nodeId, path.via.portId)}接 ${end(path.trunk.nodeId, path.trunk.portId)}`;
  return `直连 ${end(path.peer.nodeId, path.peer.portId)}`;
}

/** Managed switches the segments run through. The agent gets their tools although they are not scenario roles. */
export function scenarioTransitDeviceIds(scenario: TopologyScenario, lab: PhysicalLab | undefined, devices: DeviceResource[]): string[] {
  if (!scenario.segments.length) return [];
  return planScenarioTopology({ lab, devices, roles: scenario.roles }, analyze(scenario, lab, devices)).switches.map((item) => item.deviceId);
}

/** The logical topology for every phase: segments, the role interfaces in them, their addresses and device ports. */
export function formatScenarioTopology(scenario: TopologyScenario, lab: PhysicalLab | undefined, devices: DeviceResource[]): string {
  if (!scenario.segments.length) return "";
  const analysis = analyze(scenario, lab, devices);
  const line = (segmentSubnet: string, entry: AnalyzedInterface) => {
    const range = parseSubnet(segmentSubnet);
    const physical = entry.device ? `${entry.device.name} ${entry.portName || "?"}` : "未绑定设备";
    const path = describePath(lab, entry.path);
    const address = entry.item.address && range ? `地址 ${entry.item.address}/${range.bits}` : "不配地址";
    return `  - ${entry.role?.key || "?"} ${entry.item.name} = ${physical}${path ? `（${path}）` : ""}，${address}`;
  };
  const segments = analysis.map(({ segment, interfaces, direct }) => [
    `- ${segment.name}（${[direct && !segment.vlan ? "直连" : `VLAN ${segment.vlan}`, segment.subnet].filter(Boolean).join("，")}）`,
    ...interfaces.map((entry) => line(segment.subnet, entry)),
  ].join("\n"));
  const switches = planScenarioTopology({ lab, devices, roles: scenario.roles }, analysis).switches.map((item) => item.name);
  return [
    "场景拓扑（同一网段的接口二层互通；用例中的接口名指这里的接口）：",
    ...segments,
    switches.length ? `平台提供 ${switches.join("、")} 的控制工具用于搭建这些网段，它们不是场景角色。` : "",
  ].filter(Boolean).join("\n");
}

/** What the setup must do and check for the segments; empty for a scenario described by text only. */
export function formatTopologySetup(scenario: TopologyScenario, lab: PhysicalLab | undefined, devices: DeviceResource[]): string {
  if (!scenario.segments.length) return "";
  const plan = planScenarioTopology({ lab, devices, roles: scenario.roles }, analyze(scenario, lab, devices));
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
  return [
    "拓扑搭建（平台根据网段推导）：",
    ...plan.switches.map((item) => `在 ${item.name} 上：\n${list(item.lines)}`),
    plan.passThrough.length ? `需要确认（平台不配置的设备）：\n${list(plan.passThrough)}` : "",
    plan.direct.length ? list(plan.direct) : "",
    plan.addresses.length ? `接口地址：\n${list(plan.addresses)}` : "",
    plan.verify.length ? `拓扑验证：\n${list(plan.verify)}` : "",
    plan.switches.length ? `交换机上只改动以上列出的端口和 VLAN。` : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * What the cleanup must do besides the topology. A scenario described by text keeps its cleanup text as written; with a
 * topology, what the other preparation set up is undone too, so the cleanup text only adds what goes beyond it.
 */
export function formatOtherCleanup(scenario: Pick<TestScenario, "segments" | "setupInstructions" | "cleanupInstructions">): string {
  const undo = scenario.segments.length && scenario.setupInstructions.trim() ? `撤销其他准备所做的配置：\n${scenario.setupInstructions.trim()}` : "";
  return [scenario.cleanupInstructions.trim(), undo].filter(Boolean).join("\n\n") || "无";
}

/** What the cleanup must undo for the segments. */
export function formatTopologyCleanup(scenario: TopologyScenario, lab: PhysicalLab | undefined, devices: DeviceResource[]): string {
  if (!scenario.segments.length) return "";
  const plan = planScenarioTopology({ lab, devices, roles: scenario.roles }, analyze(scenario, lab, devices));
  return plan.cleanup.length ? `拓扑清理（平台根据网段推导）：\n${plan.cleanup.map((item) => `- ${item}`).join("\n")}` : "";
}
