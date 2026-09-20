import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserType, ChromiumBrowser } from "playwright-core";
import { BrowserRuntimeManager } from "./browser-runtime.js";

type Chromium = BrowserType<ChromiumBrowser>;

function fakeChromium(executablePath: string, launches: string[]): Chromium {
  return {
    executablePath: () => executablePath,
    launch: async (options: { executablePath?: string }) => {
      launches.push(options.executablePath ?? "");
      return { close: async () => undefined };
    },
  } as unknown as Chromium;
}

test("uses an executable CHROME_PATH without installing managed Chromium", async () => {
  const launches: string[] = [];
  let installs = 0;
  const manager = new BrowserRuntimeManager({
    environment: { CHROME_PATH: "/opt/chrome" },
    projectDirectory: "/project",
    accessExecutable: async (executablePath) => {
      assert.equal(executablePath, "/opt/chrome");
    },
    loadChromium: async () => fakeChromium("/project/.runtime/ms-playwright/chrome", launches),
    installChromium: async () => {
      installs += 1;
    },
  });

  const runtime = await manager.ensureReady();
  assert.equal(runtime.executablePath, "/opt/chrome");
  assert.equal(installs, 0);
  assert.deepEqual(launches, ["/opt/chrome"]);
  assert.deepEqual(manager.status(), {
    status: "ready",
    source: "configured",
    executablePath: "/opt/chrome",
    managedDirectory: "/project/.runtime/ms-playwright",
    warning: undefined,
  });
});

test("falls back to managed Chromium and installs it only once for concurrent callers", async () => {
  const launches: string[] = [];
  const managedExecutable = "/project/.runtime/ms-playwright/chrome";
  let installed = false;
  let installs = 0;
  const manager = new BrowserRuntimeManager({
    environment: { CHROME_PATH: "/missing/chrome" },
    projectDirectory: "/project",
    accessExecutable: async (executablePath) => {
      if (executablePath === "/missing/chrome" || !installed) throw new Error("ENOENT");
    },
    loadChromium: async () => fakeChromium(managedExecutable, launches),
    installChromium: async (directory) => {
      assert.equal(directory, "/project/.runtime/ms-playwright");
      installs += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      installed = true;
    },
  });

  const [first, second] = await Promise.all([manager.ensureReady(), manager.ensureReady()]);
  assert.equal(first, second);
  assert.equal(installs, 1);
  assert.deepEqual(launches, [""]);
  assert.equal(manager.status().status, "ready");
  assert.equal(manager.status().source, "managed");
  assert.match(manager.status().warning ?? "", /CHROME_PATH.*不可用/);
});

test("repairs a partial managed installation and retries Playwright browser selection", async () => {
  const launches: string[] = [];
  const chrome = "/project/.runtime/ms-playwright/chromium-1234/chrome-linux64/chrome";
  let launchReady = false;
  let installs = 0;
  const manager = new BrowserRuntimeManager({
    environment: {},
    projectDirectory: "/project",
    accessExecutable: async () => undefined,
    loadChromium: async () => ({
      executablePath: () => chrome,
      launch: async (options: { executablePath?: string }) => {
        launches.push(options.executablePath ?? "");
        if (!launchReady) throw new Error("headless shell is missing");
        return { close: async () => undefined };
      },
    } as never),
    installChromium: async () => {
      installs += 1;
      launchReady = true;
    },
  });

  const runtime = await manager.ensureReady();
  assert.equal(runtime.executablePath, undefined);
  assert.equal(installs, 1);
  assert.deepEqual(launches, ["", ""]);
});

test("reports unavailable when automatic browser download is disabled", async () => {
  let installs = 0;
  const manager = new BrowserRuntimeManager({
    environment: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    projectDirectory: "/project",
    accessExecutable: async () => {
      throw new Error("ENOENT");
    },
    loadChromium: async () => fakeChromium("/project/.runtime/ms-playwright/chrome", []),
    installChromium: async () => {
      installs += 1;
    },
  });

  await assert.rejects(manager.ensureReady(), /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD/);
  assert.equal(installs, 0);
  assert.equal(manager.status().status, "unavailable");
  assert.match(manager.status().error ?? "", /浏览器运行时不可用/);
});
