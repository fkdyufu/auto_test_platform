import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

interface FinishResult {
  status: "passed" | "failed";
  summary: string;
}

interface BrowserToolsOptions {
  runId: string;
  artifactsDirectory: string;
  onFinish: (result: FinishResult) => void;
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
  private observedPage = false;

  constructor(private readonly artifactsDirectory: string) {}

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;

    this.browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
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
    const url = new URL(urlValue);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("仅支持 http 或 https 页面");
    }

    const page = await this.ensurePage();
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    return this.inspect();
  }

  async inspect(): Promise<string> {
    const page = await this.ensurePage();
    const snapshot = await page.evaluate(() => {
      document.querySelectorAll("[data-pi-agent-ref]").forEach((element) => {
        element.removeAttribute("data-pi-agent-ref");
      });

      const selector = [
        "a",
        "button",
        "input",
        "textarea",
        "select",
        "[role='button']",
        "[role='link']",
        "[role='textbox']",
        "[contenteditable='true']",
      ].join(",");

      const elements = Array.from(document.querySelectorAll<HTMLElement>(selector))
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        })
        .slice(0, 120)
        .map((element, index) => {
          const ref = `e${index + 1}`;
          element.setAttribute("data-pi-agent-ref", ref);
          const input = element as HTMLInputElement;
          return {
            ref: `@${ref}`,
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute("role") || undefined,
            text: (element.innerText || element.getAttribute("aria-label") || input.value || "").trim().slice(0, 180),
            placeholder: input.placeholder || undefined,
            type: input.type || undefined,
            name: input.name || undefined,
          };
        });

      return {
        title: document.title,
        url: window.location.href,
        text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 6000),
        elements,
      };
    });

    const observedUrl = new URL(snapshot.url);
    if (observedUrl.protocol === "http:" || observedUrl.protocol === "https:") {
      this.observedPage = true;
    }

    return JSON.stringify(snapshot, null, 2);
  }

  hasObservedPage(): boolean {
    return this.observedPage;
  }

  private async locator(target: string): Promise<Locator> {
    const page = await this.ensurePage();
    const refMatch = target.match(/^@e(\d+)$/);
    return refMatch
      ? page.locator(`[data-pi-agent-ref="e${refMatch[1]}"]`).first()
      : page.locator(target).first();
  }

  async click(target: string): Promise<string> {
    const page = await this.ensurePage();
    await (await this.locator(target)).click({ timeout: 12_000 });
    await page.waitForTimeout(400);
    return this.inspect();
  }

  async fill(target: string, value: string): Promise<string> {
    const page = await this.ensurePage();
    await (await this.locator(target)).fill(value, { timeout: 12_000 });
    await page.waitForTimeout(200);
    return this.inspect();
  }

  async select(target: string, value: string): Promise<string> {
    const page = await this.ensurePage();
    await (await this.locator(target)).selectOption(value, { timeout: 12_000 });
    await page.waitForTimeout(200);
    return this.inspect();
  }

  async press(key: string): Promise<string> {
    const page = await this.ensurePage();
    await page.keyboard.press(key);
    await page.waitForTimeout(300);
    return this.inspect();
  }

  async wait(milliseconds: number): Promise<string> {
    const page = await this.ensurePage();
    await page.waitForTimeout(milliseconds);
    return this.inspect();
  }

  async screenshot(): Promise<string> {
    const page = await this.ensurePage();
    await mkdir(this.artifactsDirectory, { recursive: true });
    const filename = `screenshot-${Date.now()}.png`;
    const screenshotPath = path.join(this.artifactsDirectory, filename);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.observedPage = false;
  }
}

export function createBrowserTools(options: BrowserToolsOptions) {
  const driver = new BrowserDriver(path.join(options.artifactsDirectory, options.runId));

  const tools = [
    defineTool({
      name: "browser_open",
      label: "打开页面",
      description: "打开一个 HTTP/HTTPS 页面，并返回页面文本和可交互元素。",
      parameters: Type.Object({
        url: Type.String({ description: "完整页面地址" }),
      }),
      execute: async (_id, params) => textResult(await driver.open(params.url)),
    }),
    defineTool({
      name: "browser_inspect",
      label: "检查页面",
      description: "读取当前页面文本和可交互元素。页面变化后应重新调用。",
      parameters: Type.Object({}),
      execute: async () => textResult(await driver.inspect()),
    }),
    defineTool({
      name: "browser_click",
      label: "点击元素",
      description: "点击 browser_inspect 返回的 @eN 引用，或一个 CSS 选择器。",
      parameters: Type.Object({
        target: Type.String({ description: "元素引用，如 @e3；也可以是 CSS 选择器" }),
      }),
      execute: async (_id, params) => textResult(await driver.click(params.target)),
    }),
    defineTool({
      name: "browser_fill",
      label: "填写输入框",
      description: "清空并填写输入框。target 使用 @eN 引用或 CSS 选择器。",
      parameters: Type.Object({
        target: Type.String(),
        value: Type.String(),
      }),
      execute: async (_id, params) => textResult(await driver.fill(params.target, params.value)),
    }),
    defineTool({
      name: "browser_select",
      label: "选择选项",
      description: "按 value 选择下拉框选项。",
      parameters: Type.Object({
        target: Type.String(),
        value: Type.String(),
      }),
      execute: async (_id, params) => textResult(await driver.select(params.target, params.value)),
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
      description: "等待页面异步加载，然后返回最新页面状态。",
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
    defineTool({
      name: "finish_test",
      label: "结束测试",
      description: "完成需求后必须调用一次，提交通过或失败结论。",
      parameters: Type.Object({
        status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
        summary: Type.String({ description: "基于实际观察的简短结论" }),
      }),
      execute: async (_id, params) => {
        if (params.status === "passed" && !driver.hasObservedPage()) {
          throw new Error("尚未成功打开并读取目标页面，不能提交通过结论");
        }
        options.onFinish(params);
        return textResult("测试结果已提交", params);
      },
    }),
  ];

  return {
    driver,
    tools,
    toolNames: tools.map((tool) => tool.name),
  };
}

export type { FinishResult };
