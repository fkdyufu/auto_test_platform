import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const configuredDirectory = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
const managedDirectory = configuredDirectory && configuredDirectory !== "0"
  ? path.resolve(projectDirectory, configuredDirectory)
  : path.join(projectDirectory, ".runtime", "ms-playwright");
const skipDownload = process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1"
  || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD?.toLowerCase() === "true";

if (skipDownload) {
  console.log("已按 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 跳过 Chromium 安装。");
  process.exit(0);
}

await mkdir(managedDirectory, { recursive: true });
const require = createRequire(import.meta.url);
const cliPath = path.join(path.dirname(require.resolve("playwright-core")), "cli.js");

console.log(`检查项目 Chromium：${managedDirectory}`);
const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
  cwd: projectDirectory,
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: managedDirectory,
  },
  stdio: "inherit",
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`Chromium 下载进程被信号 ${signal} 终止`));
      return;
    }
    resolve(code);
  });
});

if (exitCode !== 0) {
  throw new Error(`Chromium 下载命令退出码为 ${exitCode ?? "未知"}`);
}

console.log("项目 Chromium 已就绪。");
