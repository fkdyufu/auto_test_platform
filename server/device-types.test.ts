import assert from "node:assert/strict";
import test from "node:test";
import { deviceMatchesRoleType } from "./device-types.js";

test("matches a role against any configured device type", () => {
  const device = { types: ["peer", "host"] };

  assert.equal(deviceMatchesRoleType(device, "host"), true);
  assert.equal(deviceMatchesRoleType(device, "peer"), true);
  assert.equal(deviceMatchesRoleType(device, "TAU"), false);
});

test("normalizes case and surrounding whitespace when matching device types", () => {
  assert.equal(deviceMatchesRoleType({ types: [" Host "] }, " host"), true);
  assert.equal(deviceMatchesRoleType({ types: ["host"] }, "   "), false);
});
