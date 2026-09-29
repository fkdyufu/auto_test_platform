import type { FinishResult } from "./browser-tools.js";
import type { TestResultDetails } from "../shared/test-result.js";

interface ExecutionResult {
  result?: FinishResult;
  finalText: string;
}

export interface ResolvedRunResult {
  outcome: "passed" | "failed";
  message: string;
  details?: TestResultDetails;
}

export function resolveRunResult(execution: ExecutionResult): ResolvedRunResult {
  if (execution.result) {
    const { expected, actual, evidence } = execution.result;
    return {
      outcome: execution.result.status,
      message: execution.result.summary,
      ...(expected || actual || evidence ? { details: { expected, actual, evidence } } : {}),
    };
  }

  return {
    outcome: "failed",
    message: execution.finalText
      ? `Agent 未调用 finish_test 提交结论：${execution.finalText}`
      : "Agent 未调用 finish_test 提交测试结论",
  };
}
