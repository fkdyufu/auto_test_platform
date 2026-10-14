import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Response } from "express";
import { catalogRouter } from "./catalog-routes.js";
import { createTestRunReportRouter } from "./test-run-report-routes.js";
import {
  CatalogError,
  catalogStore,
  type CaseRun,
  type ScenarioRun,
  type TestScenario,
  type TestOrder,
  type TestOrderExecutionContext,
  type TestRun,
} from "./catalog-store.js";
import { sanitizeToolEvent } from "./event-sanitizer.js";
import { buildDiagnosticPrompt } from "./diagnostic-context.js";
import { diagnosticStore } from "./diagnostic-store.js";
import { assistantStore } from "./assistant-store.js";
import { createAssistantRouter } from "./assistant-routes.js";
import { createAssistantTools } from "./assistant-tools.js";
import { buildAssistantPrompt } from "./assistant-context.js";
import { resolveScenarioDevices } from "./scenario-devices.js";
import {
  executePiDiagnostic,
  executePiAssistant,
  executePiRun,
  isModelRequestError,
  testModelConnection,
  type ModelRequestError,
  type RunnerEvent,
} from "./pi-runner.js";
import { resolveRunResult } from "./run-result.js";
import { decideScenarioCleanup } from "./scenario-cleanup-policy.js";
import { formatStepRows, stepRowsFromLegacy } from "../shared/test-case-steps.js";
import {
  readModelSettings,
  readZentaoSettings,
  resolveZentaoSettings,
  saveModelSettings,
  saveZentaoSettings,
  toPublicSettings,
  toPublicZentaoSettings,
  type ModelSettings,
} from "./settings-store.js";
import { getZentaoClient } from "./zentao-client.js";
import { zentaoRouter } from "./zentao-routes.js";
import { ensureBrowserRuntime, getBrowserRuntimeStatus } from "./browser-runtime.js";

type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface StreamEvent {
  id: number;
  timestamp: string;
  type:
    | RunnerEvent["type"]
    | "run_state"
    | "result"
    | "error"
    | "scenario_state"
    | "scenario_result"
    | "case_state"
    | "case_result";
  message?: string;
  tool?: string;
  toolCallId?: string;
  args?: unknown;
  details?: Record<string, unknown>;
  toolOutput?: string;
  error?: boolean;
  status?: RunStatus;
  outcome?: "passed" | "failed";
  testCaseId?: string;
  caseRunId?: string;
  caseName?: string;
  scenarioRunId?: string;
  scenarioName?: string;
}

interface RunRecord {
  id: string;
  requirement: string;
  status: RunStatus;
  createdAt: string;
  events: StreamEvent[];
  listeners: Set<Response>;
  abort?: () => Promise<void>;
  cancelRequested: boolean;
  logPath: string;
  logWrite: Promise<void>;
  source: "adhoc" | "test_order" | "diagnostic" | "assistant";
  testOrderId?: string;
}

interface RunLogHeader {
  type: "run_created";
  id: string;
  source?: RunRecord["source"];
  testOrderId?: string;
  requirement?: string;
  createdAt: string;
}

const app = express();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "0.0.0.0";
const runs = new Map<string, RunRecord>();
const runLogsDirectory = path.resolve(process.cwd(), ".data", "runs");
const INTERRUPTED_RUN_REASON = "平台服务重启，原执行进程已终止";

app.use(express.json({ limit: "1mb" }));

