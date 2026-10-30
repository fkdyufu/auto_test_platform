export type LayoutDirection = "left" | "right" | "up" | "down";

export interface ScenarioLayout {
  roles: Map<string, { x: number; y: number }>;
  /** Where each segment sits, and which way it points away from the roles it joins. */
  segments: Map<string, { x: number; y: number; dir: LayoutDirection }>;
}

const HUB_GAP = 400;
const SIDE = 230;
const VERT = 125;
const BETWEEN = 200;
const LEAF_ABOVE = 100;
const LEAF_OUT = 90;
const LEAF_SPREAD = 112;

/**
 * Lays a scenario out the way its topology reads. Roles in several segments ("hubs") form a row, neighbours next to each
 * other; a segment joining hubs sits between them, a segment of one hub sits beside it, and roles in only one segment
 * sit beyond that segment.
 */
export function layoutScenario(roleIds: readonly string[], segments: readonly { id: string; roleIds: readonly string[] }[]): ScenarioLayout {
  const count = new Map(roleIds.map((id) => [id, 0]));
  segments.forEach((segment) => segment.roleIds.forEach((id) => count.set(id, (count.get(id) || 0) + 1)));
  const isHub = (id: string) => (count.get(id) || 0) >= 2;

  // Hubs that share a segment are placed next to each other.
  const order: string[] = [];
  for (const start of roleIds.filter(isHub)) {
    const queue = [start];
    while (queue.length) {
      const id = queue.shift()!;
      if (order.includes(id)) continue;
      order.push(id);
      for (const segment of segments) {
        if (segment.roleIds.includes(id)) queue.push(...segment.roleIds.filter((other) => isHub(other) && !order.includes(other)));
      }
    }
  }
  const roles = new Map<string, { x: number; y: number }>();
  order.forEach((id, index) => roles.set(id, { x: index * HUB_GAP, y: 0 }));

  const placed = new Map<string, { x: number; y: number; dir: LayoutDirection }>();
  const hubSets = new Map<string, string[]>();
  for (const segment of segments) {
    const hubs = segment.roleIds.filter(isHub);
    if (hubs.length < 2) continue;
    const key = [...hubs].sort().join("\u0000");
    hubSets.set(key, [...(hubSets.get(key) || []), segment.id]);
  }
  const taken = new Map<string, Set<LayoutDirection>>();
  let loose = 0;
  for (const segment of segments) {
    const hubs = segment.roleIds.filter(isHub);
    if (hubs.length >= 2) {
      // Between its hubs; several segments joining the same hubs spread above and below that line.
      const group = hubSets.get([...hubs].sort().join("\u0000"))!;
      const offset = (group.indexOf(segment.id) - (group.length - 1) / 2) * BETWEEN;
      const x = hubs.reduce((sum, id) => sum + roles.get(id)!.x, 0) / hubs.length;
      placed.set(segment.id, { x, y: offset, dir: offset > 0 ? "down" : "up" });
    } else if (hubs.length === 1) {
      const hub = hubs[0];
      const index = order.indexOf(hub);
      // A lone hub spreads its segments to the sides; in a row of hubs they go above first, which keeps a chain compact.
      const preferred: LayoutDirection[] = order.length === 1 ? ["left", "right", "down", "up"]
        : index === 0 ? ["up", "left", "down"]
          : index === order.length - 1 ? ["up", "right", "down"]
            : ["up", "down"];
      const used = taken.get(hub) || new Set<LayoutDirection>();
      const dir = preferred.find((item) => !used.has(item)) || preferred[used.size % preferred.length];
      used.add(dir);
      taken.set(hub, used);
      const at = roles.get(hub)!;
      placed.set(segment.id, {
        x: at.x + (dir === "left" ? -SIDE : dir === "right" ? SIDE : 0),
        y: at.y + (dir === "up" ? -VERT : dir === "down" ? VERT : 0),
        dir,
      });
    } else {
      // No hub at all: each such segment stands on its own, side by side.
      placed.set(segment.id, { x: loose * 2 * SIDE, y: order.length ? 2 * VERT + LEAF_OUT : 0, dir: order.length ? "down" : "up" });
      loose += 1;
    }
  }

  // Roles in a single segment sit beyond it, away from the hubs.
  for (const segment of segments) {
    const at = placed.get(segment.id)!;
    const leaves = segment.roleIds.filter((id) => count.get(id) === 1);
    leaves.forEach((id, index) => {
      const spread = (index - (leaves.length - 1) / 2) * LEAF_SPREAD;
      roles.set(id, at.dir === "left" || at.dir === "right"
        ? { x: at.x + spread, y: at.y - LEAF_ABOVE }
        : { x: at.x + spread, y: at.y + (at.dir === "up" ? -LEAF_OUT : LEAF_OUT) });
    });
  }
  // Roles in no segment yet go in a row above everything.
  const rest = roleIds.filter((id) => !roles.has(id));
  const top = Math.min(0, ...[...roles.values()].map((item) => item.y)) - VERT;
  rest.forEach((id, index) => roles.set(id, { x: index * LEAF_SPREAD, y: top }));
  return { roles, segments: placed };
}
