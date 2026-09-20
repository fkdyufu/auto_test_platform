import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { spawn } from "node:child_process";

type Chromium = (typeof import("playwright-core"))["chromium"];

export type BrowserRuntimeStatus = {
  status: "checking" | "installing" | "ready" | "unavailable";
  source: "configured" | "managed";
  executablePath?: string;
  managedDirectory: string;
  warning?: string;
  error?: string;
};

export type BrowserRuntime = {
  chromium: Chromium;
  executablePath?: string;
};

type BrowserRuntimeDependencies = {
  environment?: NodeJS.ProcessEnv;
  projectDirectory?: string;
  accessExecutable?: (executablePath: string) => Promise<void>;
  loadChromium?: () => Promise<Chromium>;
  installChromium?: (managedDirectory: string) => Promise<void>;
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutAnsi = message.replace(/\u001b\[[0-9;]*m/g, "");
  return withoutAnsi.length > 4_000 ? `${withoutAnsi.slice(0, 4_000)}…` : withoutAnsi;
}

function isTruthyEnvironmentFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

async function defaultAccessExecutable(executablePath: string): Promise<void> {
  await access(executablePath, constants.X_OK);
}

function resolvePlaywrightCli(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("playwright-core")), "cli.js");
}

async function runChromiumInstaller(managedDirectory: string, projectDirectory: string): Promise<void> {
  await mkdir(managedDirectory, { recursive: true });
  const cliPath = resolvePlaywrightCli();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: managedDirectory,
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(signal
        ? `Chromium 下载进程被信号 ${signal} 终止`
        : `Chromium 下载命令退出码为 ${code ?? "未知"}`));
    });
  });
}

export class BrowserRuntimeManager {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly projectDirectory: string;
  private readonly accessExecutable: (executablePath: string) => Promise<void>;
  private readonly loadChromium: () => Promise<Chromium>;
  private readonly installChromium: (managedDirectory: string) => Promise<void>;
  private readonly managedDirectory: string;
  private runtime?: BrowserRuntime;
  private initialization?: Promise<BrowserRuntime>;
  private state: BrowserRuntimeStatus;

  constructor(dependencies: BrowserRuntimeDependencies = {}) {
    this.environment = dependencies.environment ?? process.env;
    this.projectDirectory = dependencies.projectDirectory ?? process.cwd();
    const configuredManagedDirectory = this.environment.PLAYWRIGHT_BROWSERS_PATH?.trim();
    this.managedDirectory = configuredManagedDirectory && configuredManagedDirectory !== "0"
      ? path.resolve(this.projectDirectory, configuredManagedDirectory)
      : path.resolve(this.projectDirectory, ".runtime", "ms-playwright");
    this.environment.PLAYWRIGHT_BROWSERS_PATH = this.managedDirectory;
    this.accessExecutable = dependencies.accessExecutable ?? defaultAccessExecutable;
    this.loadChromium = dependencies.loadChromium ?? (async () => (await import("playwright-core")).chromium);
    this.installChromium = dependencies.installChromium
      ?? ((managedDirectory) => runChromiumInstaller(managedDirectory, this.projectDirectory));
    this.state = {
      status: "checking",
      source: this.environment.CHROME_PATH?.trim() ? "configured" : "managed",
      managedDirectory: this.managedDirectory,
    };
  }

  status(): BrowserRuntimeStatus {
    return { ...this.state };
  }

  async ensureReady(): Promise<BrowserRuntime> {
    if (this.runtime) return this.runtime;
    if (this.initialization) return this.initialization;

    this.initialization = this.initialize()
      .catch((error: unknown) => {
        const message = [
          `浏览器运行时不可用：${errorMessage(error)}`,
          "平台已检查 CHROME_PATH 和项目 Chromium；请检查下载网络、目录权限以及浏览器所需的系统动态库。",
        ].join(" ");
        this.state = {
          ...this.state,
          status: "unavailable",
          error: message,
        };
        throw new Error(message, { cause: error });
      })
      .finally(() => {
        this.initialization = undefined;
      });
    return this.initialization;
  }

  private async initialize(): Promise<BrowserRuntime> {
    this.state = {
      status: "checking",
      source: this.environment.CHROME_PATH?.trim() ? "configured" : "managed",
      managedDirectory: this.managedDirectory,
    };

    const chromium = await this.loadChromium();
    const configuredPath = this.environment.CHROME_PATH?.trim();
    if (configuredPath) {
      try {
        await this.accessExecutable(configuredPath);
        return await this.validate(chromium, configuredPath, "configured");
      } catch (error) {
        this.state = {
          ...this.state,
          source: "managed",
          warning: `CHROME_PATH (${configuredPath}) 不可用，已改用项目 Chromium：${errorMessage(error)}`,
        };
      }
    }

    const expectedExecutablePath = chromium.executablePath();
    let installedDuringInitialization = false;
    try {
      await this.accessExecutable(expectedExecutablePath);
    } catch {
      if (isTruthyEnvironmentFlag(this.environment.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)) {
        throw new Error("项目 Chromium 不存在，且 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 已禁用自动下载");
      }
      this.state = {
        ...this.state,
        status: "installing",
        source: "managed",
        executablePath: expectedExecutablePath,
      };
      await this.installChromium(this.managedDirectory);
      installedDuringInitialization = true;
      await this.accessExecutable(expectedExecutablePath);
    }

    try {
      return await this.validate(chromium, undefined, "managed");
    } catch (firstLaunchError) {
      if (!installedDuringInitialization && !isTruthyEnvironmentFlag(this.environment.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)) {
        this.state = {
          ...this.state,
          status: "installing",
          source: "managed",
          error: undefined,
        };
        await this.installChromium(this.managedDirectory);
        try {
          return await this.validate(chromium, undefined, "managed");
        } catch (secondLaunchError) {
          throw new Error(`项目 Chromium 文件存在但无法启动：${errorMessage(secondLaunchError)}`, {
            cause: firstLaunchError,
          });
        }
      }
      throw firstLaunchError;
    }
  }

  private async validate(
    chromium: Chromium,
    executablePath: string | undefined,
    source: BrowserRuntimeStatus["source"],
  ): Promise<BrowserRuntime> {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    await browser.close();
    this.runtime = { chromium, executablePath };
    this.state = {
      status: "ready",
      source,
      ...(executablePath ? { executablePath } : {}),
      managedDirectory: this.managedDirectory,
      warning: this.state.warning,
    };
    return this.runtime;
  }
}

const browserRuntimeManager = new BrowserRuntimeManager();

export function getBrowserRuntimeStatus(): BrowserRuntimeStatus {
  return browserRuntimeManager.status();
}

export function ensureBrowserRuntime(): Promise<BrowserRuntime> {
  return browserRuntimeManager.ensureReady();
}
