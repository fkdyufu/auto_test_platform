import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Download, FileText, LoaderCircle, MessageSquareText, X } from "lucide-react";
import { api, type RunStatus, type TestRun } from "../api";
import { FAILURE_TYPE_LABELS, type FailureType, type TestResultDetails } from "../../shared/test-result";
import {
  buildTestRunReport,
  formatRunDuration,
  previewReportText,
  type ReportCaseResult,
  type ReportCaseState,
  type ReportStepResult,
} from "../test-run-report";

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "等待执行",
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

const CASE_STATE_LABELS: Record<ReportCaseState, string> = {
  passed: "通过",
  failed: "失败",
  cancelled: "已取消",
  pending: "未完成",
};

const FAILURE_TYPES: FailureType[] = ["product_defect", "case_issue", "environment"];

type CaseFilter = "all" | "failed" | "passed" | "incomplete";

type DiagnoseTarget = { caseRunId: string; caseName: string; scenarioName: string };

function formatDateTime(value?: string): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatTime(value?: string): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function runLabel(run: TestRun): string {
  if (run.status === "completed" && run.outcome) return run.outcome === "passed" ? "全部通过" : "存在失败";
  return RUN_STATUS_LABELS[run.status];
}

function StateDot({ state }: { state: ReportCaseState }) {
  return <span className={`report-dot ${state}`} title={CASE_STATE_LABELS[state]} aria-label={CASE_STATE_LABELS[state]} />;
}

function FailureTag({ type }: { type?: FailureType }) {
  return type ? <span className="report-tag">{FAILURE_TYPE_LABELS[type]}</span> : null;
}

function StepChecks({ rows, hiddenPassed = 0, onShowAll }: { rows: ReportStepResult[]; hiddenPassed?: number; onShowAll?: () => void }) {
  return (
    <div className="report-checks">
      <div className="report-check report-check-head"><span /><span>步骤</span><span>预期</span><span>实际</span></div>
      {rows.map((row) => (
        <div className={`report-check ${row.result || "unknown"}`} key={row.index}>
          <span className="report-check-icon">{row.result === "passed" ? "✓" : row.result === "failed" ? "✕" : "–"}</span>
          <span className="report-check-index">{row.index}</span>
          <span className="report-check-expected">{row.expected || "未指定单独预期"}</span>
          <span className="report-check-actual">{row.result === "not_run" ? `未执行${row.actual ? `：${row.actual}` : ""}` : row.actual || "未记录"}</span>
        </div>
      ))}
      {hiddenPassed > 0 && (
        <div className="report-checks-more">
          <span className="report-check-icon passed">✓</span>其余 {hiddenPassed} 步通过 ·{" "}
          <button type="button" className="report-link" onClick={onShowAll}>展开</button>
        </div>
      )}
    </div>
  );
}

