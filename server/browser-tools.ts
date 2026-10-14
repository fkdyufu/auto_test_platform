import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { ensureBrowserRuntime } from "./browser-runtime.js";
import { readBrowserPageState } from "./browser-page-state.js";
import type { ToolEvidence } from "./tool-evidence.js";
import {
  CHECK_ACTUAL_MAX_LENGTH,
  EVIDENCE_ITEM_MAX_LENGTH,
  EVIDENCE_MAX_ITEMS,
  HEADLINE_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  resolveFinishSubmission,
  type FinishResult,
} from "./finish-result.js";

interface BrowserToolsOptions {
  runId: string;
  artifactsDirectory: string;
  onFinish: (result: FinishResult) => void;
  evidence: ToolEvidence;
  includeFinishTool?: boolean;
  // Step rows of the test case being executed; enables per-step checks.
  stepCount?: number;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export class BrowserDriver {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private operationQueue: Promise<void> = Promise.resolve();
  private nextRef = 1;
  private nextTarget = 1;
  private activeRefs = new Set<string>();
  constructor(
    private readonly artifactsDirectory: string,
    private readonly onEvidence: () => void = () => undefined,
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;

    const runtime = await ensureBrowserRuntime();
    this.browser = await runtime.chromium.launch({
      headless: true,
      ...(runtime.executablePath ? { executablePath: runtime.executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 960 },
      ignoreHTTPSErrors: true,
    });
    this.page = await this.context.newPage();
    return this.page;
  }

  async open(urlValue: string): Promise<string> {
    let url: URL;
    try {
      url = new URL(urlValue);
    } catch {
      throw new Error("请输入完整的 http 或 https 页面地址");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("browser_open 仅支持 http 或 https 页面，不支持 javascript: 等协议");
    }

    return this.serialize(async () => {
      const page = await this.ensurePage();
      this.activeRefs.clear();
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      return this.inspectPage(page);
    });
  }

  inspect(): Promise<string> {
    return this.serialize(async () => this.inspectPage(await this.ensurePage()));
  }

  private async inspectPage(page: Page): Promise<string> {
    this.activeRefs.clear();
    const firstRef = this.nextRef;
    this.nextRef += 120;
    const snapshot = await page.evaluate(readBrowserPageState, { firstRef });
    this.activeRefs = new Set(snapshot.elements.map((element) => element.ref));

    const observedUrl = new URL(snapshot.url);
    if (observedUrl.protocol === "http:" || observedUrl.protocol === "https:") {
      this.onEvidence();
    }

    return JSON.stringify(snapshot, null, 2);
  }

  private async locator(page: Page, target: string): Promise<Locator> {
    const refMatch = target.match(/^@e(\d+)$/);
    if (refMatch && !this.activeRefs.has(target)) throw this.staleRef(target);
    const locator = refMatch ? page.locator(`[data-pi-agent-ref="e${refMatch[1]}"]`) : page.locator(target);
    if (await locator.count() === 0) {
      if (refMatch) throw this.staleRef(target);
      // Allow controls that appear asynchronously, but do not wait for a known
      // hidden/closed target to become visible or choose a random first match.
      await locator.first().waitFor({ state: "attached", timeout: 2_000 });
    }
    const handles = await locator.elementHandles();
    try {
      const { targetStates = [] } = await page.evaluate(readBrowserPageState, { targets: handles });
      const available = targetStates.map((state, index) => ({ ...state, index })).filter((state) => state.available);
      if (available.length === 0) throw new Error(targetStates[0]?.reason || "没有找到当前可操作的目标，请检查最新页面状态");
      if (available.length > 1) {
        const labels = available.slice(0, 5).map((state) => `${state.tag}「${state.label || "未标注"}」`).join("、");
        throw new Error(`目标匹配到 ${available.length} 个可操作元素（${labels}），请使用最新 @eN 引用或更精确的选择器`);
      }
      // Anchor the validated element itself. A later DOM reorder must not make
      // nth(index) silently point at a different button during Playwright retries.
      const marker = `t${this.nextTarget++}`;
      await handles[available[0].index].evaluate((element, marker) => {
        (element as Element).setAttribute("data-pi-agent-target", marker);
      }, marker);
      return page.locator(`[data-pi-agent-target="${marker}"]`);
    } finally {
      await Promise.all(handles.map((handle) => handle.dispose()));
    }
  }

  private staleRef(target: string): Error {
    return new Error(`元素引用 ${target} 已失效。请调用 browser_inspect 读取最新页面，再使用新引用；不要原样重试。`);
  }

  private async operate(page: Page, operation: () => Promise<unknown>, settleMs: number): Promise<string> {
    let operated = false;
    try {
      await operation();
      operated = true;
      await page.waitForTimeout(settleMs);
      return await this.inspectPage(page);
    } catch (error) {
      const message = `${operated ? "浏览器操作已完成，但读取页面状态失败；请先检查结果，不要重复发送写操作。\n" : ""}${error instanceof Error ? error.message : String(error)}`;
      const snapshot = await this.inspectPage(page).catch(() => undefined);
      throw new Error(`${message}${snapshot ? `\n\n操作失败后的最新页面状态（旧引用已失效，请使用以下新引用；若出现 validationErrors，请先修正字段）：\n${snapshot}` : "\n无法读取最新页面，请重新打开或检查页面。"}`, { cause: error });
    }
  }

  click(target: string): Promise<string> {
    return this.serialize(async () => {
      const page = await this.ensurePage();
      return this.operate(page, async () => (await this.locator(page, target)).click({ timeout: target.startsWith("@e") ? 2_000 : 12_000 }), 400);
    });
  }

  fill(target: string, value: string): Promise<string> {
    return this.serialize(async () => {
      const page = await this.ensurePage();
      return this.operate(page, async () => (await this.locator(page, target)).fill(value, { timeout: target.startsWith("@e") ? 2_000 : 12_000 }), 200);
    });
  }

  select(target: string, value: string): Promise<string> {
    return this.serialize(async () => {
      const page = await this.ensurePage();
      return this.operate(page, async () => {
        const locator = await this.locator(page, target);
        if (await locator.evaluate((element) => element.tagName !== "SELECT")) {
          throw new Error("browser_select 仅支持原生 <select>。当前是自定义控件，请 browser_click 展开后，使用返回的新引用点击所需选项");
        }
        await locator.selectOption(value, { timeout: target.startsWith("@e") ? 2_000 : 12_000 });
      }, 200);
    });
  }

  drag(sourceTarget: string, destinationTarget: string): Promise<string> {
    return this.serialize(async () => {
      const page = await this.ensurePage();
      return this.operate(page, async () => {
        const source = await this.locator(page, sourceTarget);
        const destination = await this.locator(page, destinationTarget);
        await source.dragTo(destination, { timeout: sourceTarget.startsWith("@e") || destinationTarget.startsWith("@e") ? 2_000 : 12_000 });
      }, 500);
    });
  }

  press(key: string): Promise<string> {
    return this.serialize(async () => {
      const page = await this.ensurePage();
      return this.operate(page, () => page.keyboard.press(key), 300);
    });
  }

  async wait(milliseconds: number): Promise<string> {
    if (!Number.isInteger(milliseconds) || milliseconds < 100 || milliseconds > 10_000) {
      throw new Error("browser_wait 每次只能等待 100 到 10000 毫秒；更长时间请分多次等待并检查页面");
    }
    return this.serialize(async () => {
      const page = await this.ensurePage();
      await page.waitForTimeout(milliseconds);
      return this.inspectPage(page);
    });
  }

  screenshot(): Promise<string> {
    return this.serialize(async () => {
      const page = await this.ensurePage();
      await mkdir(this.artifactsDirectory, { recursive: true });
      const filename = `screenshot-${Date.now()}.png`;
      const screenshotPath = path.join(this.artifactsDirectory, filename);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      return screenshotPath;
    });
  }

  close(): Promise<void> {
    return this.serialize(async () => {
      await this.context?.close().catch(() => undefined);
      await this.browser?.close().catch(() => undefined);
      this.activeRefs.clear();
      this.page = undefined;
      this.context = undefined;
      this.browser = undefined;
    });
  }
}

export function createBrowserTools(options: BrowserToolsOptions) {
  const driver = new BrowserDriver(path.join(options.artifactsDirectory, options.runId), () => options.evidence.mark());
  const browserTools = [
    defineTool({
      name: "browser_open",
      label: "打开页面",
      description: "打开一个完整的 HTTP/HTTPS 页面，并返回页面文本和可交互元素；不支持 javascript: 等协议。",
      parameters: Type.Object({
        url: Type.String({ description: "完整页面地址" }),
      }),
      execute: async (_id, params) => textResult(await driver.open(params.url)),
    }),
    defineTool({
      name: "browser_inspect",
      label: "检查页面",
      description: "读取当前可见页面或活动弹窗的文本、字段标签、控件类型和 validationErrors。inViewport=false 表示可能需要滚动；已关闭弹窗不包含在结果中。每次操作返回的新快照会替换旧 @eN 引用。",
      parameters: Type.Object({}),
      execute: async () => textResult(await driver.inspect()),
    }),
    defineTool({
      name: "browser_click",
      label: "点击元素",
      description: "点击最新快照中的 @eN 引用或 CSS 选择器；有活动弹窗时仅操作弹窗内目标。选择器有多个可操作匹配时会报错。失败会附带最新页面状态，请据此更换目标，不要重复使用旧引用。",
      parameters: Type.Object({
        target: Type.String({ description: "元素引用，如 @e3；也可以是 CSS 选择器" }),
      }),
      execute: async (_id, params) => textResult(await driver.click(params.target)),
    }),
    defineTool({
      name: "browser_fill",
      label: "填写输入框",
      description: "清空并填写输入框。target 使用最新 @eN 引用或唯一 CSS 选择器。返回后检查 validationErrors；填写成功不代表字段值已通过页面校验。",
      parameters: Type.Object({
        target: Type.String(),
        value: Type.String(),
      }),
      execute: async (_id, params) => textResult(await driver.fill(params.target, params.value)),
    }),
    defineTool({
      name: "browser_select",
      label: "选择选项",
      description: "仅对原生 <select> 按 value 选择选项。controlType=custom-select 的自定义下拉框必须先用 browser_click 展开，再使用返回的新引用点击选项。",
      parameters: Type.Object({
        target: Type.String(),
        value: Type.String(),
      }),
      execute: async (_id, params) => textResult(await driver.select(params.target, params.value)),
    }),
    defineTool({
      name: "browser_drag",
      label: "拖拽元素",
      description: "将一个页面元素真实拖拽到另一个元素上。source 和 target 使用 browser_inspect 返回的 @eN 引用或 CSS 选择器；操作后应根据返回的页面状态验证结果。",
      parameters: Type.Object({
        source: Type.String({ minLength: 1, description: "被拖动元素或拖拽手柄，如 @e3" }),
        target: Type.String({ minLength: 1, description: "拖拽目的元素，如 @e5" }),
      }),
      execute: async (_id, params) => textResult(await driver.drag(params.source, params.target)),
    }),
    defineTool({
      name: "browser_press",
      label: "按键",
      description: "向当前页面发送按键，例如 Enter、Escape、Tab。",
      parameters: Type.Object({ key: Type.String() }),
      execute: async (_id, params) => textResult(await driver.press(params.key)),
    }),
    defineTool({
      name: "browser_wait",
      label: "等待页面",
      description: "每次等待 100 到 10000 毫秒，然后返回最新页面状态；更久需分次等待。",
      parameters: Type.Object({
        milliseconds: Type.Number({ minimum: 100, maximum: 10_000 }),
      }),
      execute: async (_id, params) => textResult(await driver.wait(params.milliseconds)),
    }),
    defineTool({
      name: "browser_screenshot",
      label: "页面截图",
      description: "保存当前页面完整截图并返回文件路径。",
      parameters: Type.Object({}),
      execute: async () => {
        const screenshotPath = await driver.screenshot();
        return textResult(`截图已保存：${screenshotPath}`, { screenshotPath });
      },
    }),
  ];
  let rejectedSubmissions = 0;
  const caseExecution = options.stepCount !== undefined;
  const finishTool = defineTool({
      name: "finish_test",
      label: "结束测试",
      description: caseExecution
        ? `完成需求后必须调用一次，提交通过或失败结论。headline 只写一句结论；checks 按用例步骤逐条填写，条数必须等于用例步骤数（${options.stepCount}）。格式不符时会被拒绝并说明原因，按提示修正后重新调用即可，不要为此重新操作设备。`
        : "完成需求后必须调用一次，提交通过或失败结论。headline 只写一句结论，过程放在 log。格式不符时会被拒绝并说明原因，按提示修正后重新调用。",
      parameters: Type.Object({
        status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
        headline: Type.String({ description: `一句话结论，不超过 ${HEADLINE_MAX_LENGTH} 字，不换行。失败时直接说明哪里不符合，例如“非法掩码无提示，并产生无掩码的半配置”；不要写前置条件、执行过程或证据` }),
        failureType: Type.Optional(Type.Union([Type.Literal("product_defect"), Type.Literal("case_issue"), Type.Literal("environment")], {
          description: "status 为 failed 时必填：product_defect 被测产品行为不符合预期；case_issue 用例步骤或预期本身有问题（如预期与产品默认设计冲突）；environment 测试环境或工具限制导致无法验证（含前置准备失败）",
        })),
        checks: Type.Optional(Type.Array(Type.Object({
          step: Type.Integer({ minimum: 1, description: "步骤序号，从 1 开始" }),
          result: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")], { description: "该步骤预期是否满足；因前置失败或中断而未执行填 not_run" }),
          actual: Type.String({ description: `与该步预期对照的实际观察，不超过 ${CHECK_ACTUAL_MAX_LENGTH} 字，只写事实` }),
        }), { description: caseExecution ? `必填，每个用例步骤一条，共 ${options.stepCount} 条` : "仅执行测试用例时使用" })),
        evidence: Type.Optional(Type.Array(Type.String(), { description: `关键证据，每条一项（命令输出要点、计数、截图或文件路径），最多 ${EVIDENCE_MAX_ITEMS} 条，每条不超过 ${EVIDENCE_ITEM_MAX_LENGTH} 字；只写实际获取的证据` })),
        notes: Type.Optional(Type.String({ description: `可选，不超过 ${NOTES_MAX_LENGTH} 字：推测的原因、环境限制或对用例本身的意见，须明确标注为推测` })),
        log: Type.Optional(Type.String({ description: "可选：完整的执行过程记录，报告中默认折叠" })),
      }),
      execute: async (_id, params) => {
        if (params.status === "passed" && !options.evidence.hasEvidence()) {
          throw new Error("尚未通过工具获取真实设备或页面结果，不能提交通过结论");
        }
        let result: FinishResult;
        try {
          result = resolveFinishSubmission(params, { stepCount: options.stepCount }, rejectedSubmissions);
        } catch (error) {
          rejectedSubmissions += 1;
          throw error;
        }
        options.onFinish(result);
        return textResult("测试结果已提交", { ...result });
      },
    });
  const tools = options.includeFinishTool === false ? browserTools : [...browserTools, finishTool];

  return {
    driver,
    tools,
    toolNames: tools.map((tool) => tool.name),
  };
}

export type { FinishResult };
