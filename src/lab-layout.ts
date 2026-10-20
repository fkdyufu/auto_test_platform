export interface LayoutNode {
  id: string;
  label: string;
  sub: string;
  /** Taller boxes leave room for several parallel cables. */
  minHeight?: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export interface PlacedNode {
  x: number;
  y: number;
  w: number;
  h: number;
  ang: number;
}

export interface LabLayout {
  hub: string;
  positions: Record<string, PlacedNode>;
  viewBox: { x: number; y: number; width: number; height: number };
}

const RADIUS_X = [0, 210, 370, 470];
const RADIUS_Y = [0, 150, 260, 330];
const NODE_HEIGHT = 44;
const MARGIN_X = 70;
const MARGIN_Y = 56;
/** Extra gap per additional parallel cable between two nodes, so staggered port labels fit. */
const PARALLEL_GAP_X = 16;
const PARALLEL_GAP_Y = 18;
const PADDING = 36;

function textWidth(text: string, cjk: number, latin: number): number {
  return [...text].reduce((sum, char) => sum + (/[\u2E80-\uFFFF]/.test(char) ? cjk : latin), 0);
}

/** Approximate width of an 11px port label. */
export function labelWidth(text: string): number {
  return textWidth(text, 11, 6.6);
}

/**
 * Radial layout around the busiest node: its neighbours sit on the first ring, deeper nodes at the mean angle of
 * their parents. Overlapping boxes are then pushed apart; nodes without cables go in rows underneath.
 */
export function layoutLab(nodes: LayoutNode[], edges: LayoutEdge[]): LabLayout {
  const ids = nodes.map((node) => node.id);
  const adjacency = new Map(ids.map((id) => [id, new Set<string>()]));
  edges.forEach((edge) => {
    if (edge.from === edge.to || !adjacency.has(edge.from) || !adjacency.has(edge.to)) return;
    adjacency.get(edge.from)!.add(edge.to);
    adjacency.get(edge.to)!.add(edge.from);
  });
  const degree = (id: string) => edges.filter((edge) => edge.from !== edge.to && (edge.from === id || edge.to === id)).length;
  const hub = [...ids].sort((left, right) => degree(right) - degree(left))[0] || "";
  const pairCounts = new Map<string, number>();
  edges.forEach((edge) => {
    if (edge.from === edge.to) return;
    const key = [edge.from, edge.to].sort().join("\u0000");
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
  });
  const parallel = Math.min(4, Math.max(1, ...pairCounts.values()));
  const marginX = MARGIN_X + PARALLEL_GAP_X * (parallel - 1);
  const marginY = MARGIN_Y + PARALLEL_GAP_Y * (parallel - 1);
  const positions: Record<string, PlacedNode> = {};
  if (!hub) return { hub, positions, viewBox: { x: 0, y: 0, width: 200, height: 100 } };

  const sizes = new Map(nodes.map((node) => [node.id, {
    w: Math.max(96, 28 + Math.max(textWidth(node.label, 14, 8.5), textWidth(node.sub, 12, 7))),
    h: Math.max(NODE_HEIGHT, node.minHeight || 0),
  }]));
  const connected = degree(hub) > 0;
  const layer = new Map<string, number>();
  const queue: string[] = [];
  if (connected) {
    layer.set(hub, 0);
    queue.push(hub);
    for (let index = 0; index < queue.length; index += 1) {
      for (const next of adjacency.get(queue[index])!) {
        if (layer.has(next)) continue;
        layer.set(next, layer.get(queue[index])! + 1);
        queue.push(next);
      }
    }
    positions[hub] = { x: 0, y: 0, ang: 0, ...sizes.get(hub)! };
    const firstRing = queue.filter((id) => layer.get(id) === 1);
    const children = (id: string) => [...adjacency.get(id)!].filter((next) => layer.get(next) === 2).length;
    firstRing.sort((left, right) => children(right) - children(left));
    firstRing.forEach((id, index) => {
      const ang = -Math.PI / 2 + (index * 2 * Math.PI) / firstRing.length;
      positions[id] = { x: RADIUS_X[1] * Math.cos(ang), y: RADIUS_Y[1] * Math.sin(ang), ang, ...sizes.get(id)! };
    });
    const maxLayer = Math.max(...layer.values());
    for (let level = 2; level <= maxLayer; level += 1) {
      const ring = queue.filter((id) => layer.get(id) === level).map((id) => {
        let sumX = 0;
        let sumY = 0;
        adjacency.get(id)!.forEach((parent) => {
          if (positions[parent] && layer.get(parent) === level - 1) {
            sumX += Math.cos(positions[parent].ang);
            sumY += Math.sin(positions[parent].ang);
          }
        });
        return { id, ang: Math.atan2(sumY, sumX) };
      }).sort((left, right) => left.ang - right.ang);
      const gap = 0.8;
      for (let round = 0; round < 20; round += 1) {
        for (let index = 1; index < ring.length; index += 1) {
          const distance = ring[index].ang - ring[index - 1].ang;
          if (distance < gap) {
            ring[index - 1].ang -= (gap - distance) / 2;
            ring[index].ang += (gap - distance) / 2;
          }
        }
      }
      const radius = Math.min(level, RADIUS_X.length - 1);
      ring.forEach((item) => {
        positions[item.id] = { x: RADIUS_X[radius] * Math.cos(item.ang), y: RADIUS_Y[radius] * Math.sin(item.ang), ang: item.ang, ...sizes.get(item.id)! };
      });
    }
    // Push apart boxes that overlap, leaving room for port labels; the hub stays put.
    const placed = Object.keys(positions);
    for (let round = 0; round < 200; round += 1) {
      let moved = false;
      for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
          const p = positions[placed[i]];
          const q = positions[placed[j]];
          const overlapX = (p.w + q.w) / 2 + marginX - Math.abs(p.x - q.x);
          const overlapY = (p.h + q.h) / 2 + marginY - Math.abs(p.y - q.y);
          if (overlapX <= 0 || overlapY <= 0) continue;
          moved = true;
          const horizontal = overlapX / (p.w + q.w + marginX) < overlapY / (p.h + q.h + marginY);
          const sign = horizontal ? Math.sign(q.x - p.x || 1) : Math.sign(q.y - p.y || 1);
          const push = (horizontal ? overlapX : overlapY) / 2 + 1;
          const pin = placed[i] === hub ? 0 : placed[j] === hub ? 2 : 1;
          const axis = horizontal ? "x" : "y";
          if (pin !== 0) p[axis] -= sign * push * (pin === 2 ? 2 : 1);
          if (pin !== 2) q[axis] += sign * push * (pin === 0 ? 2 : 1);
        }
      }
      if (!moved) break;
    }
  }

  // Nodes with no cables to the main group sit in rows underneath it.
  const loose = ids.filter((id) => !positions[id]);
  if (loose.length) {
    const placedValues = Object.values(positions);
    const top = placedValues.length ? Math.max(...placedValues.map((item) => item.y + item.h / 2)) + 70 : 0;
    const perRow = 4;
    const step = Math.max(...loose.map((id) => sizes.get(id)!.w)) + 36;
    loose.forEach((id, index) => {
      const row = Math.floor(index / perRow);
      const inRow = Math.min(perRow, loose.length - row * perRow);
      const column = index % perRow;
      positions[id] = { x: (column - (inRow - 1) / 2) * step, y: top + row * (NODE_HEIGHT + 36), ang: Math.PI / 2, ...sizes.get(id)! };
    });
  }

  const values = Object.values(positions);
  const minX = Math.min(...values.map((item) => item.x - item.w / 2)) - PADDING;
  const maxX = Math.max(...values.map((item) => item.x + item.w / 2)) + PADDING;
  const minY = Math.min(...values.map((item) => item.y - item.h / 2)) - PADDING;
  const maxY = Math.max(...values.map((item) => item.y + item.h / 2)) + PADDING;
  return { hub, positions, viewBox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}

/** Where the line from the box centre towards (targetX, targetY) leaves the box. */
export function borderPoint(node: PlacedNode, targetX: number, targetY: number): { x: number; y: number } {
  const dx = targetX - node.x;
  const dy = targetY - node.y;
  const scaleX = dx ? node.w / 2 / Math.abs(dx) : Infinity;
  const scaleY = dy ? node.h / 2 / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  return { x: node.x + dx * scale, y: node.y + dy * scale };
}
