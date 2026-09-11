import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentInactivityError,
  createInactivityGuard,
  createTextDeltaBatcher,
} from "./agent-event-control.js";

test("batches adjacent assistant text deltas", () => {
  const emitted: string[] = [];
  const batcher = createTextDeltaBatcher((text) => emitted.push(text), 10_000);

  batcher.push("模型");
  batcher.push("输出");
  batcher.flush();

  assert.deepEqual(emitted, ["模型输出"]);
});

test("inactivity guard rejects and aborts after the deadline", async () => {
  let abortCount = 0;
  const guard = createInactivityGuard(10, () => {
    abortCount += 1;
  });
  guard.touch();

  await assert.rejects(guard.timeout, (error: unknown) => {
    return error instanceof AgentInactivityError && error.message.includes("已自动终止");
  });
  guard.touch();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(abortCount, 1);
  guard.dispose();
});

test("touch resets the inactivity deadline", async () => {
  let aborted = false;
  const guard = createInactivityGuard(30, () => {
    aborted = true;
  });
  guard.touch();
  await new Promise((resolve) => setTimeout(resolve, 20));
  guard.touch();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(aborted, false);
  guard.dispose();
});
