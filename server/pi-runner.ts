import { mkdir, writeFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createBrowserTools, type FinishResult } from "./browser-tools.js";
import { modelRuntimePaths, type ModelSettings } from "./settings-store.js";

const RUNTIME_PROVIDER_ID = "test-runner";

const SYSTEM_PROMPT = `你是一个自动化测试执行 Agent。你会收到一段用户需求，并通过提供的浏览器工具直接完成它。

执行规则：
1. 需求包含网页地址时，先调用 browser_open。
2. 根据 browser_open 或 browser_inspect 返回的页面状态选择元素并操作。
3. 页面发生变化后重新检查，不要猜测页面内容。
4. 只有实际观察到符合需求的结果后才能判定通过。
5. 完成后必须调用 finish_test；无法完成时调用 finish_test 并标记 failed。
6. 不要编写测试脚本，不要只描述操作步骤，直接执行需求。`;

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

function createResourceLoader(settingsManager: SettingsManager) {
  return new DefaultResourceLoader({
    cwd: modelRuntimePaths.workspaceDirectory,
    agentDir: modelRuntimePaths.agentDirectory,
    settingsManager,
    systemPromptOverride: () => SYSTEM_PROMPT,
  });
}

export async function executePiRun(options: PiRunOptions): Promise<{ result?: FinishResult; finalText: string }> {
  const { modelRuntime, model } = await createRuntime(options.settings);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  const resourceLoader = createResourceLoader(settingsManager);
  await resourceLoader.reload();

  let finishResult: FinishResult | undefined;
  let finalText = "";
  let modelError = "";
  const { driver, tools, toolNames } = createBrowserTools({
    runId: options.runId,
    artifactsDirectory: modelRuntimePaths.artifactsDirectory,
    onFinish: (result) => {
      finishResult = result;
    },
    scenarioBinding: options.scenarioBinding,
  });

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

  options.onAbortReady(async () => {
    await session.abort();
    await driver.close();
  });

  session.subscribe((event) => {
    if (event.type === "agent_start") {
      options.onEvent({ type: "status", message: "Agent 已开始执行" });
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      options.onEvent({ type: "assistant_delta", message: event.assistantMessageEvent.delta });
    } else if (event.type === "message_end" && (event.message as { role?: string }).role === "assistant") {
      const assistantMessage = event.message as { stopReason?: string; errorMessage?: string };
      if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
        modelError = assistantMessage.errorMessage || "模型请求失败";
      }
      finalText = getMessageText(event.message) || finalText;
      if (finalText) options.onEvent({ type: "assistant", message: finalText });
    } else if (event.type === "tool_execution_start") {
      options.onEvent({
        type: "tool_start",
        tool: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
      });
    } else if (event.type === "tool_execution_end") {
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
    await session.prompt(options.requirement);
    if (modelError) throw new Error(modelError);
    return { result: finishResult, finalText };
  } finally {
    session.dispose();
    await driver.close();
  }
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
    if (modelError) throw new Error(modelError);
    if (!finalText.includes("CONNECTION_OK")) {
      throw new Error("模型未返回预期的连接测试响应");
    }
    return "模型连接成功";
  } finally {
    session.dispose();
  }
}
