import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { CaseRecovery } from "../shared/test-result.js";
import { RESTORE_RULE } from "./execution-policy.js";

export const RECOVERY_SUMMARY_MAX_LENGTH = 300;

export const CASE_RECOVERY_REQUIREMENT = `测试结论已经提交，不能再修改。现在恢复本用例执行期间做出的改动，让后续用例从场景搭建后的状态开始。${RESTORE_RULE}
1. 撤销本用例修改过的设备和页面配置，包括为满足前置条件所做的准备，恢复为修改前的值；
2. 停止本用例启动并记录了 PID 的流量、抓包等进程；
3. 恢复后读回确认。
只恢复本用例自己做过的改动：不要修复与本用例无关的问题，不要重新执行测试步骤，也不要重新搭建整个场景。本用例没有修改配置、也没有启动进程时，直接提交 not_needed。
完成后调用 finish_recovery：restored 表示已恢复并读回确认，failed 表示有改动未能恢复；summary 用一句话说明恢复了什么，失败时写明残留了什么。`;

export const RECOVERY_FINISH_ONLY_REQUIREMENT = `恢复阶段已经结束，但尚未收到 finish_recovery。现在只提供 finish_recovery 工具，不能再操作设备或页面。
请仅根据本次已记录的工具结果提交：确认已恢复并读回的写 restored，没有任何改动的写 not_needed，未完成或无法确认的写 failed 并说明可能残留的改动。`;

/** The tool the agent reports its recovery with. It is only active during the recovery turn. */
export function createRecoveryTool(onRecovered: (recovery: CaseRecovery) => void) {
  return defineTool({
    name: "finish_recovery",
    label: "提交恢复结果",
    description: "恢复本用例的改动后调用一次，提交恢复结果。",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("restored"), Type.Literal("not_needed"), Type.Literal("failed")]),
      summary: Type.String({ description: `一句话，不超过 ${RECOVERY_SUMMARY_MAX_LENGTH} 字：恢复了什么；failed 时写明残留了什么` }),
    }),
    execute: async (_id, params) => {
      const summary = params.summary.trim();
      if (!summary && params.status !== "not_needed") throw new Error("summary 不能为空");
      const chars = [...summary];
      const recovery: CaseRecovery = {
        status: params.status,
        summary: chars.length > RECOVERY_SUMMARY_MAX_LENGTH ? `${chars.slice(0, RECOVERY_SUMMARY_MAX_LENGTH - 1).join("")}…` : summary || "本用例没有需要恢复的改动",
      };
      onRecovered(recovery);
      return { content: [{ type: "text" as const, text: "恢复结果已提交" }], details: { ...recovery } };
    },
  });
}
