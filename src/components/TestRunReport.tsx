import { useEffect } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileText,
  MessageSquareText,
  MinusCircle,
  X,
  XCircle,
} from "lucide-react";
import type { RunStatus, TestRun } from "../api";
import { buildTestRunReport, formatRunDuration, type ReportCaseState } from "../test-run-report";

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

function formatDateTime(value?: string): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function runAppearance(run: TestRun): string {
  return run.status === "completed" && run.outcome ? run.outcome : run.status;
}

function runLabel(run: TestRun): string {
  if (run.status === "completed" && run.outcome) return run.outcome === "passed" ? "通过" : "失败";
  return RUN_STATUS_LABELS[run.status];
}

export function TestRunReportDialog({
  run,
  orderName,
  physicalEnvironmentName,
  onDiagnose,
  onClose,
}: {
  run: TestRun;
  orderName: string;
  physicalEnvironmentName: string;
  onDiagnose: (target: { caseRunId: string; caseName: string; scenarioName: string }) => void;
  onClose: () => void;
}) {
  const report = buildTestRunReport(run);
  const totalDuration = run.startedAt && run.finishedAt
    ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
    : undefined;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal test-run-report-modal" role="dialog" aria-modal="true" aria-label="执行报告">
        <header className="modal-header">
          <div className="report-modal-title"><FileText size={17} /><h2>执行报告</h2></div>
          <button type="button" className="icon-button static" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="modal-body report-body">
          <section className="report-overview">
            <div>
              <span className="detail-kicker">{run.triggerType === "all" ? "整单执行" : "单用例执行"}</span>
              <h3>{orderName}</h3>
              <p>{formatDateTime(run.startedAt || run.createdAt)} · {physicalEnvironmentName || "未配置物理环境"} · {formatRunDuration(totalDuration)}</p>
            </div>
            <span className={`status-badge report-status ${runAppearance(run)}`}>{runLabel(run)}</span>
          </section>

          <dl className="report-metrics">
            <div><dt>用例总数</dt><dd>{report.total}</dd></div>
            <div className="passed"><dt>通过</dt><dd>{report.passed}</dd></div>
            <div className="failed"><dt>失败</dt><dd>{report.failed}</dd></div>
            <div className="incomplete"><dt>未完成</dt><dd>{report.incomplete}</dd></div>
            <div><dt>通过率</dt><dd>{report.passRate}%</dd></div>
          </dl>

          {report.scenarioIssues.length > 0 && (
            <section className="report-section">
              <div className="report-section-heading">
                <div><AlertTriangle size={16} /><h4>场景异常</h4></div>
                <span>{report.scenarioIssues.length} 项</span>
              </div>
              <div className="report-issue-list">
                {report.scenarioIssues.map((issue) => (
                  <div className="report-issue-row" key={issue.id}>
                    <span className="status-badge failed">{issue.phase}</span>
                    <div><strong>{issue.scenarioName}</strong><p>{issue.reason}</p></div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="report-section">
            <div className="report-section-heading">
              <div><XCircle size={16} /><h4>失败项</h4></div>
              <span>{report.failedCases.length} 项</span>
            </div>
            {report.failedCases.length > 0 ? (
              <div className="report-failure-list">
                {report.failedCases.map((item) => (
                  <div className="report-failure-row" key={item.id}>
                    <XCircle size={16} />
                    <div>
                      <div className="report-result-title"><strong>{item.name}</strong><span>{item.scenarioName}</span></div>
                      <p>{item.summary}</p>
                    </div>
                    <small>{formatRunDuration(item.durationMs)}</small>
                    <button
                      type="button"
                      className="button secondary compact"
                      onClick={() => onDiagnose({ caseRunId: item.id, caseName: item.name, scenarioName: item.scenarioName })}
                    >
                      <MessageSquareText size={14} />
                      深入分析
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="report-no-failures"><CheckCircle2 size={17} /><span>没有失败用例</span></div>
            )}
          </section>

          <section className="report-section">
            <div className="report-section-heading">
              <div><FileText size={16} /><h4>全部用例结果</h4></div>
              <span>{report.total} 项</span>
            </div>
            <div className="table-wrap report-results-wrap">
              <table className="data-table report-results-table">
                <thead><tr><th>结果</th><th>测试场景</th><th>用例名称</th><th>执行结论</th><th>耗时</th><th aria-label="操作" /></tr></thead>
                <tbody>
                  {report.cases.map((item) => (
                    <tr key={item.id}>
                      <td><span className={`status-badge ${item.state}`}>{CASE_STATE_LABELS[item.state]}</span></td>
                      <td>{item.scenarioName}</td>
                      <td className="name-cell">{item.name}</td>
                      <td className="report-summary-cell">{item.summary}</td>
                      <td className="report-duration-cell">
                        {item.state === "passed" ? <CheckCircle2 size={13} /> : item.state === "failed" ? <XCircle size={13} /> : item.state === "cancelled" ? <MinusCircle size={13} /> : <Clock3 size={13} />}
                        {formatRunDuration(item.durationMs)}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button secondary compact"
                          onClick={() => onDiagnose({ caseRunId: item.id, caseName: item.name, scenarioName: item.scenarioName })}
                        >
                          <MessageSquareText size={14} />
                          分析
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <footer className="modal-actions">
          <button type="button" className="button primary" onClick={onClose}>关闭</button>
        </footer>
      </div>
    </div>
  );
}
