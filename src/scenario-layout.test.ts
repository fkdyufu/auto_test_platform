import assert from "node:assert/strict";
import test from "node:test";
import { layoutScenario } from "./scenario-layout";

test("a chain reads left to right, with the segment between two routers placed between them", () => {
  const layout = layoutScenario(["TAU", "Peer", "H1", "H2"], [
    { id: "h1", roleIds: ["TAU", "H1"] },
    { id: "link", roleIds: ["TAU", "Peer"] },
    { id: "h2", roleIds: ["Peer", "H2"] },
  ]);
  const tau = layout.roles.get("TAU")!;
  const peer = layout.roles.get("Peer")!;
  const link = layout.segments.get("link")!;
  assert.ok(tau.x < link.x && link.x < peer.x && link.y === tau.y && tau.y === peer.y, "the TAU-Peer segment sits between them");
  assert.deepEqual(layout.segments.get("h1"), { x: tau.x, y: -125, dir: "up" }, "H1's segment sits above TAU");
  assert.deepEqual(layout.segments.get("h2"), { x: peer.x, y: -125, dir: "up" }, "H2's segment sits above Peer");
  assert.ok(layout.roles.get("H1")!.y < -125 && layout.roles.get("H2")!.y < -125, "hosts sit beyond their segments");
});

test("one router with three segments puts them left, right and below it", () => {
  const layout = layoutScenario(["TAU", "src", "dst", "observer"], [
    { id: "src", roleIds: ["TAU", "src"] },
    { id: "dst", roleIds: ["TAU", "dst"] },
    { id: "mirror", roleIds: ["TAU", "observer"] },
  ]);
  assert.deepEqual(["src", "dst", "mirror"].map((id) => layout.segments.get(id)!.dir), ["left", "right", "down"]);
  assert.ok(layout.roles.get("observer")!.y > layout.segments.get("mirror")!.y);
});

test("two segments joining the same two routers sit above and below the line between them", () => {
  const layout = layoutScenario(["R1", "R2", "PC", "SRV"], [
    { id: "lan", roleIds: ["R1", "R2", "PC"] },
    { id: "wan", roleIds: ["R1", "R2", "SRV"] },
  ]);
  const lan = layout.segments.get("lan")!;
  const wan = layout.segments.get("wan")!;
  assert.equal(lan.x, wan.x);
  assert.ok(lan.y < 0 && wan.y > 0);
  assert.ok(layout.roles.get("PC")!.y < lan.y && layout.roles.get("SRV")!.y > wan.y);
});