function writeSse(response: Response, event: StreamEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function publish(run: RunRecord, event: Omit<StreamEvent, "id" | "timestamp">): void {
  const safeEvent = sanitizeToolEvent(event);
  const streamEvent: StreamEvent = {
    ...safeEvent,
    id: run.events.length + 1,
    timestamp: new Date().toISOString(),
  };
  run.events.push(streamEvent);
  run.logWrite = run.logWrite
    .then(() => appendFile(run.logPath, `${JSON.stringify(streamEvent)}\n`))
    .catch((error) => console.error(`写入运行日志失败 (${run.id})`, error));
  run.listeners.forEach((listener) => writeSse(listener, streamEvent));
}

function updateStatus(run: RunRecord, status: RunStatus, message: string): void {
  run.status = status;
  publish(run, { type: "run_state", status, message });
}

async function hydrateRun(runId: string): Promise<RunRecord | undefined> {
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) return undefined;
  const logPath = path.join(runLogsDirectory, `${runId}.jsonl`);
  try {
    const lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
    const records = lines
      .map((line) => {
        try {
          return JSON.parse(line) as RunLogHeader | StreamEvent;
        } catch {
          return undefined;
        }
      })
      .filter((record): record is RunLogHeader | StreamEvent => Boolean(record));
    const header = records.find((record): record is RunLogHeader => record.type === "run_created");
    if (!header || header.id !== runId) return undefined;
    const events = records.filter((record): record is StreamEvent => record.type !== "run_created");
    const lastState = [...events].reverse().find((event) => event.type === "run_state");
    const run: RunRecord = {
      id: runId,
      requirement: header.requirement || "",
      status: lastState?.status || "queued",
      createdAt: header.createdAt,
      events,
      listeners: new Set(),
      cancelRequested: false,
      logPath,
      logWrite: Promise.resolve(),
      source: header.source || "adhoc",
      testOrderId: header.testOrderId,
    };
    runs.set(runId, run);
    return run;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function recoverInterruptedRuns(): Promise<void> {
  const catalogRunIds = new Set(await catalogStore.failInterruptedTestRuns(INTERRUPTED_RUN_REASON));
  const diagnosticCount = await diagnosticStore.failInterruptedConversations(INTERRUPTED_RUN_REASON);
  await assistantStore.failInterruptedConversations(INTERRUPTED_RUN_REASON);
  await mkdir(runLogsDirectory, { recursive: true });
  const fileNames = await readdir(runLogsDirectory);
  let recoveredCount = 0;

  for (const fileName of fileNames) {
    const match = /^([a-zA-Z0-9-]+)\.jsonl$/.exec(fileName);
    if (!match) continue;
    const run = await hydrateRun(match[1]);
    if (!run) continue;
    if (run.status === "queued" || run.status === "running") {
      publish(run, { type: "error", message: INTERRUPTED_RUN_REASON, error: true });
      updateStatus(run, "failed", "执行因平台服务重启而中断");
      await run.logWrite;
      recoveredCount += 1;
    } else if (!catalogRunIds.has(run.id)) {
      runs.delete(run.id);
    }
  }

  if (recoveredCount > 0) {
    console.warn(`已将 ${recoveredCount} 个遗留执行任务标记为失败`);
  }
  if (diagnosticCount > 0) {
    console.warn(`已将 ${diagnosticCount} 个遗留诊断对话恢复为空闲状态`);
  }
}

function publicRun(run: RunRecord) {
  return {
    id: run.id,
    requirement: run.requirement,
    status: run.status,
    createdAt: run.createdAt,
    events: run.events,
    source: run.source,
    testOrderId: run.testOrderId,
  };
}

async function createRunRecord(
  requirement: string,
  metadata: { id?: string; source?: RunRecord["source"]; testOrderId?: string } = {},
): Promise<RunRecord> {
  const runId = metadata.id || randomUUID();
  const run: RunRecord = {
    id: runId,
    requirement,
    status: "queued",
    createdAt: new Date().toISOString(),
    events: [],
    listeners: new Set(),
    cancelRequested: false,
    logPath: path.join(runLogsDirectory, `${runId}.jsonl`),
    logWrite: Promise.resolve(),
    source: metadata.source || "adhoc",
    testOrderId: metadata.testOrderId,
  };
  await mkdir(runLogsDirectory, { recursive: true });
  await writeFile(
    run.logPath,
    `${JSON.stringify({ type: "run_created", id: run.id, source: run.source, testOrderId: run.testOrderId, requirement, createdAt: run.createdAt })}\n`,
    { mode: 0o600 },
  );
  runs.set(run.id, run);
  publish(run, { type: "run_state", status: "queued", message: "任务已创建" });
  return run;
}

function buildDeviceDescription(context: TestOrderExecutionContext): string {
  const { devices } = context;
  const deviceLines = devices.map((device) => {
    const controls = device.controlInterfaces.length
      ? device.controlInterfaces
          .map((item) => {
            const credentials = item.username
              ? `，账号 ${item.username}${item.password ? `，密码 ${item.password}` : ""}`
              : item.password
                ? `，密码 ${item.password}`
                : "";
            return `${item.name}[${item.type}，接口 ID: ${item.id}] ${item.address}${credentials}`;
          })
          .join("；")
      : "未配置控制接口";
    return `- ${device.name}（ID: ${device.id}，类型: ${device.types.join("、")}${device.model ? `，型号: ${device.model}` : ""}）\n  控制接口: ${controls}`;
  });
  return `\n\n场景绑定设备：\n${deviceLines.join("\n") || "未绑定设备，不提供设备控制工具"}\n\n请根据当前阶段要求使用可用的设备控制接口；未提供相应工具时，不得声称已经完成操作。`;
}

function buildScenarioDescription(
  scenario: TestScenario,
  scenarioRun: ScenarioRun,
  context: TestOrderExecutionContext,
): string {
  const deviceById = new Map(context.devices.map((device) => [device.id, device]));
  const roleLines = scenario.roles.map((role) => {
    const deviceId = scenarioRun.roleBindings[role.key];
    const device = deviceId ? deviceById.get(deviceId) : undefined;
    return `- ${role.key}：${device ? `${device.name}（ID: ${device.id}）` : "尚未绑定"}`;
  });
  const parameterLines = scenario.parameters.map(
    (parameter) => `- ${parameter.name}（${parameter.key}）：${scenarioRun.parameterValues[parameter.key] || "未设置"}`,
  );
  return `测试场景：${scenario.name}${scenario.category ? `（${scenario.category}）` : ""}\n${scenario.description || "无补充说明"}\n\n固定角色绑定：\n${roleLines.join("\n") || "无设备角色"}\n角色已经由平台固定绑定，不得替换设备或重新分配角色。\n\n场景参数：\n${parameterLines.join("\n") || "无场景参数"}`;
}

function buildScenarioSetupRequirement(
  scenario: TestScenario,
  scenarioRun: ScenarioRun,
  context: TestOrderExecutionContext,
): string {
  return `为后续测试用例搭建并验证测试场景。${buildDeviceDescription(context)}\n\n${buildScenarioDescription(scenario, scenarioRun, context)}\n\n场景搭建要求：\n${scenario.setupInstructions}\n\n场景验证要求：\n${scenario.verificationInstructions}\n\n请严格按指定设备、接口和步骤执行。先读取相关配置，按搭建要求清除冲突并应用目标配置，然后逐项验证。不允许自行替换设备、选择其他拓扑或省略验证。无法达到要求时提交失败。当前未提供的控制接口不得假装已调用。完成后调用 finish_test 提交结论：headline 一句话说明搭建是否完成，搭建后各设备接口、地址和链路的实际状态写在 log，供后续用例参考；角色绑定由平台提供，不需要提交。`;
}

function caseStepRows(caseRun: CaseRun) {
  return caseRun.stepRowsSnapshot || stepRowsFromLegacy(caseRun.stepsSnapshot, caseRun.expectedResultSnapshot);
}

function buildCaseRequirement(
  caseRun: CaseRun,
  scenario: TestScenario,
  scenarioRun: ScenarioRun,
  context: TestOrderExecutionContext,
): string {
  const rows = caseStepRows(caseRun);
  return [
    `执行产品测试用例。${buildDeviceDescription(context)}`,
    buildScenarioDescription(scenario, scenarioRun, context),
    `场景搭建结论：${scenarioRun.summary || "无"}`,
    `用例名称：${caseRun.caseNameSnapshot}`,
    `前置条件：\n${caseRun.preconditionSnapshot || "无"}`,
    `用例步骤（每一步与其预期逐行对应）：\n${formatStepRows(rows)}`,
    "请先检查前置条件；未满足时按前置条件及执行规则做必要准备，并回读验证。准备成功后按顺序执行每一步并检查对应预期；无法准备时提交 failed，摘要说明‘前置准备失败’及原因。用例没有任何预期结果时应报告缺少判定依据，不能提交通过。最后根据实际观察调用 finish_test：headline 用一句话（不超过 60 字）给出结论，失败时直接说明哪里不符合；checks 按上面的步骤逐条填写是否满足对应预期及实际观察；failed 时用 failureType 区分产品缺陷、用例问题和环境限制；evidence 每条列一项关键证据；推测的原因写在 notes；完整过程可放在 log。没有实际证据的内容不要编造，也不要因整理结论继续操作设备。",
  ].join("\n\n");
}

function buildScenarioCleanupRequirement(
  scenario: TestScenario,
  scenarioRun: ScenarioRun,
  context: TestOrderExecutionContext,
  triggerReason: string,
): string {
  return `请清理测试场景。当前执行状态：${triggerReason}。无论此前执行是否成功，都应以恢复环境为目标。${buildDeviceDescription(context)}\n\n${buildScenarioDescription(scenario, scenarioRun, context)}\n\n场景清理要求：\n${scenario.cleanupInstructions}\n\n请使用当前真正可用的工具执行清理并验证。当前未提供的控制接口不得假装已调用。完成后调用 finish_test 提交结论。`;
}

async function updateStoredCaseRun(runId: string, caseRunId: string, update: Partial<CaseRun>): Promise<void> {
  await catalogStore.updateTestRun(runId, (storedRun) => {
    const storedCaseRun = storedRun.caseRuns.find((item) => item.id === caseRunId);
    if (!storedCaseRun) throw new CatalogError("用例执行记录不存在", 404);
    Object.assign(storedCaseRun, update);
  });
}

async function updateStoredScenarioRun(
  runId: string,
  scenarioRunId: string,
  update: Partial<ScenarioRun>,
): Promise<void> {
  await catalogStore.updateTestRun(runId, (storedRun) => {
    const storedScenarioRun = storedRun.scenarioRuns.find((item) => item.id === scenarioRunId);
    if (!storedScenarioRun) throw new CatalogError("场景执行记录不存在", 404);
    Object.assign(storedScenarioRun, update);
  });
}

async function executeScenarioCleanup(
  run: RunRecord,
  scenario: TestScenario,
  scenarioRun: ScenarioRun,
  context: TestOrderExecutionContext,
  settings: ModelSettings,
  triggerReason: string,
): Promise<{ outcome: "passed" | "failed"; summary: string }> {
  publish(run, {
    type: "scenario_state",
    status: "running",
    message: `清理场景：${scenario.name}`,
    scenarioRunId: scenarioRun.id,
    scenarioName: scenario.name,
  });
  try {
    const execution = await executePiRun({
      runId: `${scenarioRun.id}-cleanup`,
      phase: "cleanup",
      requirement: buildScenarioCleanupRequirement(scenario, scenarioRun, context, triggerReason),
      settings,
      devices: context.devices,
      onEvent: (event) => publish(run, {
        ...event,
        scenarioRunId: scenarioRun.id,
        scenarioName: scenario.name,
      }),
      onAbortReady: (abort) => {
        run.abort = abort;
      },
    });
    const result = resolveRunResult(execution);
    return { outcome: result.outcome, summary: result.fullText };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "场景清理失败";
    return {
      outcome: "failed",
      summary: `自动清理失败，环境可能残留配置：${reason}`,
    };
  } finally {
    run.abort = undefined;
  }
}

async function executeTestOrderRun(run: RunRecord, order: TestOrder, testRun: TestRun): Promise<void> {
  const settings = await readModelSettings();
  const productContext = await catalogStore.getTestOrderExecutionContext(order.id);
  updateStatus(run, "running", "正在执行测试单");
  const startedAt = new Date().toISOString();
  await catalogStore.updateTestRun(testRun.id, (storedRun) => {
    storedRun.status = "running";
    storedRun.startedAt = startedAt;
  });

  let passedCount = 0;
  let failedCount = 0;

  let scenarioFailure = false;

  for (const scenarioRun of testRun.scenarioRuns) {
    if (run.cancelRequested) break;
    const scenario = scenarioRun.scenarioSnapshot || productContext.scenarios.find((item) => item.id === scenarioRun.testScenarioId);
    let executionContext: TestOrderExecutionContext = { devices: [], scenarios: [] };
    const scenarioCaseRuns = scenarioRun.caseRunIds
      .map((caseRunId) => testRun.caseRuns.find((item) => item.id === caseRunId))
      .filter((item): item is CaseRun => Boolean(item));
    const scenarioStartedAt = new Date().toISOString();
    await updateStoredScenarioRun(testRun.id, scenarioRun.id, { status: "running", startedAt: scenarioStartedAt });
    publish(run, {
      type: "scenario_state",
      status: "running",
      message: `准备场景：${scenarioRun.scenarioNameSnapshot}`,
      scenarioRunId: scenarioRun.id,
      scenarioName: scenarioRun.scenarioNameSnapshot,
    });

    let setupFailure = "";
    let setupAttempted = false;
    let scenarioHasFailure = false;
    let modelRequestFailure: ModelRequestError | undefined;
    if (scenario) {
      try {
        executionContext = { devices: resolveScenarioDevices(scenario, scenarioRun, productContext.devices), scenarios: [scenario] };
      } catch (error) {
        setupFailure = error instanceof Error ? error.message : "场景设备绑定无效";
      }
    }
    if (!scenario) {
      setupFailure = "测试场景不存在或已删除";
    }
    if (!setupFailure && scenario && scenarioRun.isDefault) {
      scenarioRun.summary = "默认场景，无需切换逻辑拓扑";
      await updateStoredScenarioRun(testRun.id, scenarioRun.id, { summary: scenarioRun.summary });
      publish(run, {
        type: "scenario_state",
        status: "running",
        message: `${scenario.name}：沿用绑定设备当前配置`,
        scenarioRunId: scenarioRun.id,
        scenarioName: scenario.name,
      });
    } else if (!setupFailure && scenario) {
      setupAttempted = true;
      try {
        const execution = await executePiRun({
          runId: `${scenarioRun.id}-setup`,
          phase: "setup",
          requirement: buildScenarioSetupRequirement(scenario, scenarioRun, executionContext),
          settings,
          devices: executionContext.devices,
          onEvent: (event) => publish(run, {
            ...event,
            scenarioRunId: scenarioRun.id,
            scenarioName: scenario.name,
          }),
          onAbortReady: (abort) => {
            run.abort = abort;
            if (run.cancelRequested) void abort();
          },
        });
        if (!run.cancelRequested) {
          const result = resolveRunResult(execution);
          if (result.outcome === "failed") setupFailure = result.fullText;
          else {
            scenarioRun.summary = result.fullText;
            await updateStoredScenarioRun(testRun.id, scenarioRun.id, {
              summary: scenarioRun.summary,
            });
            publish(run, {
              type: "scenario_state",
              status: "running",
              message: `${scenario.name}：场景搭建及验证完成`,
              scenarioRunId: scenarioRun.id,
              scenarioName: scenario.name,
            });
          }
        }
      } catch (error) {
        if (!run.cancelRequested) {
          setupFailure = error instanceof Error ? error.message : "场景搭建失败";
          if (isModelRequestError(error)) modelRequestFailure = error;
        }
      }
    }

    if (setupFailure) {
      const finishedAt = new Date().toISOString();
      failedCount += scenarioCaseRuns.length;
      scenarioFailure = true;
      scenarioHasFailure = true;
      await catalogStore.updateTestRun(testRun.id, (storedRun) => {
        const storedScenarioRun = storedRun.scenarioRuns.find((item) => item.id === scenarioRun.id);
        if (storedScenarioRun) Object.assign(storedScenarioRun, {
          summary: setupFailure,
        });
        storedRun.caseRuns
          .filter((item) => scenarioRun.caseRunIds.includes(item.id))
          .forEach((item) => Object.assign(item, {
            status: "failed",
            outcome: "failed",
            summary: `场景搭建失败：${setupFailure}`,
            finishedAt,
          }));
      });
      for (const caseRun of scenarioCaseRuns) {
        publish(run, {
          type: "case_result",
          status: "failed",
          outcome: "failed",
          error: true,
          message: `${caseRun.caseNameSnapshot}：场景搭建失败，未执行用例；${setupFailure}`,
          testCaseId: caseRun.testCaseId,
          caseRunId: caseRun.id,
          caseName: caseRun.caseNameSnapshot,
          scenarioRunId: scenarioRun.id,
          scenarioName: scenarioRun.scenarioNameSnapshot,
        });
      }
    }

    if (!setupFailure && !run.cancelRequested) {
      for (const caseRun of scenarioCaseRuns) {
        if (run.cancelRequested) break;
        const caseStartedAt = new Date().toISOString();
        await updateStoredCaseRun(testRun.id, caseRun.id, { status: "running", startedAt: caseStartedAt });
        publish(run, {
          type: "case_state",
          status: "running",
          message: `开始执行：${caseRun.caseNameSnapshot}`,
          testCaseId: caseRun.testCaseId,
          caseRunId: caseRun.id,
          caseName: caseRun.caseNameSnapshot,
          scenarioRunId: scenarioRun.id,
          scenarioName: scenarioRun.scenarioNameSnapshot,
        });

        try {
          const execution = await executePiRun({
            runId: caseRun.id,
            phase: "case",
            requirement: buildCaseRequirement(caseRun, scenario!, scenarioRun, executionContext),
            stepCount: caseStepRows(caseRun).length,
            settings,
            devices: executionContext.devices,
            onEvent: (event) =>
              publish(run, {
                ...event,
                testCaseId: caseRun.testCaseId,
                caseRunId: caseRun.id,
                caseName: caseRun.caseNameSnapshot,
                scenarioRunId: scenarioRun.id,
                scenarioName: scenarioRun.scenarioNameSnapshot,
              }),
            onAbortReady: (abort) => {
              run.abort = abort;
              if (run.cancelRequested) void abort();
            },
          });

          if (run.cancelRequested) {
            await updateStoredCaseRun(testRun.id, caseRun.id, {
              status: "cancelled",
              summary: "任务已取消",
              finishedAt: new Date().toISOString(),
            });
            break;
          }

          const result = resolveRunResult(execution);
          if (result.outcome === "passed") passedCount += 1;
          else {
            failedCount += 1;
            scenarioHasFailure = true;
          }
          await updateStoredCaseRun(testRun.id, caseRun.id, {
            status: "completed",
            outcome: result.outcome,
            summary: result.message,
            resultDetails: result.details,
            finishedAt: new Date().toISOString(),
          });
          publish(run, {
            type: "case_result",
            status: "completed",
            outcome: result.outcome,
            error: result.outcome === "failed",
            message: `${caseRun.caseNameSnapshot}：${result.message}`,
            testCaseId: caseRun.testCaseId,
            caseRunId: caseRun.id,
            caseName: caseRun.caseNameSnapshot,
            scenarioRunId: scenarioRun.id,
            scenarioName: scenarioRun.scenarioNameSnapshot,
          });
        } catch (error) {
          if (run.cancelRequested) {
            await updateStoredCaseRun(testRun.id, caseRun.id, {
              status: "cancelled",
              summary: "任务已取消",
              finishedAt: new Date().toISOString(),
            });
            break;
          }

          failedCount += 1;
          scenarioHasFailure = true;
          const message = error instanceof Error ? error.message : "用例执行失败";
          await updateStoredCaseRun(testRun.id, caseRun.id, {
            status: "failed",
            outcome: "failed",
            summary: message,
            finishedAt: new Date().toISOString(),
          });
          publish(run, {
            type: "case_result",
            status: "failed",
            outcome: "failed",
            error: true,
            message: `${caseRun.caseNameSnapshot}：${message}`,
            testCaseId: caseRun.testCaseId,
            caseRunId: caseRun.id,
            caseName: caseRun.caseNameSnapshot,
            scenarioRunId: scenarioRun.id,
            scenarioName: scenarioRun.scenarioNameSnapshot,
          });
          if (isModelRequestError(error)) {
            modelRequestFailure = error;
            break;
          }
        }
      }
    }

    let cleanupOutcome: "passed" | "failed" | undefined;
    let cleanupSummary: string | undefined;
    if (scenario) {
      const cleanupDecision = decideScenarioCleanup({
        setupAttempted,
        isDefault: scenario.isDefault,
        hasCleanupInstructions: Boolean(scenario.cleanupInstructions.trim()),
        recoveryRequired: Boolean(setupFailure || scenarioHasFailure || run.cancelRequested),
        modelRequestFailed: Boolean(modelRequestFailure),
      });
      if (cleanupDecision.action === "run") {
        const triggerReason = run.cancelRequested
          ? "用户已取消测试"
          : setupFailure
            ? `场景搭建失败：${setupFailure}`
            : scenarioHasFailure
              ? "场景内存在失败用例"
              : "场景内用例已经执行完毕";
        const cleanup = await executeScenarioCleanup(
          run,
          scenario,
          scenarioRun,
          executionContext,
          settings,
          triggerReason,
        );
        cleanupOutcome = cleanup.outcome;
        cleanupSummary = cleanup.summary;
      } else if (cleanupDecision.action === "blocked") {
        cleanupOutcome = "failed";
        cleanupSummary = cleanupDecision.summary;
      }
      if (cleanupOutcome === "failed") {
        scenarioHasFailure = true;
        scenarioFailure = true;
      }
    }

    if (run.cancelRequested) {
      await updateStoredScenarioRun(testRun.id, scenarioRun.id, {
        status: "cancelled",
        cleanupOutcome,
        cleanupSummary,
        finishedAt: new Date().toISOString(),
      });
      publish(run, {
        type: "scenario_result",
        status: "cancelled",
        error: cleanupOutcome === "failed",
        message: cleanupOutcome === "failed"
          ? `${scenarioRun.scenarioNameSnapshot}：测试已取消，且${cleanupSummary}`
          : cleanupOutcome === "passed"
            ? `${scenarioRun.scenarioNameSnapshot}：测试已取消，场景清理已完成`
            : `${scenarioRun.scenarioNameSnapshot}：测试已取消，场景无需清理`,
        scenarioRunId: scenarioRun.id,
        scenarioName: scenarioRun.scenarioNameSnapshot,
      });
      break;
    }
    if (scenarioHasFailure) scenarioFailure = true;
    const scenarioOutcome = scenarioHasFailure ? "failed" : "passed";
    const scenarioStatus = setupFailure || modelRequestFailure ? "failed" : "completed";
    const scenarioExecutionSummary = setupFailure
      ? `场景搭建失败；${setupFailure}`
      : modelRequestFailure
        ? `执行中断；模型接口异常：${modelRequestFailure.message}`
        : "场景组执行完成";
    const scenarioResultMessage = cleanupOutcome === "failed"
      ? `${scenarioExecutionSummary}；${cleanupSummary}`
      : cleanupOutcome === "passed"
        ? `${scenarioExecutionSummary}；场景清理已完成`
        : scenarioExecutionSummary;
    await updateStoredScenarioRun(testRun.id, scenarioRun.id, {
      status: scenarioStatus,
      outcome: scenarioOutcome,
      summary: setupFailure || modelRequestFailure ? scenarioExecutionSummary : scenarioRun.summary,
      cleanupOutcome,
      cleanupSummary,
      finishedAt: new Date().toISOString(),
    });
    publish(run, {
      type: "scenario_result",
      status: scenarioStatus,
      outcome: scenarioOutcome,
      error: scenarioOutcome === "failed",
      message: `${scenarioRun.scenarioNameSnapshot}：${scenarioResultMessage}`,
      scenarioRunId: scenarioRun.id,
      scenarioName: scenarioRun.scenarioNameSnapshot,
    });
    if (modelRequestFailure) throw modelRequestFailure;
  }

  if (run.cancelRequested) {
    const finishedAt = new Date().toISOString();
    await catalogStore.updateTestRun(testRun.id, (storedRun) => {
      storedRun.status = "cancelled";
      storedRun.finishedAt = finishedAt;
      storedRun.caseRuns.forEach((item) => {
        if (item.status === "queued" || item.status === "running") Object.assign(item, {
          status: "cancelled",
          summary: item.summary || "任务已取消",
          finishedAt,
        });
      });
      storedRun.scenarioRuns.forEach((item) => {
        if (item.status === "queued" || item.status === "running") Object.assign(item, {
          status: "cancelled",
          summary: item.summary || "任务已取消",
          finishedAt,
        });
      });
    });
    updateStatus(run, "cancelled", "测试单执行已取消");
    return;
  }

  const outcome = failedCount > 0 || scenarioFailure ? "failed" : "passed";
  const message = `测试单执行完成：${passedCount} 个通过，${failedCount} 个失败`;
  await catalogStore.updateTestRun(testRun.id, (storedRun) => {
    storedRun.status = "completed";
    storedRun.outcome = outcome;
    storedRun.finishedAt = new Date().toISOString();
  });
  publish(run, { type: "result", outcome, message });
  updateStatus(run, "completed", "测试单执行完成");
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, pi: "0.84.4", browser: getBrowserRuntimeStatus() });
});

