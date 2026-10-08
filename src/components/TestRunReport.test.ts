import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TestRun } from "../api";
import { TestRunReportDialog } from "./TestRunReport";

test("reports preview long legacy failures and retain multiline structured details", () => {
  const run: TestRun = {
    id: "run-1",
    testOrderId: "order-1",
    triggerType: "all",
    status: "completed",
    createdAt: "2026-09-29T01:00:00.000Z",
    scenarioRuns: [{
      id: "scenario-run-1",
      testScenarioId: "scenario-1",
      scenarioNameSnapshot: "端口镜像",
      isDefault: false,
      status: "completed",
      roleBindings: {},
      parameterValues: {},
      caseRunIds: ["case-run-1", "case-run-2"],
    }],
    caseRuns: [{
      id: "case-run-1",
      testCaseId: "case-1",
      scenarioRunId: "scenario-run-1",
      caseNameSnapshot: "旧用例",
      preconditionSnapshot: "",
      stepsSnapshot: "检查状态",
      expectedResultSnapshot: "流量通过",
      status: "completed",
      outcome: "failed",
      summary: `故障概况\n${"实际收不到流量。".repeat(40)}`,
    }, {
      id: "case-run-2",
      testCaseId: "case-2",
      scenarioRunId: "scenario-run-1",
      caseNameSnapshot: "新用例",
      preconditionSnapshot: "",
      stepsSnapshot: "检查状态",
      expectedResultSnapshot: "流量通过",
      status: "completed",
      outcome: "failed",
      summary: "转发失败",
      resultDetails: { expected: "计数增加", actual: "计数未增加", evidence: "端口计数\n0 packets" },
    }],
  };

  const markup = renderToStaticMarkup(createElement(TestRunReportDialog, { productId: "product-1", run, orderName: "性能测试", onDiagnose: () => undefined, onClose: () => undefined }));
  assert.match(markup, /故障概况 实际收不到流量/);
  assert.match(markup, /故障概况\n实际收不到流量/);
  assert.match(markup, /<details class="report-details">/);
  assert.match(markup, /<strong>预期<\/strong><p>计数增加<\/p>/);
  assert.match(markup, /<strong>实际观察<\/strong><p>计数未增加<\/p>/);
  assert.match(markup, /端口计数\n0 packets/);
  assert.match(markup, /导出 Word 报告/);
  assert.doesNotMatch(markup, /disabled=""/);
  const runningMarkup = renderToStaticMarkup(createElement(TestRunReportDialog, { productId: "product-1", run: { ...run, status: "running" }, orderName: "性能测试", onDiagnose: () => undefined, onClose: () => undefined }));
  assert.match(runningMarkup, /disabled=""[^>]*title="测试执行结束后才能导出报告"/);
});
