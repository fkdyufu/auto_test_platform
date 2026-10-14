import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TestRun } from "../api";
import { TestRunReportDialog } from "./TestRunReport";

test("reports show structured conclusions and keep legacy conclusions readable", () => {
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

  run.caseRuns.push({
    id: "case-run-3",
    testCaseId: "case-3",
    scenarioRunId: "scenario-run-1",
    caseNameSnapshot: "结构化用例",
    preconditionSnapshot: "",
    stepsSnapshot: "",
    expectedResultSnapshot: "",
    stepRowsSnapshot: [{ step: "保存配置", expected: "保存成功" }, { step: "抓包", expected: "收到镜像报文" }],
    status: "completed",
    outcome: "failed",
    summary: "观察主机未收到镜像报文",
    resultDetails: {
      failureType: "product_defect",
      checks: [{ step: 1, result: "passed", actual: "保存成功" }, { step: 2, result: "failed", actual: "抓包 0 包" }],
      evidenceList: ["tcpdump：0 packets captured"],
      notes: "推测：tc 规则未下发",
      log: "完整执行过程",
    },
  });

  const markup = renderToStaticMarkup(createElement(TestRunReportDialog, { productId: "product-1", run, orderName: "性能测试", caseCodes: { "case-3": "Z-503" }, onDiagnose: () => undefined, onClose: () => undefined }));
  // Legacy conclusions: preview in the card, full text and free-text fields behind a disclosure.
  assert.match(markup, /故障概况 实际收不到流量/);
  assert.match(markup, /故障概况\n实际收不到流量/);
  assert.match(markup, /<strong>预期<\/strong><p>计数增加<\/p>/);
  assert.match(markup, /<strong>实际观察<\/strong><p>计数未增加<\/p>/);
  assert.match(markup, /端口计数\n0 packets/);
  // Structured conclusions: headline, failure type, only the unmet step, evidence, notes and collapsed log.
  assert.match(markup, /<p class="report-headline">观察主机未收到镜像报文<\/p>/);
  assert.match(markup, /<span class="report-tag">产品缺陷<\/span>/);
  assert.match(markup, /Z-503/);
  assert.match(markup, /收到镜像报文<\/span><span class="report-check-actual">抓包 0 包/);
  assert.match(markup, /其余 1 步通过/);
  assert.match(markup, /<li>tcpdump：0 packets captured<\/li>/);
  assert.match(markup, /推测：tc 规则未下发/);
  assert.match(markup, /<summary>完整执行记录<\/summary>/);
  assert.match(markup, /产品缺陷 1/);
  // Product defects are listed before untyped legacy failures.
  assert.ok(markup.indexOf("结构化用例") < markup.indexOf("旧用例"));
  assert.match(markup, /导出 Word 报告/);
  assert.doesNotMatch(markup, /disabled=""/);
  const runningMarkup = renderToStaticMarkup(createElement(TestRunReportDialog, { productId: "product-1", run: { ...run, status: "running" }, orderName: "性能测试", onDiagnose: () => undefined, onClose: () => undefined }));
  assert.match(runningMarkup, /disabled=""[^>]*title="测试执行结束后才能导出报告"/);
});
