import assert from "node:assert/strict";
import test from "node:test";
import { layoutLab } from "./lab-layout";

test("centres the busiest node and keeps boxes apart", () => {
  const nodes = ["switch", "TAU1", "TAU2", "vswitch", "host1", "host2", "平台服务器", "备用"].map((id) => ({ id, label: id, sub: "设备" }));
  const edges = [
    ["switch", "TAU1"], ["switch", "TAU1"], ["switch", "TAU2"], ["switch", "vswitch"], ["TAU1", "TAU2"],
    ["vswitch", "host1"], ["vswitch", "host2"], ["平台服务器", "TAU1"],
  ].map(([from, to]) => ({ from, to }));
  const { hub, positions, viewBox } = layoutLab(nodes, edges);
  assert.equal(hub, "switch");
  assert.deepEqual([positions.switch.x, positions.switch.y], [0, 0]);
  const ids = Object.keys(positions);
  assert.equal(ids.length, nodes.length, "nodes without cables are still placed");
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const p = positions[ids[i]];
      const q = positions[ids[j]];
      const apart = Math.abs(p.x - q.x) >= (p.w + q.w) / 2 || Math.abs(p.y - q.y) >= (p.h + q.h) / 2;
      assert.ok(apart, `${ids[i]} overlaps ${ids[j]}`);
    }
  }
  assert.ok(positions["备用"].y > positions.host1.y && positions["备用"].y > positions.host2.y, "the loose node sits underneath");
  assert.ok(viewBox.width > 0 && viewBox.height > 0);
});

test("places every node in rows when nothing is wired", () => {
  const nodes = ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id, sub: "" }));
  const { positions } = layoutLab(nodes, []);
  assert.equal(new Set(Object.values(positions).map((item) => item.y)).size, 2);
});
