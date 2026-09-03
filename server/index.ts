import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Response } from "express";
import { catalogRouter } from "./catalog-routes.js";
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
import { executePiRun, testModelConnection, type RunnerEvent } from "./pi-runner.js";
import { resolveRunResult } from "./run-result.js";
import {
  readModelSettings,
  readZentaoSettings,
  resolveZentaoSettings,
  saveModelSettings,
  saveZentaoSettings,
  toPublicSettings,
  toPublicZentaoSettings,
} from "./settings-store.js";
import { getZentaoClient } from "./zentao-client.js";
import { zentaoRouter } from "./zentao-routes.js";

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
  source: "adhoc" | "test_order";
  testOrderId?: string;
}

const app = express();
const port = Number(process.env.PORT || 3001);
const runs = new Map<string, RunRecord>();
const runLogsDirectory = path.resolve(process.cwd(), ".data", "runs");

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
  metadata: { source?: RunRecord["source"]; testOrderId?: string } = {},
): Promise<RunRecord> {
  const runId = randomUUID();
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
    `${JSON.stringify({ type: "run_created", id: run.id, source: run.source, testOrderId: run.testOrderId, createdAt: run.createdAt })}\n`,
    { mode: 0o600 },
  );
  runs.set(run.id, run);
  publish(run, { type: "run_state", status: "queued", message: "任务已创建" });
  return run;
}

function buildPhysicalEnvironmentDescription(context: TestOrderExecutionContext): string {
  const { physicalEnvironment, devices } = context;
  if (!physicalEnvironment) return "";
  const deviceById = new Map(devices.map((device) => [device.id, device]));
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
    return `- ${device.name}（ID: ${device.id}，类型: ${device.type}${device.model ? `，型号: ${device.model}` : ""}）\n  控制接口: ${controls}`;
  });
  const connectionLines = physicalEnvironment.connections.map((connection) => {
    const source = deviceById.get(connection.sourceDeviceId)?.name || connection.sourceDeviceId;
    const target = deviceById.get(connection.targetDeviceId)?.name || connection.targetDeviceId;
    return `- ${source}.${connection.sourcePort} <-> ${target}.${connection.targetPort}${connection.description ? `（${connection.description}）` : ""}`;
  });
  return `\n\n物理环境上下文：\n物理环境：${physicalEnvironment.name}\n${physicalEnvironment.description || "无补充说明"}\n\n环境设备：\n${deviceLines.join("\n")}\n\n物理连接：\n${connectionLines.join("\n") || "未配置连接关系"}\n\n请根据用例步骤使用可用的设备控制接口；未提供相应工具时，不得声称已经完成操作。`;
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
    return `- ${role.name}（${role.key}，要求类型: ${role.deviceType}）：${device ? `${device.name}（ID: ${device.id}）` : "尚未绑定"}`;
  });
  const parameterLines = scenario.parameters.map(
    (parameter) => `- ${parameter.name}（${parameter.key}）：${scenarioRun.parameterValues[parameter.key] || "未设置"}`,
  );
  return `测试场景：${scenario.name}${scenario.category ? `（${scenario.category}）` : ""}\n${scenario.description || "无补充说明"}\n\n场景角色：\n${roleLines.join("\n") || "无设备角色"}\n\n场景参数：\n${parameterLines.join("\n") || "无场景参数"}`;
}

function buildScenarioSetupRequirement(
  scenario: TestScenario,
  scenarioRun: ScenarioRun,
  context: TestOrderExecutionContext,
): string {
  const candidateLines = scenario.roles.map((role) => {
    const candidates = context.devices.filter(
      (device) => device.type.trim().toLowerCase() === role.deviceType.trim().toLowerCase(),
    );
    return `- ${role.name}（${role.key}，类型: ${role.deviceType}）：${candidates.map((device) => `${device.name}[${device.id}]`).join("、") || "无匹配设备"}`;
  });
  return `为后续测试用例搭建并验证测试场景。${buildPhysicalEnvironmentDescription(context)}\n\n${buildScenarioDescription(scenario, scenarioRun, context)}\n\n可选角色设备：\n${candidateLines.join("\n") || "无设备角色"}\n\n场景搭建要求：\n${scenario.setupInstructions}\n\n场景验证要求：\n${scenario.verificationInstructions}\n\n请使用当前真正可用的工具完成配置并验证。当前未提供的控制接口不得假装已调用。完成后调用 finish_test；通过时 roleBindings 必须填写每个角色标识对应的设备 ID。`;
}

function buildCaseRequirement(
  caseRun: CaseRun,
  scenario: TestScenario,
  scenarioRun: ScenarioRun,
  context: TestOrderExecutionContext,
): string {
  return `执行产品测试用例。${buildPhysicalEnvironmentDescription(context)}\n\n${buildScenarioDescription(scenario, scenarioRun, context)}\n\n场景搭建结论：${scenarioRun.summary || "无"}\n\n用例名称：${caseRun.caseNameSnapshot}\n\n测试步骤：\n${caseRun.stepsSnapshot}\n\n预期结果：\n${caseRun.expectedResultSnapshot}\n\n请直接使用当前提供的工具执行，并根据实际观察调用 finish_test 提交结论。`;
}

