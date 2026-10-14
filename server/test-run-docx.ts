import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel,
  Packer, PageNumber, Paragraph, ShadingType, Table, TableCell,
  TableLayoutType, TableRow, TextRun, WidthType,
} from "docx";
import type { CaseRun, ExecutionStatus, TestRunReportContext } from "./catalog-store.js";
import { stepRowsFromLegacy } from "../shared/test-case-steps.js";
import { buildTestRunReport, formatRunDuration, previewReportText, type ReportCaseResult, type ReportStepResult } from "../shared/test-run-report.js";
import { FAILURE_TYPE_LABELS, STEP_CHECK_LABELS } from "../shared/test-result.js";

export const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const MARGIN = 1134;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const STATUS_LABELS: Record<ExecutionStatus, string> = {
  queued: "等待执行", running: "执行中", completed: "已完成", failed: "执行失败", cancelled: "已取消",
};
const RESULT_LABELS = { passed: "通过", failed: "失败", cancelled: "已取消", pending: "未完成" };
const RESULT_COLORS = { passed: "237A47", failed: "B42318", cancelled: "667085", pending: "A15C00" };

function paragraphs(value: string | undefined, fallback = "未记录"): Paragraph[] {
  // Word requires paragraphs for newlines. Strip characters forbidden by XML 1.0.
  const text = (value || fallback).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");
  return text.split(/\r\n|\r|\n/).map((line) => new Paragraph({
    children: [new TextRun(line)], spacing: { after: 80 },
  }));
}

function heading(text: string, level: typeof HeadingLevel.HEADING_1 | typeof HeadingLevel.HEADING_2 | typeof HeadingLevel.HEADING_3): Paragraph {
  return new Paragraph({ text, heading: level, keepNext: true });
}

function field(label: string, value?: string, fallback = "未记录"): Paragraph[] {
  return [new Paragraph({
    children: [new TextRun({ text: label, bold: true, color: "344054" })],
    keepNext: true, spacing: { before: 140, after: 70 },
  }), ...paragraphs(value, fallback)];
}

function table(headers: string[], rows: string[][], widths: number[]): Table {
  const makeRow = (values: string[], isHeader = false) => new TableRow({
    tableHeader: isHeader,
    // Allow long steps to flow onto the next page rather than being clipped.
    cantSplit: isHeader,
    children: widths.map((width, index) => new TableCell({
      width: { size: width, type: WidthType.DXA },
      shading: isHeader ? { type: ShadingType.CLEAR, fill: "EAF0F7" } : undefined,
      margins: { top: 100, bottom: 100, left: 120, right: 120 },
      children: isHeader
        ? [new Paragraph({ children: [new TextRun({ text: headers[index], bold: true })], spacing: { after: 0 } })]
        : paragraphs(values[index], "—"),
    })),
  });
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: widths, layout: TableLayoutType.FIXED,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "D0D5DD" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "D0D5DD" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "D0D5DD" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "D0D5DD" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "D0D5DD" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "D0D5DD" },
    },
    rows: [makeRow(headers, true), ...rows.map((row) => makeRow(row))],
  });
}

function dateTime(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(value));
}

function duration(start?: string, finish?: string): string {
  const value = start && finish ? Date.parse(finish) - Date.parse(start) : undefined;
  return formatRunDuration(value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined);
}

function resultParagraph(item: ReportCaseResult): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: `结果：${RESULT_LABELS[item.state]}`, bold: true, color: RESULT_COLORS[item.state] }),
      new TextRun(`    执行状态：${STATUS_LABELS[item.status]}    耗时：${formatRunDuration(item.durationMs)}`)],
    spacing: { before: 100, after: 100 },
  });
}

function stepResultLabel(row: ReportStepResult): string {
  return row.result ? STEP_CHECK_LABELS[row.result] : "未记录";
}

function hasStructuredResult(item: ReportCaseResult): boolean {
  const details = item.resultDetails;
  return Boolean(item.steps || details?.failureType || details?.evidenceList?.length || details?.notes || details?.log);
}

