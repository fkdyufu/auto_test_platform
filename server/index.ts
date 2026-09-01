import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Response } from "express";
import { catalogRouter } from "./catalog-routes.js";
import { CatalogError, catalogStore, type CaseRun, type TestOrder, type TestRun } from "./catalog-store.js";
import { sanitizeToolEvent } from "./event-sanitizer.js";
import { executePiRun, testModelConnection, type RunnerEvent } from "./pi-runner.js";
import { resolveRunResult } from "./run-result.js";
import { readModelSettings, saveModelSettings, toPublicSettings } from "./settings-store.js";

type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface StreamEvent {
  id: number;
  timestamp: string;
  type: RunnerEvent["type"] | "run_state" | "result" | "error" | "case_state" | "case_result";
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

function interpolateSteps(text: string, order: TestOrder): string {
  return text
    .replaceAll("{{baseUrl}}", order.targetUrl)
    .replaceAll("{{targetUrl}}", order.targetUrl)
    .replaceAll("{{username}}", order.username)
    .replaceAll("{{password}}", order.password);
}

function buildCaseRequirement(order: TestOrder, caseRun: CaseRun): string {
  const credentials = order.username
    ? `\n登录账号：${order.username}${order.password ? `\n登录密码：${order.password}` : ""}`
    : "";
  return `执行产品测试用例。\n\n产品目标：${order.targetUrl}${credentials}\n\n用例名称：${caseRun.caseNameSnapshot}\n\n测试步骤：\n${interpolateSteps(caseRun.stepsSnapshot, order)}\n\n预期结果：\n${interpolateSteps(caseRun.expectedResultSnapshot, order)}\n\n请直接使用浏览器工具执行，并根据实际观察调用 finish_test 提交结论。`;
}

async function updateStoredCaseRun(runId: string, caseRunId: string, update: Partial<CaseRun>): Promise<void> {
  await catalogStore.updateTestRun(runId, (storedRun) => {
    const storedCaseRun = storedRun.caseRuns.find((item) => item.id === caseRunId);
    if (!storedCaseRun) throw new CatalogError("用例执行记录不存在", 404);
    Object.assign(storedCaseRun, update);
  });
}

async function executeTestOrderRun(run: RunRecord, order: TestOrder, testRun: TestRun): Promise<void> {
  const settings = await readModelSettings();
  updateStatus(run, "running", "正在执行测试单");
  const startedAt = new Date().toISOString();
  await catalogStore.updateTestRun(testRun.id, (storedRun) => {
    storedRun.status = "running";
    storedRun.startedAt = startedAt;
  });

  let passedCount = 0;
  let failedCount = 0;

  for (const caseRun of testRun.caseRuns) {
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
    });

    try {
      const execution = await executePiRun({
        runId: caseRun.id,
        requirement: buildCaseRequirement(order, caseRun),
        settings,
        onEvent: (event) =>
          publish(run, {
            ...event,
            testCaseId: caseRun.testCaseId,
            caseRunId: caseRun.id,
            caseName: caseRun.caseNameSnapshot,
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
      else failedCount += 1;
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
      });
    }
  }

  if (run.cancelRequested) {
    await catalogStore.updateTestRun(testRun.id, (storedRun) => {
      storedRun.status = "cancelled";
      storedRun.finishedAt = new Date().toISOString();
      storedRun.caseRuns.forEach((item) => {
        if (item.status === "queued" || item.status === "running") item.status = "cancelled";
      });
    });
    updateStatus(run, "cancelled", "测试单执行已取消");
    return;
  }

  const outcome = failedCount > 0 ? "failed" : "passed";
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

app.post("/api/test-orders/:id/runs", async (request, response, next) => {
  try {
    const settings = await readModelSettings();
    if (!toPublicSettings(settings).configured) {
      response.status(409).json({ error: "请先完成模型配置" });
      return;
    }

    const order = await catalogStore.getTestOrder(request.params.id);
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
      await catalogStore
        .updateTestRun(testRun.id, (storedRun) => {
          storedRun.status = "failed";
          storedRun.outcome = "failed";
          storedRun.finishedAt = new Date().toISOString();
        })
        .catch(() => undefined);
      publish(run, { type: "error", message, error: true });
      updateStatus(run, "failed", "测试单执行失败");
    });
  } catch (error) {
    next(error);
  }
});

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
