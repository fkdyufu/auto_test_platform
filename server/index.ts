import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Response } from "express";
import { executePiRun, testModelConnection, type RunnerEvent } from "./pi-runner.js";
import { resolveRunResult } from "./run-result.js";
import { readModelSettings, saveModelSettings, toPublicSettings } from "./settings-store.js";

type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface StreamEvent {
  id: number;
  timestamp: string;
  type: RunnerEvent["type"] | "run_state" | "result" | "error";
  message?: string;
  tool?: string;
  toolCallId?: string;
  args?: unknown;
  error?: boolean;
  status?: RunStatus;
  outcome?: "passed" | "failed";
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
  const streamEvent: StreamEvent = {
    ...event,
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
  };
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
    };
    await mkdir(runLogsDirectory, { recursive: true });
    await writeFile(
      run.logPath,
      `${JSON.stringify({ type: "run_created", id: run.id, requirement, createdAt: run.createdAt })}\n`,
      { mode: 0o600 },
    );
    runs.set(run.id, run);
    publish(run, { type: "run_state", status: "queued", message: "任务已创建" });
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
  response.status(400).json({ error: message });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`API server listening on http://127.0.0.1:${port}`);
});
