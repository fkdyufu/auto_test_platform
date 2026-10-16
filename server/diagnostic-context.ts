import type { DiagnosticExecutionContext } from "./catalog-store.js";
import type { DiagnosticMessage } from "./diagnostic-store.js";
import { formatStepRows, stepRowsFromLegacy } from "../shared/test-case-steps.js";
import { FAILURE_TYPE_LABELS, STEP_CHECK_LABELS } from "../shared/test-result.js";
import { formatPhysicalLab } from "./physical-lab-prompt.js";

const MAX_EVIDENCE_EVENTS = 40;
const MAX_EVENT_TEXT = 1_800;
const MAX_PROMPT_LENGTH = 48_000;
const MAX_HISTORY_LENGTH = 12_000;

export const DIAGNOSTIC_DEVICE_ACCESS_RULE = "只有用户本轮明确要求连接或访问真实设备、检查设备当前状态或在设备上复现问题时，才允许调用 browser_* 或 device_* 工具（包括只读查询）。仅要求分析日志、执行记录、执行结果或报告，或询问失败原因，不构成设备访问授权。历史对话中的设备操作要求不得自动视为本轮授权。";

export interface DiagnosticEvidenceEvent {
  timestamp: string;
  type: string;
  message?: string;
  tool?: string;
  args?: unknown;
  details?: Record<string, unknown>;
  toolOutput?: string;
  error?: boolean;
  outcome?: string;
  caseRunId?: string;
  scenarioRunId?: string;
}