function buildScenarioCleanupRequirement(
  scenario: TestScenario,
  scenarioRun: ScenarioRun,
  context: TestOrderExecutionContext,
): string {
  return `测试用例组已经执行完毕，请清理测试场景。${buildPhysicalEnvironmentDescription(context)}\n\n${buildScenarioDescription(scenario, scenarioRun, context)}\n\n场景清理要求：\n${scenario.cleanupInstructions}\n\n请使用当前真正可用的工具执行清理并验证。当前未提供的控制接口不得假装已调用。完成后调用 finish_test 提交结论。`;
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

function scenarioBindingDefinition(scenario: TestScenario, context: TestOrderExecutionContext) {
  return {
    roles: scenario.roles.map((role) => ({
      key: role.key,
      allowedDeviceIds: context.devices
        .filter((device) => device.type.trim().toLowerCase() === role.deviceType.trim().toLowerCase())
        .map((device) => device.id),
    })),
  };
}

async function executeTestOrderRun(run: RunRecord, order: TestOrder, testRun: TestRun): Promise<void> {
  const settings = await readModelSettings();
  const executionContext = await catalogStore.getTestOrderExecutionContext(order.id);
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
    const scenario = executionContext.scenarios.find((item) => item.id === scenarioRun.testScenarioId);
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
    let scenarioHasFailure = false;
    if (!scenario) {
      setupFailure = "测试场景不存在或已删除";
    } else if (scenarioRun.isDefault) {
      scenarioRun.summary = "默认场景，无需切换逻辑拓扑";
      await updateStoredScenarioRun(testRun.id, scenarioRun.id, { summary: scenarioRun.summary });
      publish(run, {
        type: "scenario_state",
        status: "running",
        message: `${scenario.name}：沿用物理环境当前配置`,
        scenarioRunId: scenarioRun.id,
        scenarioName: scenario.name,
      });
    } else if (!executionContext.physicalEnvironment) {
      setupFailure = "测试单未选择物理环境，无法搭建非默认场景";
    } else {
      try {
        const execution = await executePiRun({
          runId: `${scenarioRun.id}-setup`,
          requirement: buildScenarioSetupRequirement(scenario, scenarioRun, executionContext),
          settings,
          devices: executionContext.devices,
          scenarioBinding: scenarioBindingDefinition(scenario, executionContext),
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
          if (result.outcome === "failed") setupFailure = result.message;
          else {
            scenarioRun.roleBindings = execution.result?.roleBindings || {};
            scenarioRun.summary = result.message;
            await updateStoredScenarioRun(testRun.id, scenarioRun.id, {
              roleBindings: scenarioRun.roleBindings,
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
        if (!run.cancelRequested) setupFailure = error instanceof Error ? error.message : "场景搭建失败";
      }
    }

    if (run.cancelRequested) break;
    if (setupFailure) {
      const finishedAt = new Date().toISOString();
      failedCount += scenarioCaseRuns.length;
      scenarioFailure = true;
      await catalogStore.updateTestRun(testRun.id, (storedRun) => {
        const storedScenarioRun = storedRun.scenarioRuns.find((item) => item.id === scenarioRun.id);
        if (storedScenarioRun) Object.assign(storedScenarioRun, {
          status: "failed",
          outcome: "failed",
          summary: setupFailure,
          finishedAt,
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
      publish(run, {
        type: "scenario_result",
        status: "failed",
        outcome: "failed",
        error: true,
        message: `${scenarioRun.scenarioNameSnapshot}：${setupFailure}`,
        scenarioRunId: scenarioRun.id,
        scenarioName: scenarioRun.scenarioNameSnapshot,
      });
      continue;
    }

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
          requirement: buildCaseRequirement(caseRun, scenario!, scenarioRun, executionContext),
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
      }
    }

    if (run.cancelRequested) break;

    let cleanupOutcome: "passed" | "failed" | undefined;
    let cleanupSummary: string | undefined;
    if (scenario && !scenario.isDefault && scenario.cleanupInstructions.trim()) {
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
          requirement: buildScenarioCleanupRequirement(scenario, scenarioRun, executionContext),
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
          cleanupOutcome = result.outcome;
          cleanupSummary = result.message;
        }
      } catch (error) {
        if (!run.cancelRequested) {
          cleanupOutcome = "failed";
          cleanupSummary = error instanceof Error ? error.message : "场景清理失败";
        }
      }
      if (cleanupOutcome === "failed") {
        scenarioHasFailure = true;
        scenarioFailure = true;
      }
    }

    if (run.cancelRequested) break;
    if (scenarioHasFailure) scenarioFailure = true;
    const scenarioOutcome = scenarioHasFailure ? "failed" : "passed";
    await updateStoredScenarioRun(testRun.id, scenarioRun.id, {
      status: "completed",
      outcome: scenarioOutcome,
      cleanupOutcome,
      cleanupSummary,
      finishedAt: new Date().toISOString(),
    });
    publish(run, {
      type: "scenario_result",
      status: "completed",
      outcome: scenarioOutcome,
      error: scenarioOutcome === "failed",
      message: cleanupOutcome === "failed"
        ? `${scenarioRun.scenarioNameSnapshot}：用例已执行，但场景清理失败；${cleanupSummary}`
        : `${scenarioRun.scenarioNameSnapshot}：场景组执行完成`,
      scenarioRunId: scenarioRun.id,
      scenarioName: scenarioRun.scenarioNameSnapshot,
    });
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
  response.json({ ok: true, pi: "0.84.4" });
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
    const testRun = await catalogStore.createTestRun(run.id, order.id, selectedCaseId ? [selectedCaseId] : undefined);
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

app.use("/api", zentaoRouter);
app.use("/api", catalogRouter);

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

app.get("/api/runs/:id", (request, response) => {
  const run = runs.get(request.params.id);
  if (!run) {
    response.status(404).json({ error: "任务不存在" });
    return;
  }
  response.json(publicRun(run));
});

app.get("/api/runs/:id/events", (request, response) => {
  const run = runs.get(request.params.id);
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

app.listen(port, "127.0.0.1", () => {
  console.log(`API server listening on http://127.0.0.1:${port}`);
});
