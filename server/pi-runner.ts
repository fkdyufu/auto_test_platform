import { mkdir, writeFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createBrowserTools, type FinishResult } from "./browser-tools.js";
import { createInactivityGuard, createTextDeltaBatcher } from "./agent-event-control.js";
import type { DeviceResource } from "./catalog-store.js";
import { createDeviceTools } from "./device-tools.js";
import { modelRuntimePaths, type ModelSettings } from "./settings-store.js";
import { createToolEvidence } from "./tool-evidence.js";

const RUNTIME_PROVIDER_ID = "test-runner";
const AGENT_INACTIVITY_TIMEOUT_MS = 5 * 60_000;
const ASSISTANT_DELTA_BATCH_MS = 250;

const TEST_SYSTEM_PROMPT = `你是一个自动化测试执行 Agent。你会收到一段测试需求，并通过当前提供的浏览器或设备控制工具直接完成它。

执行规则：
1. 根据设备 ID 和控制接口 ID 选择工具，不要自行编造地址或凭据。
2. 需求包含网页地址时调用 browser_open，并根据页面检查结果选择元素操作。
3. SSH、Telnet、串口或 API 操作必须调用对应的 device_* 工具，以工具返回内容作为事实依据。
4. 页面或设备状态发生变化后重新读取，不要猜测结果。
5. 只有实际观察到符合需求的结果后才能判定通过。
6. 完成后必须调用 finish_test；无法完成时调用 finish_test 并标记 failed。
7. 不要只描述操作步骤，直接执行需求。`;

const DIAGNOSTIC_SYSTEM_PROMPT = `你是自动化测试平台中的用例诊断 Agent。你会收到产品、当前资源与环境、测试场景、用例执行快照、历史工具证据和诊断对话。

诊断规则：
1. 回答用户最新的问题，并区分已证实事实、合理推测和仍需验证的事项。
2. 历史执行证据表示测试发生时的记录；当前资源配置和你新调用工具得到的结果表示当前状态，不要混为一谈。
3. 必要时直接调用浏览器或 device_* 工具补充检查，只使用平台提供的设备 ID 和控制接口 ID。
4. 默认优先采用只读命令和查询操作；用户明确要求修改或复现时可以执行写操作，但要说明实际做了什么。
5. 不得输出、猜测或索要设备密码。凭据由平台在工具内部处理。
6. 不要调用 finish_test，也不要改写原测试结果。最终以清晰、简洁的中文给出判断、依据和下一步建议。`;

export interface RunnerEvent {
  type: "status" | "assistant_delta" | "assistant" | "tool_start" | "tool_end";
  message?: string;
  tool?: string;
  toolCallId?: string;
  args?: unknown;
  error?: boolean;
}

export interface PiRunOptions {
  runId: string;
  requirement: string;
  settings: ModelSettings;
  onEvent: (event: RunnerEvent) => void;
  onAbortReady: (abort: () => Promise<void>) => void;
  scenarioBinding?: {
    roles: Array<{ key: string; allowedDeviceIds: string[] }>;
  };
  devices?: DeviceResource[];
}

export interface PiDiagnosticOptions extends Omit<PiRunOptions, "requirement" | "scenarioBinding"> {
  prompt: string;
}

export class ModelRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRequestError";
  }
}

export function isModelRequestError(error: unknown): error is ModelRequestError {
  return error instanceof ModelRequestError;
}

function getMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => {
      return Boolean(item && typeof item === "object" && (item as { type?: string }).type === "text");
    })
    .map((item) => item.text)
    .join("\n");
}

function summarizeToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return "执行完成";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "执行完成";
  const text = content
    .map((item) => (item && typeof item === "object" && "text" in item ? String(item.text) : ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
  return text.length > 220 ? `${text.slice(0, 220)}…` : text || "执行完成";
}

async function createRuntime(settings: ModelSettings): Promise<{ modelRuntime: ModelRuntime; model: NonNullable<ReturnType<ModelRuntime["getModel"]>> }> {
  await mkdir(modelRuntimePaths.dataDirectory, { recursive: true });
  await mkdir(modelRuntimePaths.agentDirectory, { recursive: true });
  await mkdir(modelRuntimePaths.workspaceDirectory, { recursive: true });

  const modelConfig = {
    providers: {
      [RUNTIME_PROVIDER_ID]: {
        baseUrl: settings.baseUrl,
        api: settings.apiType,
        headers: settings.userAgent ? { "User-Agent": settings.userAgent } : undefined,
        models: [
          {
            id: settings.model,
            name: settings.model,
            reasoning: settings.reasoningLevel !== "off",
            thinkingLevelMap: { xhigh: "xhigh", max: "max" },
          },
        ],
      },
    },
  };
  await writeFile(modelRuntimePaths.modelsPath, `${JSON.stringify(modelConfig, null, 2)}\n`);

  const modelRuntime = await ModelRuntime.create({
    authPath: modelRuntimePaths.authPath,
    modelsPath: modelRuntimePaths.modelsPath,
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey(RUNTIME_PROVIDER_ID, settings.apiKey || "local");

  const model = modelRuntime.getModel(RUNTIME_PROVIDER_ID, settings.model);
  if (!model) {
    throw new Error(`无法加载模型 ${settings.model}`);
  }
  return { modelRuntime, model };
}

function createResourceLoader(settingsManager: SettingsManager, systemPrompt = TEST_SYSTEM_PROMPT) {
  return new DefaultResourceLoader({
    cwd: modelRuntimePaths.workspaceDirectory,
    agentDir: modelRuntimePaths.agentDirectory,
    settingsManager,
    systemPromptOverride: () => systemPrompt,
  });
}

interface PiAgentOptions extends PiRunOptions {
  systemPrompt: string;
  includeFinishTool: boolean;
}

async function executePiAgent(options: PiAgentOptions): Promise<{ result?: FinishResult; finalText: string }> {
  const { modelRuntime, model } = await createRuntime(options.settings);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  const resourceLoader = createResourceLoader(settingsManager, options.systemPrompt);
  await resourceLoader.reload();

  let finishResult: FinishResult | undefined;
  let finalText = "";
  let modelError = "";
  const evidence = createToolEvidence();
  const browserToolset = createBrowserTools({
    runId: options.runId,
    artifactsDirectory: modelRuntimePaths.artifactsDirectory,
    evidence,
    includeFinishTool: options.includeFinishTool,
    onFinish: (result) => {
      finishResult = result;
    },
    scenarioBinding: options.scenarioBinding,
  });
  const deviceToolset = createDeviceTools({ devices: options.devices || [], evidence });
  const tools = [...browserToolset.tools, ...deviceToolset.tools];
  const toolNames = tools.map((tool) => tool.name);

  const { session } = await createAgentSession({
    cwd: modelRuntimePaths.workspaceDirectory,
    agentDir: modelRuntimePaths.agentDirectory,
    modelRuntime,
    model,
    thinkingLevel: options.settings.reasoningLevel,
    tools: toolNames,
    customTools: tools,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(modelRuntimePaths.workspaceDirectory),
  });
  const inactivityGuard = createInactivityGuard(AGENT_INACTIVITY_TIMEOUT_MS, () => session.abort());
  const deltaBatcher = createTextDeltaBatcher(
    (message) => options.onEvent({ type: "assistant_delta", message }),
    ASSISTANT_DELTA_BATCH_MS,
  );

  options.onAbortReady(async () => {
    await session.abort();
    await Promise.all([browserToolset.driver.close(), deviceToolset.driver.close()]);
  });

  session.subscribe((event) => {
    inactivityGuard.touch();
    if (event.type === "agent_start") {
      deltaBatcher.flush();
      options.onEvent({ type: "status", message: "Agent 已开始执行" });
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltaBatcher.push(event.assistantMessageEvent.delta);
    } else if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
      deltaBatcher.flush();
      const assistantMessage = event.message as { stopReason?: string; errorMessage?: string };
      if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
        modelError = assistantMessage.errorMessage || "模型请求失败";
      }
      const messageText = getMessageText(event.message);
      if (messageText) {
        finalText = messageText;
        options.onEvent({ type: "assistant", message: messageText });
      }
    } else if (event.type === "tool_execution_start") {
      deltaBatcher.flush();
      options.onEvent({
        type: "tool_start",
        tool: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
      });
    } else if (event.type === "tool_execution_end") {
      deltaBatcher.flush();
      options.onEvent({
        type: "tool_end",
        tool: event.toolName,
        toolCallId: event.toolCallId,
        error: event.isError === true,
        message: summarizeToolResult(event.result),
      });
    }
  });

  try {
    inactivityGuard.touch();
    await Promise.race([session.prompt(options.requirement), inactivityGuard.timeout]);
    if (modelError) throw new ModelRequestError(modelError);
    return { result: finishResult, finalText };
  } finally {
    inactivityGuard.dispose();
    deltaBatcher.flush();
    session.dispose();
    await Promise.all([browserToolset.driver.close(), deviceToolset.driver.close()]);
  }
}

export function executePiRun(options: PiRunOptions): Promise<{ result?: FinishResult; finalText: string }> {
  return executePiAgent({
    ...options,
    systemPrompt: TEST_SYSTEM_PROMPT,
    includeFinishTool: true,
  });
}

export function executePiDiagnostic(options: PiDiagnosticOptions): Promise<{ finalText: string }> {
  return executePiAgent({
    ...options,
    requirement: options.prompt,
    systemPrompt: DIAGNOSTIC_SYSTEM_PROMPT,
    includeFinishTool: false,
  });
}

export async function testModelConnection(settings: ModelSettings): Promise<string> {
  const { modelRuntime, model } = await createRuntime(settings);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const resourceLoader = createResourceLoader(settingsManager);
  await resourceLoader.reload();

  let finalText = "";
  let modelError = "";
  const { session } = await createAgentSession({
    cwd: modelRuntimePaths.workspaceDirectory,
    agentDir: modelRuntimePaths.agentDirectory,
    modelRuntime,
    model,
    thinkingLevel: settings.reasoningLevel,
    tools: [],
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(modelRuntimePaths.workspaceDirectory),
  });

  session.subscribe((event) => {
    if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
      const assistantMessage = event.message as { stopReason?: string; errorMessage?: string };
      if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
        modelError = assistantMessage.errorMessage || "模型请求失败";
      }
      finalText = getMessageText(event.message);
    }
  });

  try {
    await session.prompt("只回复 CONNECTION_OK");
    if (modelError) throw new ModelRequestError(modelError);
    if (!finalText.includes("CONNECTION_OK")) {
      throw new Error("模型未返回预期的连接测试响应");
    }
    return "模型连接成功";
  } finally {
    session.dispose();
  }
}
