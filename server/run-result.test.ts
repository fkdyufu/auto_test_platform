import assert from "node:assert/strict";
import test from "node:test";
import { resolveRunResult } from "./run-result.js";

test("uses the explicit finish_test result", () => {
  assert.deepEqual(
    resolveRunResult({
      result: { status: "passed", summary: "页面符合预期" },
      finalText: "模型补充文字",
    }),
    { outcome: "passed", message: "页面符合预期" },
  );
});

test("fails a run when the agent did not call finish_test", () => {
  assert.deepEqual(resolveRunResult({ finalText: "模型提前结束" }), {
    outcome: "failed",
    message: "Agent 未调用 finish_test 提交结论：模型提前结束",
  });
});

test("passes structured observations through without changing legacy results", () => {
  assert.deepEqual(resolveRunResult({
    result: { status: "failed", summary: "接管失败", expected: "备机接管", actual: "未接管", evidence: "状态 BACKUP" },
    finalText: "",
  }), {
    outcome: "failed",
    message: "接管失败",
    details: { expected: "备机接管", actual: "未接管", evidence: "状态 BACKUP" },
  });
});
