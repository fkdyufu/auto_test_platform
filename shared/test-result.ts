export type FailureType = "product_defect" | "case_issue" | "environment";
export type StepCheckResult = "passed" | "failed" | "not_run";

export const FAILURE_TYPE_LABELS: Record<FailureType, string> = {
  product_defect: "产品缺陷",
  case_issue: "用例问题",
  environment: "环境限制",
};

export const STEP_CHECK_LABELS: Record<StepCheckResult, string> = {
  passed: "通过",
  failed: "不通过",
  not_run: "未执行",
};

export interface StepCheck {
  step: number;
  result: StepCheckResult;
  actual: string;
}

export interface TestResultDetails {
  // Structured conclusion submitted by finish_test.
  failureType?: FailureType;
  checks?: StepCheck[];
  evidenceList?: string[];
  notes?: string;
  log?: string;
  // Free-text fields kept for records created before the structured format.
  expected?: string;
  actual?: string;
  evidence?: string;
}