function limitText(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum)}...（已截断）` : value;
}

function formatDevices(context: DiagnosticExecutionContext): string {
  const devices = context.devices.map((device) => {
    const controls = device.controlInterfaces.length
      ? device.controlInterfaces.map((control) =>
          `${control.name || "未命名接口"}[${control.type}, ID: ${control.id}, 地址: ${control.address || "未配置"}${control.username ? `, 账号: ${control.username}` : ""}]`,
        ).join("；")
      : "未配置控制接口";
    return `- ${device.name}（设备 ID: ${device.id}，类型: ${device.types.join("、")}${device.model ? `，型号: ${device.model}` : ""}）\n  ${controls}`;
  });
  return `场景绑定设备的当前资源配置：\n${devices.join("\n") || "无可用绑定设备"}`;
}

function formatScenario(context: DiagnosticExecutionContext): string {
  const { scenario, scenarioRun } = context;
  const deviceById = new Map(context.devices.map((device) => [device.id, device]));
  const roles = Object.entries(scenarioRun.roleBindings).map(([key, deviceId]) => {
    const device = deviceById.get(deviceId);
    return `- ${key}：${device ? `${device.name}[${device.id}]` : `${deviceId}（当前不可用）`}`;
  });
  if (!scenario) {
    return `场景：${scenarioRun.scenarioNameSnapshot}（场景定义已删除）\n当次角色绑定：\n${roles.join("\n") || "无"}\n场景执行结论：${scenarioRun.summary || "无"}`;
  }
  const parameters = scenario.parameters.map((parameter) =>
    `- ${parameter.name}（${parameter.key}）：${scenarioRun.parameterValues[parameter.key] || "未设置"}`,
  );
  const source = scenarioRun.scenarioSnapshot ? "当次执行场景快照" : "历史记录未保存场景快照，以下场景定义来自当前配置，不代表当次配置";
  return `场景：${scenario.name}${scenario.category ? `（${scenario.category}）` : ""}\n定义来源：${source}\n${scenario.description || "无补充说明"}\n当次角色绑定：\n${roles.join("\n") || "无"}\n场景参数：\n${parameters.join("\n") || "无"}\n搭建要求：${scenario.setupInstructions || "无"}\n验证要求：${scenario.verificationInstructions || "无"}\n场景执行结论：${scenarioRun.summary || "无"}`;
}

function relevantEvidence(context: DiagnosticExecutionContext, events: DiagnosticEvidenceEvent[]): DiagnosticEvidenceEvent[] {
  const allowedTypes = new Set(["tool_start", "tool_end", "case_result", "scenario_result", "error", "agent_info"]);
  return events.filter((event) => {
    if (!allowedTypes.has(event.type)) return false;
    if (event.caseRunId === context.caseRun.id) return true;
    return !event.caseRunId && event.scenarioRunId === context.scenarioRun.id;
  }).slice(-MAX_EVIDENCE_EVENTS);
}

function formatEvidence(context: DiagnosticExecutionContext, events: DiagnosticEvidenceEvent[]): string {
  const evidence = relevantEvidence(context, events).map((event) => {
    const record = {
      time: event.timestamp,
      type: event.type,
      tool: event.tool,
      args: event.args,
      message: event.message,
      details: event.details,
      toolOutput: event.toolOutput ? limitText(event.toolOutput, 1_200) : undefined,
      error: event.error,
      outcome: event.outcome,
    };
    return limitText(JSON.stringify(record), MAX_EVENT_TEXT);
  });
  const joined = evidence.join("\n");
  if (!joined) return "未找到与该用例或其场景直接关联的工具事件";
  if (joined.length <= 18_000) return joined;
  return `（较早的执行证据已省略）\n${joined.slice(-18_000)}`;
}

function formatHistory(messages: DiagnosticMessage[]): string {
  if (!messages.length) return "无";
  const entries: string[] = [];
  let length = 0;
  for (const message of [...messages].reverse()) {
    const entry = `${message.role === "user" ? "用户" : "诊断助手"}：${limitText(message.content, 4_000)}`;
    if (entries.length && length + entry.length + 2 > MAX_HISTORY_LENGTH) break;
    entries.unshift(entry);
    length += entry.length + 2;
  }
  return `${entries.length < messages.length ? "（较早的对话已省略）\n\n" : ""}${entries.join("\n\n")}`;
}

export function buildDiagnosticPrompt(
  context: DiagnosticExecutionContext,
  events: DiagnosticEvidenceEvent[],
  messages: DiagnosticMessage[],
): string {
  const history = formatHistory(messages);
  const details = context.caseRun.resultDetails;
  const resultDetails = [
    details?.failureType && `失败类型：${FAILURE_TYPE_LABELS[details.failureType]}`,
    details?.checks?.length && `逐步结果：\n${limitText(details.checks.map((check) => `步骤 ${check.step}【${STEP_CHECK_LABELS[check.result]}】${check.actual}`).join("\n"), 4_000)}`,
    details?.evidenceList?.length && `关键证据：\n${limitText(details.evidenceList.map((item) => `- ${item}`).join("\n"), 3_000)}`,
    details?.notes && `备注（推测或环境说明）：${limitText(details.notes, 1_000)}`,
    details?.log && `执行记录：${limitText(details.log, 4_000)}`,
    details?.expected && `预期：${limitText(details.expected, 2_000)}`,
    details?.actual && `实际观察：${limitText(details.actual, 2_000)}`,
    details?.evidence && `关键证据：${limitText(details.evidence, 3_000)}`,
  ].filter(Boolean).join("\n");
  const rows = context.caseRun.stepRowsSnapshot || stepRowsFromLegacy(context.caseRun.stepsSnapshot, context.caseRun.expectedResultSnapshot);
  const lab = formatPhysicalLab(context.physicalLab, context.devices);
  const labSource = context.physicalLabSource === "snapshot" ? "来源：当次执行时登记的接线快照" : "来源：平台当前登记的接线；历史记录未保存接线快照，不代表当次接线";
  const prefix = [
    `请先根据当次用例执行快照、历史执行证据和提交的结果明细，回答诊断对话中的最新问题。\n${DIAGNOSTIC_DEVICE_ACCESS_RULE}\n历史证据不足、被截断或未记录时，说明能确定的事实和缺失的信息，不得自行读取设备当前状态、重新执行测试或修改配置来推断历史失败原因。`,
    "【上下文边界】\n- ‘执行快照’和‘历史执行证据’来自当次测试，表示历史事实。\n- ‘当前资源与环境’来自平台此刻的配置，可能已在测试后发生变化；提供设备信息不代表授权访问，仅在用户本轮明确要求设备访问后供补充检查使用。设备当前状态不能作为历史测试发生时状态的证明。\n- 设备凭据由平台工具内部使用，不应询问、输出或猜测密码。",
    `【产品与测试单】\n产品：${context.product.name}（${context.product.id}）\n产品描述：${context.product.description || "无"}\n测试单：${context.testOrder.name}（${context.testOrder.id}）`,
    `【当前资源与环境】\n${limitText(formatDevices(context), 8_000)}`,
    `【测试场景】\n${limitText(formatScenario(context), 6_000)}`,
    lab && `【物理环境】\n${labSource}\n${limitText(lab, 6_000)}`,
    `【用例执行快照】\n用例：${context.caseRun.caseNameSnapshot}（用例执行 ID: ${context.caseRun.id}）\n前置条件：\n${limitText(context.caseRun.preconditionSnapshot || "无", 6_000)}\n用例步骤（步骤与预期对应）：\n${limitText(formatStepRows(rows), 12_000)}\n执行状态：${context.caseRun.status}\n执行结果：${context.caseRun.outcome || "无结论"}\n执行结论：${limitText(context.caseRun.summary || "未记录", 4_000)}`,
    `【历史执行证据】\n${formatEvidence(context, events)}`,
  ].filter(Boolean).join("\n\n");
  const suffix = `${resultDetails ? `\n\n【当次提交的结果明细】\n${resultDetails}` : ""}\n\n【诊断对话】\n${history}`;
  return `${limitText(prefix, Math.max(1_000, MAX_PROMPT_LENGTH - suffix.length))}${suffix}`;
}
