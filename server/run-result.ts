import type { FinishResult } from "./browser-tools.js";

interface ExecutionResult {
  result?: FinishResult;
  finalText: string;
}

export interface ResolvedRunResult {
  outcome: "passed" | "failed";
  message: string;
}

export function resolveRunResult(execution: ExecutionResult): ResolvedRunResult {
  if (execution.result) {
    return {
      outcome: execution.result.status,
      message: execution.result.summary,
    };
  }

  return {
    outcome: "failed",
    message: execution.finalText
      ? `Agent 未调用 finish_test 提交结论：${execution.finalText}`
      : "Agent 未调用 finish_test 提交测试结论",
  };
}
