import type { TestResultDetails } from "./test-result.js";

type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface CaseRun {
  id: string;
  scenarioRunId: string;
  caseNameSnapshot: string;
  status: RunStatus;
  outcome?: "passed" | "failed";
  summary?: string;
  resultDetails?: TestResultDetails;
  startedAt?: string;
  finishedAt?: string;
}

interface ReportRunSource {
  caseRuns: readonly CaseRun[];
  scenarioRuns: readonly {
    id: string;
    scenarioNameSnapshot: string;
    status: RunStatus;
    summary?: string;
    cleanupOutcome?: "passed" | "failed";
    cleanupSummary?: string;
  }[];
}

export type ReportCaseState = "passed" | "failed" | "cancelled" | "pending";

export interface ReportCaseResult {
  id: string;
  name: string;
  scenarioName: string;
  state: ReportCaseState;
  status: RunStatus;
  summary: string;
  resultDetails?: TestResultDetails;
  durationMs?: number;
}

export interface ReportScenarioIssue {
  id: string;
  scenarioName: string;
  phase: "场景执行" | "场景清理";
  reason: string;
}

export interface TestRunReport {
  total: number;
  passed: number;
  failed: number;
  incomplete: number;
  passRate: number;
  cases: ReportCaseResult[];
  failedCases: ReportCaseResult[];
  scenarioIssues: ReportScenarioIssue[];
}

export function previewReportText(value: string, limit = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}…` : normalized;
}

function durationMs(startedAt?: string, finishedAt?: string): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const value = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function caseState(caseRun: CaseRun): ReportCaseState {
  if (caseRun.outcome === "passed") return "passed";
  if (caseRun.outcome === "failed") return "failed";
  if (caseRun.status === "cancelled") return "cancelled";
  return "pending";
}

export function formatRunDuration(value?: number): string {
  if (value === undefined) return "-";
  const seconds = Math.max(1, Math.round(value / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${remainingSeconds} 秒`;
  return `${seconds} 秒`;
}

export function buildTestRunReport(run: ReportRunSource): TestRunReport {
  const scenarioByRunId = new Map(run.scenarioRuns.map((scenario) => [scenario.id, scenario]));
  const cases = run.caseRuns.map((caseRun): ReportCaseResult => {
    const scenario = scenarioByRunId.get(caseRun.scenarioRunId);
    const state = caseState(caseRun);
    return {
      id: caseRun.id,
      name: caseRun.caseNameSnapshot,
      scenarioName: scenario?.scenarioNameSnapshot || "场景已删除",
      state,
      status: caseRun.status,
      summary: caseRun.summary || (state === "pending" ? "尚未执行或未产生结论" : "未记录执行结论"),
      resultDetails: caseRun.resultDetails,
      durationMs: durationMs(caseRun.startedAt, caseRun.finishedAt),
    };
  });

  const passed = cases.filter((item) => item.state === "passed").length;
  const failed = cases.filter((item) => item.state === "failed").length;
  const incomplete = cases.length - passed - failed;
  const scenarioIssues: ReportScenarioIssue[] = [];

  for (const scenario of run.scenarioRuns) {
    if (scenario.status === "failed") {
      scenarioIssues.push({
        id: `${scenario.id}-execution`,
        scenarioName: scenario.scenarioNameSnapshot,
        phase: "场景执行",
        reason: scenario.summary || "场景搭建或执行失败，未记录具体原因",
      });
    } else if (scenario.status === "cancelled") {
      scenarioIssues.push({
        id: `${scenario.id}-execution`,
        scenarioName: scenario.scenarioNameSnapshot,
        phase: "场景执行",
        reason: "测试执行已取消，场景内仍有用例未完成",
      });
    }
    if (scenario.cleanupOutcome === "failed") {
      scenarioIssues.push({
        id: `${scenario.id}-cleanup`,
        scenarioName: scenario.scenarioNameSnapshot,
        phase: "场景清理",
        reason: scenario.cleanupSummary || "场景清理失败，未记录具体原因",
      });
    }
  }

  return {
    total: cases.length,
    passed,
    failed,
    incomplete,
    passRate: cases.length ? Math.round((passed / cases.length) * 100) : 0,
    cases,
    failedCases: cases.filter((item) => item.state === "failed"),
    scenarioIssues,
  };
}
