import assert from "node:assert/strict";
import test from "node:test";
import type { TestRun } from "./api";
import { buildTestRunReport, formatRunDuration } from "./test-run-report";

const run: TestRun = {
  id: "run-1",
  testOrderId: "order-1",
  triggerType: "all",
  status: "completed",
  outcome: "failed",
  createdAt: "2026-09-14T01:00:00.000Z",
  startedAt: "2026-09-14T01:00:00.000Z",
  finishedAt: "2026-09-14T01:02:05.000Z",
  scenarioRuns: [
    {
      id: "scenario-run-1",
      testScenarioId: "scenario-1",
      scenarioNameSnapshot: "端口镜像",
      isDefault: false,
      status: "completed",
      outcome: "failed",
      roleBindings: {},
      parameterValues: {},
      caseRunIds: ["case-run-1", "case-run-2", "case-run-3"],
      cleanupOutcome: "failed",
      cleanupSummary: "交换机配置恢复失败",
    },
  ],
  caseRuns: [
    {
      id: "case-run-1",
      testCaseId: "case-1",
      scenarioRunId: "scenario-run-1",
      caseNameSnapshot: "用例一",
      stepsSnapshot: "执行",
      expectedResultSnapshot: "通过",
      status: "completed",
      outcome: "passed",
      summary: "符合预期",
      startedAt: "2026-09-14T01:00:00.000Z",
      finishedAt: "2026-09-14T01:00:10.000Z",
    },
    {
      id: "case-run-2",
      testCaseId: "case-2",
      scenarioRunId: "scenario-run-1",
      caseNameSnapshot: "用例二",
      stepsSnapshot: "执行",
      expectedResultSnapshot: "通过",
      status: "completed",
      outcome: "failed",
      summary: "设备返回值不符合预期",
    },
    {
      id: "case-run-3",
      testCaseId: "case-3",
      scenarioRunId: "scenario-run-1",
      caseNameSnapshot: "用例三",
      stepsSnapshot: "执行",
      expectedResultSnapshot: "通过",
      status: "cancelled",
      summary: "任务已取消",
    },
  ],
};

test("builds a concise report with failures and incomplete cases", () => {
  const report = buildTestRunReport(run);

  assert.equal(report.total, 3);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.incomplete, 1);
  assert.equal(report.passRate, 33);
  assert.equal(report.failedCases[0].summary, "设备返回值不符合预期");
  assert.equal(report.failedCases[0].scenarioName, "端口镜像");
  assert.deepEqual(report.scenarioIssues, [{
    id: "scenario-run-1-cleanup",
    scenarioName: "端口镜像",
    phase: "场景清理",
    reason: "交换机配置恢复失败",
  }]);
});

test("formats report durations for quick scanning", () => {
  assert.equal(formatRunDuration(undefined), "-");
  assert.equal(formatRunDuration(125_000), "2 分 5 秒");
  assert.equal(formatRunDuration(3_661_000), "1 小时 1 分");
});

test("surfaces possible residual configuration in scenario cleanup issues", () => {
  const residualRiskRun = structuredClone(run);
  residualRiskRun.scenarioRuns[0].cleanupSummary = "模型接口异常，无法执行自动清理，环境可能残留配置";

  const report = buildTestRunReport(residualRiskRun);

  assert.match(report.scenarioIssues[0].reason, /环境可能残留配置/);
});