function ResultFacts({ details }: { details?: TestResultDetails }) {
  return (
    <>
      {details?.evidenceList?.length ? (
        <div className="report-fact"><span>证据</span><ul>{details.evidenceList.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
      ) : null}
      {details?.notes && <div className="report-fact muted"><span>备注</span><p>{details.notes}</p></div>}
    </>
  );
}

function LegacyDetails({ item }: { item: ReportCaseResult }) {
  const fields = [
    { label: "预期", value: item.resultDetails?.expected },
    { label: "实际观察", value: item.resultDetails?.actual },
    { label: "关键证据", value: item.resultDetails?.evidence },
  ].filter((field) => Boolean(field.value));
  return (
    <details className="report-raw">
      <summary>完整执行结论</summary>
      <div className="report-raw-content">
        <div className="report-detail-field"><strong>结论</strong><p>{item.summary}</p></div>
        {fields.map((field) => (
          <div className="report-detail-field" key={field.label}><strong>{field.label}</strong><p>{field.value}</p></div>
        ))}
      </div>
    </details>
  );
}

function LogDetails({ log }: { log?: string }) {
  if (!log) return null;
  return (
    <details className="report-raw">
      <summary>完整执行记录</summary>
      <div className="report-raw-content"><p>{log}</p></div>
    </details>
  );
}

function FailureCard({ item, code, onDiagnose }: { item: ReportCaseResult; code?: string; onDiagnose: (target: DiagnoseTarget) => void }) {
  const [showAll, setShowAll] = useState(false);
  const unmet = item.steps?.filter((row) => row.result !== "passed") || [];
  const rows = showAll ? item.steps || [] : unmet;
  return (
    <article className="report-failure-card">
      <div className="report-failure-head">
        <div className="report-failure-title">
          <StateDot state={item.state} />
          <span className="report-case-name">{item.name}</span>
          {code && <span className="report-case-code">{code}</span>}
          <FailureTag type={item.failureType} />
        </div>
        <div className="report-failure-meta">
          <span>{formatRunDuration(item.durationMs)}</span>
          <button type="button" className="button secondary compact" onClick={() => onDiagnose({ caseRunId: item.id, caseName: item.name, scenarioName: item.scenarioName })}>
            <MessageSquareText size={14} />
            深入分析
          </button>
        </div>
      </div>
      <p className={`report-headline${item.steps ? "" : " legacy"}`}>{item.steps ? item.summary : previewReportText(item.summary, 140)}</p>
      <div className="report-failure-body">
        {item.steps && (
          <StepChecks rows={rows} hiddenPassed={showAll ? 0 : item.steps.length - unmet.length} onShowAll={() => setShowAll(true)} />
        )}
        <ResultFacts details={item.resultDetails} />
        {item.steps || item.resultDetails?.log ? <LogDetails log={item.resultDetails?.log} /> : <LegacyDetails item={item} />}
      </div>
    </article>
  );
}

function CaseRow({ item, code, onDiagnose }: { item: ReportCaseResult; code?: string; onDiagnose: (target: DiagnoseTarget) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`report-case-row${open ? " open" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <StateDot state={item.state} />
        <span className="report-case-name" title={item.name}>{item.name}{code && <small>{code}</small>}</span>
        <span className="report-case-headline" title={previewReportText(item.summary, 300)}>{previewReportText(item.summary, 120)}</span>
        <span className="report-case-tag"><FailureTag type={item.failureType} /></span>
        <span className="report-case-duration">{formatRunDuration(item.durationMs)}</span>
        {open ? <ChevronDown size={14} className="report-case-chevron" /> : <ChevronRight size={14} className="report-case-chevron" />}
      </button>
      {open && (
        <div className="report-case-expand">
          {item.steps ? <StepChecks rows={item.steps} /> : <p className="report-case-summary">{item.summary}</p>}
          <ResultFacts details={item.resultDetails} />
          <div className="report-case-actions">
            {item.steps || item.resultDetails?.log ? <LogDetails log={item.resultDetails?.log} /> : <LegacyDetails item={item} />}
            <button type="button" className="button secondary compact" onClick={() => onDiagnose({ caseRunId: item.id, caseName: item.name, scenarioName: item.scenarioName })}>
              <MessageSquareText size={14} />
              分析
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function TestRunReportDialog({
  productId,
  run,
  orderName,
  caseCodes = {},
  onDiagnose,
  onClose,
}: {
  productId: string;
  run: TestRun;
  orderName: string;
  // Display IDs keyed by test case ID, e.g. Zentao case numbers.
  caseCodes?: Record<string, string>;
  onDiagnose: (target: DiagnoseTarget) => void;
  onClose: () => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [filter, setFilter] = useState<CaseFilter>("all");
  const canExport = run.status !== "queued" && run.status !== "running";
  const report = buildTestRunReport(run);
  const totalDuration = run.startedAt && run.finishedAt
    ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
    : undefined;
  const codeOf = (item: ReportCaseResult) => (item.testCaseId ? caseCodes[item.testCaseId] : undefined);
  const typeBreakdown = FAILURE_TYPES
    .filter((type) => report.failureTypeCounts[type])
    .map((type) => `${FAILURE_TYPE_LABELS[type]} ${report.failureTypeCounts[type]}`);
  const scenarioNames = [...new Set(run.scenarioRuns.map((scenario) => scenario.scenarioNameSnapshot))];
  const filtered = report.cases.filter((item) =>
    filter === "all" || (filter === "incomplete" ? item.state === "cancelled" || item.state === "pending" : item.state === filter));
  const groups = scenarioNames.length > 1
    ? scenarioNames.map((name) => ({ name, cases: filtered.filter((item) => item.scenarioName === name) })).filter((group) => group.cases.length)
    : [{ name: "", cases: filtered }];
  const pct = (count: number) => `${report.total ? (count / report.total) * 100 : 0}%`;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function exportReport() {
    if (exporting || !canExport) return;
    setExporting(true);
    setExportError("");
    try {
      await api.downloadTestRunReport(productId, run.id);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "导出失败，请稍后重试");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="modal-backdrop report-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal test-run-report-modal" role="dialog" aria-modal="true" aria-label="执行报告">
        <header className="modal-header">
          <div className="report-modal-title"><FileText size={17} /><h2>执行报告</h2></div>
          <button type="button" className="icon-button static" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="modal-body report-body">
          {exportError && <p className="inline-notice error" role="alert">{exportError}</p>}
          <section className="report-overview">
            <div>
              <span className="detail-kicker">
                {run.triggerType === "all" ? "整单执行" : "单用例执行"}
                {scenarioNames.length === 1 ? ` · ${scenarioNames[0]}` : ` · ${scenarioNames.length} 个场景`}
                {` · ${runLabel(run)}`}
              </span>
              <h3>{orderName}</h3>
              <p>
                {formatDateTime(run.startedAt || run.createdAt)}
                {run.finishedAt ? ` – ${formatTime(run.finishedAt)}` : ""}
                {totalDuration !== undefined ? ` · 用时 ${formatRunDuration(totalDuration)}` : ""}
              </p>
            </div>
            <div className="report-score">
              <div className="report-score-line"><span><strong>{report.passRate}%</strong>通过</span><span>{report.total} 个用例</span></div>
              <div className="report-bar" aria-hidden="true">
                {report.passed > 0 && <span className="passed" style={{ width: pct(report.passed) }} />}
                {report.failed > 0 && <span className="failed" style={{ width: pct(report.failed) }} />}
                {report.incomplete > 0 && <span className="pending" style={{ width: pct(report.incomplete) }} />}
              </div>
              <div className="report-legend">
                <span>通过 <b>{report.passed}</b></span>
                <span>失败 <b>{report.failed}</b></span>
                {report.incomplete > 0 && <span>未完成 <b>{report.incomplete}</b></span>}
                {typeBreakdown.length > 0 && <span className="report-legend-types">{typeBreakdown.join(" · ")}</span>}
              </div>
            </div>
          </section>

          {report.scenarioIssues.length > 0 && (
            <section className="report-section">
              <div className="report-section-heading"><h4>场景异常 · {report.scenarioIssues.length}</h4></div>
              <div className="report-issue-list">
                {report.scenarioIssues.map((issue) => (
                  <div className="report-issue-row" key={issue.id}>
                    <span className="report-dot failed" />
                    <div>
                      <strong>{issue.scenarioName} · {issue.phase}</strong>
                      <p>{previewReportText(issue.reason, 200)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {report.failedCases.length > 0 && (
            <section className="report-section">
              <div className="report-section-heading">
                <h4>需要关注 · {report.failedCases.length}</h4>
                {report.failedCases.some((item) => item.steps) && <span>只展开不通过的步骤</span>}
              </div>
              <div className="report-failure-list">
                {report.failedCases.map((item) => <FailureCard key={item.id} item={item} code={codeOf(item)} onDiagnose={onDiagnose} />)}
              </div>
            </section>
          )}

          <section className="report-section">
            <div className="report-section-heading">
              <h4>全部用例 · {report.total}</h4>
              <div className="report-filter" role="tablist" aria-label="筛选用例">
                {([
                  ["all", "全部", report.total],
                  ["failed", "失败", report.failed],
                  ["passed", "通过", report.passed],
                  ["incomplete", "未完成", report.incomplete],
                ] as const).filter(([key, , count]) => key === "all" || count > 0).map(([key, label, count]) => (
                  <button type="button" role="tab" aria-selected={filter === key} className={filter === key ? "active" : ""} key={key} onClick={() => setFilter(key)}>
                    {label}{key === "all" ? "" : ` ${count}`}
                  </button>
                ))}
              </div>
            </div>
            <div className="report-case-list">
              {groups.map((group) => (
                <div key={group.name || "all"}>
                  {group.name && <div className="report-case-group">{group.name}</div>}
                  {group.cases.map((item) => <CaseRow key={item.id} item={item} code={codeOf(item)} onDiagnose={onDiagnose} />)}
                </div>
              ))}
              {filtered.length === 0 && <p className="report-empty">没有符合条件的用例</p>}
            </div>
          </section>
        </div>

        <footer className="modal-actions">
          <button type="button" className="button secondary" disabled={exporting || !canExport} onClick={() => void exportReport()} title={canExport ? "下载本次执行的 Word 报告" : "测试执行结束后才能导出报告"}>
            {exporting ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
            {exporting ? "正在生成…" : "导出 Word 报告"}
          </button>
          <button type="button" className="button primary" onClick={onClose}>关闭</button>
        </footer>
      </div>
    </div>
  );
}
