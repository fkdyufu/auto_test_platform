import assert from "node:assert/strict";
import test from "node:test";
import { resolveRunResult } from "./run-result.js";

test("uses the explicit finish_test result", () => {
  assert.deepEqual(
    resolveRunResult({
      result: { status: "passed", summary: "页面符合预期" },
      finalText: "模型补充文字",
    }),
    { outcome: "passed", message: "页面符合预期", fullText: "页面符合预期" },
  );
});

test("fails a run when the agent did not call finish_test", () => {
  assert.deepEqual(resolveRunResult({ finalText: "模型提前结束" }), {
    outcome: "failed",
    message: "Agent 未调用 finish_test 提交结论：模型提前结束",
    fullText: "Agent 未调用 finish_test 提交结论：模型提前结束",
  });
});

test("passes structured details through and keeps the full text for scenario records", () => {
  const result = resolveRunResult({
    result: {
      status: "passed",
      summary: "场景搭建完成",
      checks: [{ step: 1, result: "passed", actual: "已配置" }],
      evidenceList: ["fe1 UP"],
      notes: "设备原本已符合目标配置",
      log: "switch 端口 9/11 为 access VLAN 181/182",
    },
    finalText: "",
  });
  assert.equal(result.message, "场景搭建完成");
  assert.deepEqual(result.details, {
    checks: [{ step: 1, result: "passed", actual: "已配置" }],
    evidenceList: ["fe1 UP"],
    notes: "设备原本已符合目标配置",
    log: "switch 端口 9/11 为 access VLAN 181/182",
  });
  assert.equal(result.fullText, "场景搭建完成\n\n证据：\n- fe1 UP\n\n备注：设备原本已符合目标配置\n\nswitch 端口 9/11 为 access VLAN 181/182");
});
