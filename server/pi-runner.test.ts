import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { executePiRun, AgentExecutionError, type RunnerEvent } from "./pi-runner.js";
import { modelRuntimePaths, type ModelSettings } from "./settings-store.js";
import { buildExecutionPolicy } from "./execution-policy.js";

async function fixture(t: test.TestContext, answer: (index: number, body: Record<string, unknown>) => { delta: unknown; finish?: string; usage?: unknown; httpError?: number }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-test-runner-recovery-"));
  const original = { ...modelRuntimePaths };
  for (const key of Object.keys(modelRuntimePaths) as (keyof typeof modelRuntimePaths)[]) modelRuntimePaths[key] = path.join(directory, key);
  t.after(async () => { Object.assign(modelRuntimePaths, original); await rm(directory, { recursive: true, force: true }); });
  const requests: Record<string, unknown>[] = [];
  const events: RunnerEvent[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    const next = answer(requests.length, body);
    if (next.httpError) {
      response.writeHead(next.httpError, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Temporary model server error" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: unknown, finish: string | null, usage?: unknown) => ({ id: String(requests.length), object: "chat.completion.chunk", created: 1, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }], usage });
    response.write(`data: ${JSON.stringify(chunk(next.delta, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, next.finish || "stop", next.usage))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const settings: ModelSettings = { providerPreset: "custom", apiType: "openai-completions", reasoningLevel: "max", model: "mock", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: "mock-private-key", userAgent: "" };
  const execute = (onAbortReady: (abort: () => Promise<void>) => void = () => {}) => executePiRun({ runId: "recovery", phase: "case", requirement: "通过 Web 配置镜像并验证", settings, onEvent: (event) => events.push(event), onAbortReady });
  return { requests, events, execute };
}

const finishCall = { role: "assistant", tool_calls: [{ index: 0, id: "finish", type: "function", function: { name: "finish_test", arguments: JSON.stringify({ status: "failed", summary: "观察主机没有捕获到业务帧，验证未通过，根因尚未确认" }) } }] };

test("unfinished runs get exactly one finish-only recovery without repeating device actions", async (t) => {
  const f = await fixture(t, (index) => ({ delta: index === 1 ? { role: "assistant", content: "准备继续分析" } : index === 2 ? finishCall : { role: "assistant", content: "已提交失败结论" }, finish: index === 2 ? "tool_calls" : "stop" }));
  const result = await f.execute();
  assert.equal(result.result?.status, "failed");
  assert.equal(f.requests[0].max_completion_tokens ?? f.requests[0].max_tokens, 32_000);
  const tools = f.requests[1].tools as { function: { name: string } }[];
  assert.deepEqual(tools.map((tool) => tool.function.name), ["finish_test"]);
  assert.ok(f.events.some((event) => event.message?.includes("仅结论补交")));
  assert.ok(f.events.some((event) => event.type === "agent_info" && event.details?.event === "message_end" && event.details.stopReason === "stop"));
  assert.ok(f.events.some((event) => event.type === "agent_info" && event.details?.event === "message_end"
    && (event.details.contextUsage as { contextWindow?: number } | undefined)?.contextWindow === 1_000_000));
  assert.ok(f.events.some((event) => event.type === "agent_info" && event.details?.event === "session_end" && event.details.conclusionSubmitted));
});

test("failure to submit after recovery is an execution error, not an invented product verdict", async (t) => {
  const f = await fixture(t, () => ({ delta: { role: "assistant", content: "继续计划排查" } }));
  await assert.rejects(f.execute(), (error: unknown) => error instanceof AgentExecutionError && error.message.includes("补交后仍未调用"));
  assert.equal(f.requests.length, 2);
  const end = f.events.find((event) => event.details?.event === "session_end");
  assert.equal(end?.details?.conclusionSubmitted, false);
  assert.match(String(end?.details?.errorMessage), /执行异常/);
});

test("cancellation before the initial prompt makes no model request", async (t) => {
  const f = await fixture(t, () => ({ delta: { role: "assistant", content: "不应执行" } }));
  const result = await f.execute((abort) => { void abort(); });
  assert.equal(result.result, undefined);
  assert.equal(f.requests.length, 0);
});

test("output truncation is logged and recovered only by a finish-only request", async (t) => {
  const f = await fixture(t, (index) => ({ delta: index === 1 ? { role: "assistant", content: "输出未完成" } : index === 2 ? finishCall : { role: "assistant", content: "完成" }, finish: index === 1 ? "length" : index === 2 ? "tool_calls" : "stop", usage: index === 1 ? { prompt_tokens: 100, completion_tokens: 16384, total_tokens: 16484 } : undefined }));
  const result = await f.execute();
  assert.equal(result.result?.status, "failed");
  assert.ok(f.events.some((event) => event.details?.stopReason === "length"));
  assert.deepEqual((f.requests[1].tools as { function: { name: string } }[]).map((tool) => tool.function.name), ["finish_test"]);
});

test("a failed context compaction is recorded explicitly and is not mistaken for a product assertion", async (t) => {
  // Compaction needs older messages to discard, not just a high reported token count.
  const f = await fixture(t, (index) => ({ delta: { role: "assistant", content: index === 1 ? "执行证据。".repeat(20_000) : "摘要被截断" }, finish: index === 1 ? "stop" : "length", usage: index === 1 ? { prompt_tokens: 120000, completion_tokens: 2, total_tokens: 120002 } : { prompt_tokens: 100, completion_tokens: 13107, total_tokens: 13207 } }));
  await assert.rejects(f.execute(), (error: unknown) => error instanceof AgentExecutionError && error.message.includes("上下文压缩失败"));
  assert.ok(f.events.some((event) => event.message?.includes("正在压缩上下文")));
  assert.ok(f.events.some((event) => event.details?.event === "compaction_end" && event.details.errorMessage));
  const summaryRequests = f.requests.filter((request) => !request.tools);
  assert.ok(summaryRequests.length > 0);
  assert.ok(summaryRequests.every((request) => request.reasoning_effort !== "max"));
});

test("a successful retry clears the initial model error", async (t) => {
  const f = await fixture(t, (index) => ({ httpError: index === 1 ? 500 : undefined, delta: index === 2 ? finishCall : { role: "assistant", content: "完成" }, finish: index === 2 ? "tool_calls" : "stop" }));
  const result = await f.execute();
  assert.equal(result.result?.status, "failed");
  assert.equal(f.requests.length, 3);
  assert.ok(f.events.some((event) => event.details?.event === "auto_retry_end" && event.details.success));
  assert.equal(f.events.find((event) => event.details?.event === "session_end")?.details?.errorMessage, undefined);
});

test("saved tool output and structured conclusions redact configured secrets", async (t) => {
  const privateFinishCall = { role: "assistant", tool_calls: [{ index: 0, id: "private-finish", type: "function", function: { name: "finish_test", arguments: JSON.stringify({ status: "failed", summary: "未完成 mock-private-key", expected: "预期 mock-private-key", actual: "实际 mock-private-key", evidence: "证据 mock-private-key" }) } }] };
  const f = await fixture(t, (index) => ({ delta: index === 1 ? privateFinishCall : { role: "assistant", content: "已提交 mock-private-key" }, finish: index === 1 ? "tool_calls" : "stop" }));
  const result = await f.execute();
  assert.doesNotMatch(result.finalText, /mock-private-key/);
  assert.doesNotMatch(result.result!.summary, /mock-private-key/);
  assert.doesNotMatch(JSON.stringify(result.result), /mock-private-key/);
  assert.match(result.result!.evidence || "", /\[REDACTED\]/);
  const output = f.events.find((event) => event.type === "tool_end")!;
  assert.ok(output.toolOutput);
  assert.doesNotMatch(output.toolOutput, /mock-private-key/);
  assert.doesNotMatch(JSON.stringify(f.events), /mock-private-key/);
});

test("the case policy prepares and verifies preconditions without repairing a failed assertion", () => {
  const policy = buildExecutionPolicy("case");
  assert.match(policy, /引用失效时调用 browser_inspect.*不要原样重试/);
  assert.match(policy, /browser_wait 每次最多等待 10000 毫秒/);
  assert.match(policy, /前置条件不满足.*最小必要调整/);
  assert.match(policy, /回读验证后再执行测试步骤/);
  assert.match(policy, /前置准备失败：/);
  assert.match(policy, /测试步骤或预期结果已出现异常后，不得以“前置准备”为由修复/);
  assert.match(policy, /不能用底层命令替代 Web/);
  assert.match(policy, /不得清空\/手工添加 tc/);
  assert.match(policy, /根因/);
  assert.match(policy, /本次产物使用唯一名称/);
  assert.equal(buildExecutionPolicy("setup").includes("当前阶段：测试用例"), false);
});
