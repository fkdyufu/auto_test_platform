import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeToolEvent } from "./event-sanitizer.js";

test("redacts browser_fill values before events are stored", () => {
  const event = sanitizeToolEvent({
    type: "tool_start",
    tool: "browser_fill",
    args: { target: "@e2", value: "plain-text-password" },
  });

  assert.deepEqual(event.args, { target: "@e2", value: "[REDACTED]" });
});

test("keeps non-fill tool arguments unchanged", () => {
  const event = { tool: "browser_open", args: { url: "http://127.0.0.1" } };
  assert.equal(sanitizeToolEvent(event), event);
});
