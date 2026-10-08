import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import type { TestRunReportContext } from "./catalog-store.js";
import { generateTestRunDocx, testRunReportFilename } from "./test-run-docx.js";

function fixture(): TestRunReportContext {
  return {
    product: { id: "product-1", name: "WKCJ-II" },
    testOrder: { id: "order-1", name: "转发验证", description: "" },
    testRun: {
      id: "run-1", testOrderId: "order-1", triggerType: "all", status: "failed", outcome: "failed",
      createdAt: "2026-10-07T01:00:00Z", startedAt: "2026-10-07T01:00:00Z", finishedAt: "2026-10-07T01:02:05Z",
      scenarioRuns: [{
        id: "scene-run", testScenarioId: "scene-1", scenarioNameSnapshot: "场景旧名称", isDefault: false,
        status: "failed", summary: "搭建错误\n设备返回失败", cleanupOutcome: "failed", cleanupSummary: "恢复失败\n交换机未响应",
        roleBindings: {}, parameterValues: {}, caseRunIds: ["case-run-1", "case-run-2", "case-run-3"],
      }],
      caseRuns: [{
        id: "case-run-1", testCaseId: "case-1", scenarioRunId: "scene-run", caseNameSnapshot: "历史失败用例",
        preconditionSnapshot: "两端链路已接通\n关闭防火墙", stepsSnapshot: "兼容步骤不应覆盖新快照", expectedResultSnapshot: "流量完整转发",
        stepRowsSnapshot: [{ step: "启动抓包", expected: "" }, { step: "发送报文\n读取计数", expected: "接收到报文\n无丢包" }],
        status: "completed", outcome: "failed", summary: `结论第一行\n${"未达到预期。".repeat(100)}完整结论尾部`,
        resultDetails: { expected: "吞吐率 >= 95%", actual: "实际吞吐率 80%", evidence: "RX 800\nTX 1000\n证据最后一行" },
      }, {
        id: "case-run-2", testCaseId: "case-2", scenarioRunId: "scene-run", caseNameSnapshot: "旧版通过用例",
        preconditionSnapshot: "", stepsSnapshot: "1. 登录\n2. 检查状态", expectedResultSnapshot: "1. 登录成功\n2. 状态正常",
        status: "completed", outcome: "passed", summary: "旧版结论\n状态符合预期",
      }, {
        id: "case-run-3", testCaseId: "case-3", scenarioRunId: "scene-run", caseNameSnapshot: "未完成用例",
        preconditionSnapshot: "", stepsSnapshot: "读取版本", expectedResultSnapshot: "版本正确", status: "cancelled", summary: "已取消",
      }],
    },
  };
}

test("Word exports full multiline conclusions, paired snapshots, legacy steps and all execution states", async () => {
  const context = fixture();
  const before = structuredClone(context);
  const zip = await JSZip.loadAsync(await generateTestRunDocx(context));
  const xml = await zip.file("word/document.xml")!.async("string");
  assert.match(xml, /完整结论尾部/);
  assert.match(xml, /结论第一行<\/w:t>[\s\S]*?<\/w:p><w:p>/);
  for (const content of ["吞吐率 &gt;= 95%", "实际吞吐率 80%", "证据最后一行", "场景旧名称", "搭建错误", "交换机未响应", "旧版结论", "登录成功", "状态正常", "33%", "未完成", "已取消", "2026\/10\/07 09:00:00", "2 分 5 秒"]) {
    assert.ok(xml.includes(content), `missing report content: ${content}`);
  }
  const stepsTable = [...xml.matchAll(/<w:tbl>.*?<\/w:tbl>/g)].map((match) => match[0]).find((value) => value.includes("启动抓包"))!;
  const rows = [...stepsTable.matchAll(/<w:tr>.*?<\/w:tr>/g)].map((match) => match[0]);
  assert.equal(rows.length, 3);
  assert.match(rows[1], /启动抓包/);
  assert.doesNotMatch(rows[1], /接收到报文/);
  assert.match(rows[2], /发送报文/);
  assert.match(rows[2], /接收到报文/);
  assert.doesNotMatch(xml, /兼容步骤不应覆盖新快照/);
  assert.match(xml, /<w:tblHeader\/>/);
  assert.match(xml, /w:val="Heading1"/);
  for (const value of [...xml.matchAll(/<w:tbl>.*?<\/w:tbl>/g)].map((match) => match[0])) {
    const widths = [...value.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((match) => Number(match[1]));
    assert.equal(widths.reduce((sum, width) => sum + width, 0), 9638);
    assert.ok(value.includes('w:type="dxa"'));
  }
  const footer = await zip.file("word/footer1.xml")!.async("string");
  assert.match(footer, /PAGE/);
  assert.match(footer, /NUMPAGES/);
  assert.deepEqual(context, before);
});

test("Word exports empty old runs and cases without an associated scenario", async () => {
  const context = fixture();
  context.testRun.scenarioRuns = [];
  context.testRun.caseRuns = [context.testRun.caseRuns[1]];
  const zip = await JSZip.loadAsync(await generateTestRunDocx(context));
  const xml = await zip.file("word/document.xml")!.async("string");
  assert.match(xml, /未关联场景的历史用例/);
  assert.match(xml, /旧版通过用例/);
  context.testRun.caseRuns = [];
  context.testRun.startedAt = "invalid-date";
  const emptyZip = await JSZip.loadAsync(await generateTestRunDocx(context));
  assert.match(await emptyZip.file("word/document.xml")!.async("string"), /本次执行没有用例记录/);
});

test("Word sanitizes invalid XML control characters and unsafe download names", async () => {
  const context = fixture();
  context.product.name = '产品/名称\r\n';
  context.testOrder.name = '测试单:"<bad>';
  context.testRun.caseRuns[0].summary = "控制字符\u0000\u001b仍可阅读";
  const filename = testRunReportFilename(context);
  assert.ok(filename.endsWith(".docx"));
  assert.doesNotMatch(filename, /[\r\n/\\:"<>]/);
  const zip = await JSZip.loadAsync(await generateTestRunDocx(context));
  const xml = await zip.file("word/document.xml")!.async("string");
  assert.match(xml, /控制字符仍可阅读/);
  assert.doesNotMatch(xml, /\u0000|\u001b/);
});
