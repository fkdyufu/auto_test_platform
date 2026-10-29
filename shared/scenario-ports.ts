import { findLinkAt, otherEnd, type LabLink, type LabLinkEnd, type PhysicalLab } from "./physical-lab.js";

export interface ScenarioPortRole {
  key: string;
  deviceId: string;
  /** Ports of the bound device the scenario uses. Each one brings whatever it is cabled to. */
  portIds?: string[];
}

export interface ScenarioLink {
  role: string;
  end: LabLinkEnd;
  link?: LabLink;
  peer?: LabLinkEnd;
}

export interface ScenarioPortUse {
  /** One entry per picked port; a cable picked at both ends is listed once. */
  links: ScenarioLink[];
  /** Device ID -> ports in use: the picked ones and the far ends of their cables. */
  used: Map<string, Set<string>>;
  /** Devices with ports picked by hand. The scenario leaves their other ports alone. */
  restricted: Set<string>;
}

const key = (end: LabLinkEnd) => `${end.nodeId}\u0000${end.portId}`;

/** Which cables a scenario uses, read from the lab so that rewiring never needs the scenario to change. */
export function scenarioPortUse(lab: Pick<PhysicalLab, "links"> | undefined, roles: ScenarioPortRole[]): ScenarioPortUse {
  const links: ScenarioLink[] = [];
  const used = new Map<string, Set<string>>();
  const restricted = new Set<string>();
  const listed = new Set<string>();
  const use = (end: LabLinkEnd) => {
    if (!used.has(end.nodeId)) used.set(end.nodeId, new Set());
    used.get(end.nodeId)!.add(end.portId);
  };
  for (const role of roles) {
    for (const portId of role.portIds || []) {
      const end = { nodeId: role.deviceId, portId };
      restricted.add(role.deviceId);
      use(end);
      if (listed.has(key(end))) continue;
      const link = lab ? findLinkAt(lab, end) : undefined;
      const peer = link ? otherEnd(link, end) : undefined;
      if (peer) {
        use(peer);
        listed.add(key(peer));
      }
      listed.add(key(end));
      links.push({ role: role.key, end, ...(link ? { link, peer } : {}) });
    }
  }
  return { links, used, restricted };
}