function conclusion(item: ReportCaseResult, snapshot: CaseRun, failureDetails = false): (Paragraph | Table)[] {
  const details = item.resultDetails;
  if (!hasStructuredResult(item)) {
    return [
      ...field("执行结论", item.summary),
      ...(failureDetails || details?.expected ? field("预期结果", details?.expected || snapshot.expectedResultSnapshot) : []),
      ...(failureDetails || details?.actual ? field("实际观察", details?.actual, "未单独记录，请参阅执行结论") : []),
      ...(failureDetails || details?.evidence ? field("关键证据", details?.evidence, "未单独记录，请参阅执行结论") : []),
    ];
  }
  const unmet = failureDetails ? (item.steps || []).filter((row) => row.result !== "passed") : [];
  return [
    ...field("执行结论", item.summary),
    ...(item.failureType ? field("失败类型", FAILURE_TYPE_LABELS[item.failureType]) : []),
    ...(unmet.length ? [
      new Paragraph({ children: [new TextRun({ text: "未满足的步骤", bold: true, color: "344054" })], keepNext: true, spacing: { before: 140, after: 70 } }),
      table(["步骤", "预期", "实际", "结果"], unmet.map((row) => [String(row.index), row.expected, row.actual || "", stepResultLabel(row)]),
        [700, 3500, 4300, CONTENT_WIDTH - 8500]),
    ] : []),
    ...(details?.evidenceList?.length ? field("关键证据", details.evidenceList.map((entry) => `• ${entry}`).join("\n")) : []),
    ...(details?.notes ? field("备注", details.notes) : []),
    ...(details?.log ? paragraphs("完整执行记录见附录。") : []),
  ];
}

export function testRunReportFilename(context: TestRunReportContext): string {
  const safeName = (value: string) => value.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").trim().slice(0, 60) || "未命名";
  const stamp = (context.testRun.startedAt || context.testRun.createdAt).replace(/[^0-9]/g, "").slice(0, 14);
  return `${safeName(context.product.name)}_${safeName(context.testOrder.name)}_测试报告_${stamp}_${safeName(context.testRun.id).slice(0, 8)}.docx`;
}