app.get("/api/settings", async (_request, response, next) => {
  try {
    response.json(toPublicSettings(await readModelSettings()));
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings", async (request, response, next) => {
  try {
    const settings = await saveModelSettings(request.body);
    response.json(toPublicSettings(settings));
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/test", async (_request, response, next) => {
  try {
    const settings = await readModelSettings();
    const publicSettings = toPublicSettings(settings);
    if (!publicSettings.configured) {
      response.status(409).json({ error: "请先保存完整的模型配置" });
      return;
    }
    const message = await testModelConnection(settings);
    response.json({ ok: true, message });
  } catch (error) {
    next(error);
  }
});

app.get("/api/settings/zentao", async (_request, response, next) => {
  try {
    response.json(toPublicZentaoSettings(await readZentaoSettings()));
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings/zentao", async (request, response, next) => {
  try {
    const settings = await saveZentaoSettings(request.body);
    response.json(toPublicZentaoSettings(settings));
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/zentao/test", async (request, response, next) => {
  try {
    const current = await readZentaoSettings();
    const settings = resolveZentaoSettings(request.body, current);
    await getZentaoClient(settings).testConnection();
    response.json({ ok: true, message: "禅道连接成功" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/products/:productId/test-orders/:id/runs", async (request, response, next) => {
  try {
    const settings = await readModelSettings();
    if (!toPublicSettings(settings).configured) {
      response.status(409).json({ error: "请先完成模型配置" });
      return;
    }

    const order = await catalogStore.getTestOrder(request.params.productId, request.params.id);
    const selectedCaseId = typeof request.body?.testCaseId === "string" ? request.body.testCaseId : undefined;
    if (selectedCaseId && !order.caseIds.includes(selectedCaseId)) {
      response.status(400).json({ error: "所选用例不属于该测试单" });
      return;
    }

    const label = selectedCaseId ? "单用例执行" : "整单执行";
    const run = await createRunRecord(`${order.name} - ${label}`, { source: "test_order", testOrderId: order.id });
    let testRun: TestRun;
    try {
      testRun = await catalogStore.createTestRun(run.id, order.id, selectedCaseId ? [selectedCaseId] : undefined);
    } catch (error) {
      publish(run, { type: "error", error: true, message: error instanceof Error ? error.message : "场景设备绑定无效" });
      updateStatus(run, "failed", "无法创建测试执行");
      throw error;
    }
    response.status(202).json(publicRun(run));

    void executeTestOrderRun(run, order, testRun).catch(async (error) => {
      const message = error instanceof Error ? error.message : "测试单执行失败";
      const finishedAt = new Date().toISOString();
      await catalogStore
        .updateTestRun(testRun.id, (storedRun) => {
          storedRun.status = "failed";
          storedRun.outcome = "failed";
          storedRun.finishedAt = finishedAt;
          storedRun.caseRuns.forEach((item) => {
            if (item.status === "queued" || item.status === "running") Object.assign(item, {
              status: "failed",
              outcome: "failed",
              summary: `执行中断：${message}`,
              finishedAt,
            });
          });
          storedRun.scenarioRuns.forEach((item) => {
            if (item.status === "queued" || item.status === "running") Object.assign(item, {
              status: "failed",
              outcome: "failed",
              summary: item.summary || `执行中断：${message}`,
              finishedAt,
            });
          });
        })
        .catch(() => undefined);
      publish(run, { type: "error", message, error: true });
      updateStatus(run, "failed", "测试单执行失败");
    });
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/products/:productId/test-runs/:runId/case-runs/:caseRunId/diagnostics",
  async (request, response, next) => {
    try {
      await catalogStore.getDiagnosticExecutionContext(
        request.params.productId,
        request.params.runId,
        request.params.caseRunId,
      );
      response.json(await diagnosticStore.list(
        request.params.productId,
        request.params.runId,
        request.params.caseRunId,
      ));
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/products/:productId/test-runs/:runId/case-runs/:caseRunId/diagnostics",
  async (request, response, next) => {
    try {
      const context = await catalogStore.getDiagnosticExecutionContext(
        request.params.productId,
        request.params.runId,
        request.params.caseRunId,
      );
      response.status(201).json(await diagnosticStore.getOrCreate(
        request.params.productId,
        request.params.runId,
        request.params.caseRunId,
        context.caseRun.caseNameSnapshot,
      ));
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/products/:productId/diagnostics/:id", async (request, response, next) => {
  try {
    const conversation = await diagnosticStore.get(request.params.productId, request.params.id);
    await catalogStore.getDiagnosticExecutionContext(
      request.params.productId,
      conversation.testRunId,
      conversation.caseRunId,
    );
    response.json(conversation);
  } catch (error) {
    next(error);
  }
});

app.post("/api/products/:productId/diagnostics/:id/messages", async (request, response, next) => {
  let startedConversation: Awaited<ReturnType<typeof diagnosticStore.startTurn>> | undefined;
  let diagnosticRunId = "";
  try {
    const question = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    if (!question) throw new CatalogError("请输入诊断问题");

    const settings = await readModelSettings();
    if (!toPublicSettings(settings).configured) {
      response.status(409).json({ error: "请先完成模型配置" });
      return;
    }

    const conversation = await diagnosticStore.get(request.params.productId, request.params.id);
    const context = await catalogStore.getDiagnosticExecutionContext(
      request.params.productId,
      conversation.testRunId,
      conversation.caseRunId,
    );
    const testExecution = runs.get(conversation.testRunId) || await hydrateRun(conversation.testRunId);
    diagnosticRunId = randomUUID();
    startedConversation = await diagnosticStore.startTurn(
      request.params.productId,
      conversation.id,
      question,
      diagnosticRunId,
    );

    let run: RunRecord;
    try {
      run = await createRunRecord(`诊断：${context.caseRun.caseNameSnapshot} - ${question}`, {
        id: diagnosticRunId,
        source: "diagnostic",
        testOrderId: context.testOrder.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建诊断任务失败";
      await diagnosticStore.finishTurn(request.params.productId, conversation.id, diagnosticRunId, message, true);
      throw error;
    }

    response.status(202).json({ conversation: startedConversation, run: publicRun(run) });

    void (async () => {
      try {
        if (run.cancelRequested) {
          await diagnosticStore.finishTurn(
            request.params.productId,
            conversation.id,
            run.id,
            "诊断已取消",
            true,
          );
          updateStatus(run, "cancelled", "诊断已取消");
          return;
        }

        updateStatus(run, "running", "正在分析用例执行结果");
        const prompt = buildDiagnosticPrompt(context, testExecution?.events || [], startedConversation!.messages);
        const execution = await executePiDiagnostic({
          runId: run.id,
          prompt,
          settings,
          devices: context.devices,
          onEvent: (event) => publish(run, event),
          onAbortReady: (abort) => {
            run.abort = abort;
            if (run.cancelRequested) void abort();
          },
        });

        if (run.cancelRequested) {
          await diagnosticStore.finishTurn(
            request.params.productId,
            conversation.id,
            run.id,
            "诊断已取消",
            true,
          );
          updateStatus(run, "cancelled", "诊断已取消");
          return;
        }

        await diagnosticStore.finishTurn(
          request.params.productId,
          conversation.id,
          run.id,
          execution.finalText,
        );
        updateStatus(run, "completed", "诊断完成");
      } catch (error) {
        const cancelled = run.cancelRequested;
        const message = cancelled ? "诊断已取消" : error instanceof Error ? error.message : "诊断失败";
        await diagnosticStore
          .finishTurn(request.params.productId, conversation.id, run.id, message, true)
          .catch(() => undefined);
        if (cancelled) {
          updateStatus(run, "cancelled", "诊断已取消");
        } else {
          publish(run, { type: "error", message, error: true });
          updateStatus(run, "failed", "诊断失败");
        }
      }
    })();
  } catch (error) {
    next(error);
  }
});

app.use("/api", createAssistantRouter({
  catalog: catalogStore,
  store: assistantStore,
  startTurn: async (productId, id, content, context) => {
    const settings = await readModelSettings();
    if (!toPublicSettings(settings).configured) throw new CatalogError("请先完成模型配置", 409);
    const runId = randomUUID();
    const conversation = await assistantStore.startTurn(productId, id, content, runId, context);
    let run: RunRecord;
    try {
      run = await createRunRecord(content, { id: runId, source: "assistant" });
    } catch (error) {
      await assistantStore.finishTurn(productId, id, runId, error instanceof Error ? error.message : "创建任务失败", true);
      throw error;
    }
    void (async () => {
      try {
        if (run.cancelRequested) throw new Error("助手已取消");
        updateStatus(run, "running", "助手正在处理");
        const prompt = buildAssistantPrompt(conversation, context);
        const devices = await catalogStore.getProductDeviceControlResources(productId);
        const execution = await executePiAssistant({
          runId, prompt, settings, devices,
          customTools: createAssistantTools({ catalog: catalogStore, store: assistantStore, productId, conversationId: id, runId, context, isCancelled: () => run.cancelRequested }),
          onEvent: (event) => publish(run, event),
          onAbortReady: (abort) => { run.abort = abort; if (run.cancelRequested) void abort(); },
        });
        await assistantStore.finishTurn(productId, id, runId, run.cancelRequested ? "助手已取消，未确认的变更不会自动保存" : execution.finalText, run.cancelRequested);
        updateStatus(run, run.cancelRequested ? "cancelled" : "completed", run.cancelRequested ? "助手已取消" : "助手回复完成");
      } catch (error) {
        const message = run.cancelRequested ? "助手已取消，未确认的变更不会自动保存" : error instanceof Error ? error.message : "助手处理失败";
        await assistantStore.finishTurn(productId, id, runId, message, true).catch(() => undefined);
        if (!run.cancelRequested) publish(run, { type: "error", message, error: true });
        updateStatus(run, run.cancelRequested ? "cancelled" : "failed", message);
      }
    })();
    return { conversation, run: publicRun(run) };
  },
}));

app.use("/api", zentaoRouter);
app.use("/api", catalogRouter);
app.use("/api", createTestRunReportRouter());

app.post("/api/runs", async (request, response, next) => {
  try {
    const requirement = typeof request.body?.requirement === "string" ? request.body.requirement.trim() : "";
    if (!requirement) {
      response.status(400).json({ error: "请输入测试需求" });
      return;
    }

    const settings = await readModelSettings();
    if (!toPublicSettings(settings).configured) {
      response.status(409).json({ error: "请先完成模型配置" });
      return;
    }

    const run = await createRunRecord(requirement);
    response.status(202).json(publicRun(run));

    void (async () => {
      try {
        if (run.cancelRequested) {
          updateStatus(run, "cancelled", "任务已取消");
          return;
        }

        updateStatus(run, "running", "正在连接模型");
        const execution = await executePiRun({
          runId: run.id,
          requirement,
          settings,
          onEvent: (event) => publish(run, event),
          onAbortReady: (abort) => {
            run.abort = abort;
            if (run.cancelRequested) void abort();
          },
        });

        if (run.cancelRequested) {
          updateStatus(run, "cancelled", "任务已取消");
          return;
        }

        const { outcome, message } = resolveRunResult(execution);
        publish(run, { type: "result", outcome, message });
        updateStatus(run, "completed", "执行完成");
      } catch (error) {
        if (run.cancelRequested) {
          updateStatus(run, "cancelled", "任务已取消");
          return;
        }
        const message = error instanceof Error ? error.message : "执行失败";
        publish(run, { type: "error", message, error: true });
        updateStatus(run, "failed", "执行失败");
      }
    })();
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:id", async (request, response, next) => {
  try {
    const run = runs.get(request.params.id) || await hydrateRun(request.params.id);
    if (!run) {
      response.status(404).json({ error: "任务不存在" });
      return;
    }
    response.json(publicRun(run));
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:id/events", async (request, response, next) => {
  try {
    const run = runs.get(request.params.id) || await hydrateRun(request.params.id);
    if (!run) {
      response.status(404).end();
      return;
    }

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    run.events.forEach((event) => writeSse(response, event));
    run.listeners.add(response);

    const heartbeat = setInterval(() => response.write(": ping\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      run.listeners.delete(response);
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/runs/:id/cancel", async (request, response) => {
  const run = runs.get(request.params.id);
  if (!run) {
    response.status(404).json({ error: "任务不存在" });
    return;
  }
  if (run.status !== "queued" && run.status !== "running") {
    response.status(409).json({ error: "任务已经结束" });
    return;
  }

  run.cancelRequested = true;
  await run.abort?.();
  response.status(202).json({ ok: true });
});

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientDirectory = path.resolve(currentDirectory, "../dist");
app.use(express.static(clientDirectory));
app.get("/{*path}", (request, response, next) => {
  if (request.path.startsWith("/api/")) {
    next();
    return;
  }
  response.sendFile(path.join(clientDirectory, "index.html"));
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "服务器错误";
  console.error(error);
  response.status(error instanceof CatalogError ? error.status : 400).json({ error: message });
});

async function startServer(): Promise<void> {
  try {
    await recoverInterruptedRuns();
  } catch (error) {
    console.error("恢复遗留执行任务失败", error);
  }
  void ensureBrowserRuntime()
    .then(({ executablePath }) => console.log(`浏览器运行时已就绪：${executablePath ?? getBrowserRuntimeStatus().managedDirectory}`))
    .catch((error) => console.error("浏览器运行时初始化失败；非网页功能仍可使用", error));
  app.listen(port, host, () => {
    console.log(`API server listening on http://${host}:${port}`);
  });
}

void startServer();
