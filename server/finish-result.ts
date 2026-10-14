import type { FailureType, StepCheck, StepCheckResult, TestResultDetails } from "../shared/test-result.js";

export const HEADLINE_MAX_LENGTH = 60;
export const CHECK_ACTUAL_MAX_LENGTH = 200;
export const EVIDENCE_ITEM_MAX_LENGTH = 200;
export const EVIDENCE_MAX_ITEMS = 12;
export const NOTES_MAX_LENGTH = 300;
// After this many rejected submissions the next one is stored as-is (normalized) so a run never loses its result over formatting.
export const MAX_FORMAT_REJECTIONS = 3;

export interface FinishResult extends TestResultDetails {
  status: "passed" | "failed";
  summary: string;
}

export interface FinishSubmission {
  status: "passed" | "failed";
  headline: string;
  failureType?: FailureType;
  checks?: { step: number; result: StepCheckResult; actual: string }[];
  evidence?: string[];
  notes?: string;
  log?: string;
}

export interface FinishRules {
  // Number of step rows in the case; undefined outside test-case execution.
  stepCount?: number;
}

const FAILURE_TYPES = new Set<FailureType>(["product_defect", "case_issue", "environment"]);
const CHECK_RESULTS = new Set<StepCheckResult>(["passed", "failed", "not_run"]);

export function textLength(value: string): number {
  return [...value].length;
}

function truncate(value: string, limit: number): string {
  const chars = [...value];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : value;
}

function clean(value: string | undefined): string {
  return (value || "").trim();
}

function collectProblems(submission: FinishSubmission, rules: FinishRules): string[] {
  const problems: string[] = [];
  const headline = clean(submission.headline);
  if (!headline) problems.push("headline 不能为空");
  else if (/[\r\n]/.test(headline)) problems.push("headline 只能是一句话，不能换行");
  else if (textLength(headline) > HEADLINE_MAX_LENGTH) {
    problems.push(`headline 有 ${textLength(headline)} 字，超过 ${HEADLINE_MAX_LENGTH} 字上限；只写结论本身，过程和细节放到 checks、evidence 或 log`);
  }

  if (rules.stepCount !== undefined) {
    if (submission.status === "failed" && !submission.failureType) {
      problems.push("status 为 failed 时必须填写 failureType（product_defect、case_issue 或 environment）");
    }
    const checks = submission.checks || [];
    if (checks.length !== rules.stepCount) {
      problems.push(`checks 须与用例的 ${rules.stepCount} 个步骤一一对应，当前提交了 ${checks.length} 条`);
    } else {
      const steps = checks.map((check) => check.step).sort((a, b) => a - b);
      if (steps.some((step, index) => step !== index + 1)) problems.push(`checks 的 step 须恰好为 1 到 ${rules.stepCount} 各一次`);
    }
    checks.forEach((check) => {
      const actual = clean(check.actual);
      if (!actual) problems.push(`步骤 ${check.step} 的 actual 不能为空`);
      else if (textLength(actual) > CHECK_ACTUAL_MAX_LENGTH) problems.push(`步骤 ${check.step} 的 actual 超过 ${CHECK_ACTUAL_MAX_LENGTH} 字，只写与预期对照的关键观察`);
    });
    if (submission.status === "passed" && checks.some((check) => check.result !== "passed")) {
      problems.push("status 为 passed 时所有步骤都必须为 passed");
    }
    if (submission.status === "failed" && checks.length && checks.every((check) => check.result === "passed")) {
      problems.push("status 为 failed 时至少要有一个步骤为 failed 或 not_run");
    }
  }

  const evidence = (submission.evidence || []).map(clean).filter(Boolean);
  if (evidence.length > EVIDENCE_MAX_ITEMS) problems.push(`evidence 最多 ${EVIDENCE_MAX_ITEMS} 条，只保留关键证据`);
  evidence.forEach((item, index) => {
    if (textLength(item) > EVIDENCE_ITEM_MAX_LENGTH) problems.push(`evidence 第 ${index + 1} 条超过 ${EVIDENCE_ITEM_MAX_LENGTH} 字，每条只写一项证据`);
  });
  if (textLength(clean(submission.notes)) > NOTES_MAX_LENGTH) problems.push(`notes 超过 ${NOTES_MAX_LENGTH} 字`);
  return problems;
}

function normalize(submission: FinishSubmission, rules: FinishRules, lenient: boolean): FinishResult {
  const rawHeadline = clean(submission.headline).replace(/\s+/g, " ");
  const headline = truncate(rawHeadline || (submission.status === "passed" ? "通过" : "未通过，未提交结论"), HEADLINE_MAX_LENGTH);
  let log = clean(submission.log);
  if (lenient && headline !== rawHeadline) log = [rawHeadline, log].filter(Boolean).join("\n\n");

  const checks: StepCheck[] = rules.stepCount === undefined ? [] : (submission.checks || [])
    .filter((check) => Number.isInteger(check.step) && check.step >= 1 && check.step <= rules.stepCount! && CHECK_RESULTS.has(check.result))
    .map((check) => ({ step: check.step, result: check.result, actual: clean(check.actual) }))
    .sort((a, b) => a.step - b.step);
  const evidenceList = (submission.evidence || []).map(clean).filter(Boolean);
  const notes = clean(submission.notes);
  const failureType = submission.status === "failed" && submission.failureType && FAILURE_TYPES.has(submission.failureType)
    ? submission.failureType
    : undefined;

  return {
    status: submission.status,
    summary: headline,
    ...(failureType ? { failureType } : {}),
    ...(checks.length ? { checks } : {}),
    ...(evidenceList.length ? { evidenceList } : {}),
    ...(notes ? { notes } : {}),
    ...(log ? { log } : {}),
  };
}

export class FinishFormatError extends Error {}

/**
 * Validates a finish_test submission. Rejections tell the model exactly what to fix; once
 * `previousRejections` reaches MAX_FORMAT_REJECTIONS the submission is accepted in normalized form.
 */
export function resolveFinishSubmission(submission: FinishSubmission, rules: FinishRules, previousRejections: number): FinishResult {
  const problems = collectProblems(submission, rules);
  if (problems.length && previousRejections < MAX_FORMAT_REJECTIONS) {
    throw new FinishFormatError(`结论格式不符合要求，未提交。请修正后重新调用 finish_test：\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
  return normalize(submission, rules, problems.length > 0);
}
