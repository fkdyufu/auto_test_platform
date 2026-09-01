import assert from "node:assert/strict";
import test from "node:test";
import type { RunEvent } from "./api";
import { buildTimelineItems } from "./run-events";

const baseEvents: RunEvent[] = [
  {
    id: 1,
    timestamp: "2026-09-01T00:00:00.000Z",
    type: "tool_start",
    tool: "browser_open",
    toolCallId: "call-1",
    args: { url: "http://127.0.0.1" },
  },
];

test("merges tool start and successful end into one completed item", () => {
  const items = buildTimelineItems(
    [
      ...baseEvents,
      {
        id: 2,
        timestamp: "2026-09-01T00:00:01.000Z",
        type: "tool_end",
        tool: "browser_open",
        toolCallId: "call-1",
        error: false,
        message: "页面已打开",
      },
    ],
    false,
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].toolState, "completed");
  assert.equal(items[0].message, "页面已打开");
});

test("keeps an actual tool error as a failed item", () => {
  const items = buildTimelineItems(
    [
      ...baseEvents,
      {
        id: 2,
        timestamp: "2026-09-01T00:00:01.000Z",
        type: "tool_end",
        tool: "browser_open",
        toolCallId: "call-1",
        error: true,
        message: "连接失败",
      },
    ],
    false,
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].toolState, "failed");
  assert.equal(items[0].error, true);
});

test("marks unfinished tools as interrupted when the run ends", () => {
  const items = buildTimelineItems(baseEvents, false);

  assert.equal(items.length, 1);
  assert.equal(items[0].toolState, "interrupted");
  assert.equal(items[0].message, "任务结束前未收到工具完成事件");
});