export async function generateTestRunDocx(context: TestRunReportContext): Promise<Buffer> {
  const { product, testOrder, testRun: run } = context;
  const report = buildTestRunReport(run);
  const caseSnapshots = new Map(run.caseRuns.map((item) => [item.id, item]));
  const overall = run.status === "completed" && run.outcome
    ? (run.outcome === "passed" ? "通过" : "失败") : STATUS_LABELS[run.status];
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: "自动化测试报告", heading: HeadingLevel.TITLE, spacing: { after: 180 } }),
    new Paragraph({ text: testOrder.name, spacing: { after: 220 } }),
    heading("1. 执行概况", HeadingLevel.HEADING_1),
    table(["项目", "内容"], [
      ["产品", product.name], ["测试单", testOrder.name], ["执行编号", run.id],
      ["执行范围", run.triggerType === "all" ? "整单执行" : "单用例执行"],
      ["整体结果", overall], ["开始时间", dateTime(run.startedAt || run.createdAt)],
      ["结束时间", dateTime(run.finishedAt)], ["执行耗时", duration(run.startedAt, run.finishedAt)],
      ["测试场景数", String(run.scenarioRuns.length)],
    ], [2200, CONTENT_WIDTH - 2200]),
    new Paragraph({ text: "时间以北京时间（UTC+8）显示。", spacing: { before: 120, after: 160 } }),
    table(["用例总数", "通过", "失败", "未完成", "通过率"], [[
      String(report.total), String(report.passed), String(report.failed), String(report.incomplete), `${report.passRate}%`,
    ]], [1928, 1928, 1928, 1928, CONTENT_WIDTH - 1928 * 4]),
    new Paragraph({ text: "通过率 = 通过用例数 / 本次执行用例总数；未完成包含取消执行和未产生测试结论的用例。", spacing: { before: 120 } }),
    heading("2. 失败用例", HeadingLevel.HEADING_1),
  ];
  if (!report.failedCases.length) children.push(...paragraphs("没有失败用例。"));
  report.failedCases.forEach((item, index) => {
    children.push(heading(`2.${index + 1} ${item.name}`, HeadingLevel.HEADING_2),
      ...paragraphs(`测试场景：${item.scenarioName}`), resultParagraph(item),
      ...conclusion(item, caseSnapshots.get(item.id)!, true));
  });
  children.push(heading("3. 场景异常", HeadingLevel.HEADING_1));
  if (!report.scenarioIssues.length) children.push(...paragraphs("没有记录场景异常。"));
  report.scenarioIssues.forEach((issue, index) => {
    children.push(heading(`3.${index + 1} ${issue.scenarioName} · ${issue.phase}`, HeadingLevel.HEADING_2),
      ...field("原因", issue.reason));
  });
  children.push(heading("4. 全部用例结果", HeadingLevel.HEADING_1));
  if (report.cases.length) {
    const multipleScenarios = run.scenarioRuns.length > 1;
    children.push(table(["序号", "用例名称", "结果", "结论", "耗时"], report.cases.map((item, index) => [
      String(index + 1),
      multipleScenarios ? `${item.name}\n${item.scenarioName}` : item.name,
      item.failureType ? `${RESULT_LABELS[item.state]}\n${FAILURE_TYPE_LABELS[item.failureType]}` : RESULT_LABELS[item.state],
      previewReportText(item.summary, 80),
      formatRunDuration(item.durationMs),
    ]), [700, 2700, 1000, CONTENT_WIDTH - 5600, 1200]));
  } else children.push(...paragraphs("本次执行没有用例记录。"));

  children.push(heading("5. 场景与用例详情", HeadingLevel.HEADING_1));
  const included = new Set<string>();
  const appendCase = (item: ReportCaseResult, prefix: string) => {
    included.add(item.id);
    const snapshot = caseSnapshots.get(item.id)!;
    const rows = snapshot.stepRowsSnapshot?.length
      ? snapshot.stepRowsSnapshot : stepRowsFromLegacy(snapshot.stepsSnapshot, snapshot.expectedResultSnapshot);
    children.push(heading(`${prefix} ${item.name}`, HeadingLevel.HEADING_3),
      ...paragraphs(`用例 ID：${snapshot.testCaseId}`), resultParagraph(item),
      ...field("前置条件", snapshot.preconditionSnapshot, "未设置"),
      new Paragraph({ text: "用例步骤", keepNext: true, spacing: { before: 140, after: 70 } }),
      item.steps
        ? table(["序号", "步骤", "预期", "实际", "结果"], item.steps.map((row) => [String(row.index), row.step, row.expected, row.actual || "", stepResultLabel(row)]),
          [700, 2600, 2300, 2900, CONTENT_WIDTH - 8500])
        : table(["序号", "步骤", "预期"], rows.map((row, index) => [String(index + 1), row.step, row.expected]),
          [900, 4369, CONTENT_WIDTH - 5269]),
      ...conclusion(item, snapshot));
  };
  run.scenarioRuns.forEach((scenario, index) => {
    children.push(heading(`5.${index + 1} ${scenario.scenarioNameSnapshot}`, HeadingLevel.HEADING_2),
      ...paragraphs(`场景执行状态：${STATUS_LABELS[scenario.status]}    耗时：${duration(scenario.startedAt, scenario.finishedAt)}`));
    if (scenario.summary) children.push(...field("场景执行结论", scenario.summary));
    if (scenario.cleanupOutcome || scenario.cleanupSummary) children.push(...field("场景清理", [
      scenario.cleanupOutcome ? `结果：${scenario.cleanupOutcome === "passed" ? "通过" : "失败"}` : "",
      scenario.cleanupSummary,
    ].filter(Boolean).join("\n")));
    // Preserve saved execution order rather than consulting today's case/scenario library.
    const cases = report.cases.filter((item) => caseSnapshots.get(item.id)!.scenarioRunId === scenario.id);
    cases.forEach((item, caseIndex) => appendCase(item, `5.${index + 1}.${caseIndex + 1}`));
  });
  const unmatched = report.cases.filter((item) => !included.has(item.id));
  if (unmatched.length) {
    children.push(heading(`5.${run.scenarioRuns.length + 1} 未关联场景的历史用例`, HeadingLevel.HEADING_2));
    unmatched.forEach((item, index) => appendCase(item, `5.${run.scenarioRuns.length + 1}.${index + 1}`));
  }
  const logged = report.cases.filter((item) => item.resultDetails?.log);
  if (logged.length) {
    children.push(heading("附录 完整执行记录", HeadingLevel.HEADING_1));
    logged.forEach((item, index) => {
      children.push(heading(`附录 ${index + 1} ${item.name}`, HeadingLevel.HEADING_2), ...paragraphs(item.resultDetails!.log));
    });
  }
  const doc = new Document({
    title: `${product.name} · ${testOrder.name} · 测试报告`, creator: "AI Test Runner",
    description: "基于已保存执行快照生成的自动化测试报告",
    styles: {
      default: {
        document: { run: { font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" }, size: 21, color: "1D2939" },
          paragraph: { spacing: { after: 100, line: 300 } } },
        title: { run: { size: 40, bold: true, color: "17365D" } },
        heading1: { run: { size: 28, bold: true, color: "17365D" }, paragraph: { spacing: { before: 320, after: 180 } } },
        heading2: { run: { size: 24, bold: true, color: "344054" }, paragraph: { spacing: { before: 260, after: 140 } } },
        heading3: { run: { size: 22, bold: true, color: "344054" }, paragraph: { spacing: { before: 220, after: 120 } } },
      },
    },
    sections: [{
      properties: { page: { size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
        margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 560, footer: 560 } } },
      headers: { default: new Header({ children: [new Paragraph({
        children: [new TextRun({ text: "自动化测试报告", size: 18, color: "667085" })],
      })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: "第 ", size: 18 }), new TextRun({ children: [PageNumber.CURRENT], size: 18 }),
        new TextRun({ text: " 页 / 共 ", size: 18 }), new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18 }),
        new TextRun({ text: " 页", size: 18 }),
      ] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}
