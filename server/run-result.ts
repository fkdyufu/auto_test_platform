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
  // Headline plus evidence, notes and log; used where the conclusion is the only stored record (scenario setup and cleanup).
  fullText: string;
}

function fullText(message: string, details?: TestResultDetails): string {
  return [
    message,
    details?.evidenceList?.length ? `证据：\n${details.evidenceList.map((item) => `- ${item}`).join("\n")}` : "",
    details?.notes ? `备注：${details.notes}` : "",
    details?.log || "",
  ].filter(Boolean).join("\n\n");
}

export function resolveRunResult(execution: ExecutionResult): ResolvedRunResult {
  if (execution.result) {
    const { status, summary, ...details } = execution.result;
    return {
      outcome: status,
      message: summary,
      ...(Object.keys(details).length ? { details } : {}),
      fullText: fullText(summary, details),
    };
  }

  const message = execution.finalText
    ? `Agent 未调用 finish_test 提交结论：${execution.finalText}`
    : "Agent 未调用 finish_test 提交测试结论";
  return { outcome: "failed", message, fullText: message };
}
