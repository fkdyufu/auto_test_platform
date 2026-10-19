import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Page } from "playwright-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BrowserDriver } from "./browser-tools.js";
import type { DeviceResource } from "./catalog-store.js";
import { DeviceToolDriver, type DeviceProtocolAdapters } from "./device-tools.js";
import { withRedactedResults } from "./pi-runner.js";
import { createRedactor, SecretPlaceholders } from "./secret-placeholders.js";
import { createToolEvidence } from "./tool-evidence.js";

const timestamp = "2026-10-19T00:00:00.000Z";

function devices(webUrl = "http://192.0.2.2/cgi-bin/luci/"): DeviceResource[] {
  const device = (id: string, name: string, controlInterfaces: DeviceResource["controlInterfaces"]): DeviceResource => ({
    id, productId: "product-1", name, template: "product", description: "", controlInterfaces, createdAt: timestamp, updatedAt: timestamp,
  });
  return [
    device("tau1", "TAU1", [
      { id: "tau1-web", name: "Luci", kind: "web", settings: { url: webUrl, username: "root", password: "web-pass" } },
      { id: "tau1-console", name: "", kind: "serial", settings: { device: "/dev/ttyACM0", baudRate: "115200", frame: "8N1", username: "root", password: "console-pass" } },
    ]),
    device("host1", "host1", [
      { id: "host1-ssh", name: "", kind: "ssh", settings: { host: "192.0.2.11", port: "22", username: "root", password: "host-pass" } },
      { id: "host1-telnet", name: "", kind: "telnet", settings: { host: "192.0.2.11", port: "23", username: "root", password: "" } },
      { id: "host1-api", name: "", kind: "api", settings: { baseUrl: "http://192.0.2.11/api/", auth: "token", username: "", password: "", token: "api-token" } },
    ]),
  ];
}

test("replaces password and token placeholders and leaves other braces alone", () => {
  const secrets = new SecretPlaceholders(devices());
  assert.equal(secrets.resolve("{{password:tau1-console}}"), "console-pass");
  assert.equal(secrets.resolve("sshpass -p '{{ password : tau1-console }}' ssh root@192.0.2.2"), "sshpass -p 'console-pass' ssh root@192.0.2.2", "another device's secret can be typed into this session");
  assert.equal(secrets.resolve("Bearer {{token:host1-api}}"), "Bearer api-token");
  assert.equal(secrets.resolve("docker ps --format '{{.Names}}' {{password}} {{user:host1-ssh}}"), "docker ps --format '{{.Names}}' {{password}} {{user:host1-ssh}}");
  assert.equal(secrets.resolve("a $& b {{password:host1-ssh}}"), "a $& b host-pass", "replacement patterns in the text are kept literally");
  assert.throws(() => secrets.resolve("{{password:missing}}"), /\{\{password:missing\}\} 中的接口 ID 不在当前可用设备中/);
  assert.throws(() => secrets.resolve("{{password:host1-telnet}}"), /host1 的 Telnet 接口未保存密码/);
  assert.throws(() => secrets.resolve("{{token:host1-ssh}}"), /未保存 Token/);
  const duplicated = devices();
  duplicated[1].controlInterfaces.push({ ...duplicated[0].controlInterfaces[1] });
  assert.throws(() => new SecretPlaceholders(duplicated).resolve("{{password:tau1-console}}"), /对应多个设备的接口/);
});

test("fills a Web password only on that interface's own site", () => {
  const secrets = new SecretPlaceholders(devices());
  assert.equal(secrets.resolveForPage("{{password:tau1-web}}", "http://192.0.2.2/cgi-bin/luci/admin"), "web-pass");
  assert.equal(secrets.resolveForPage("{{password:tau1-web}}", "https://192.0.2.2/"), "web-pass", "a redirect to HTTPS keeps the same site");
  assert.equal(secrets.resolveForPage("192.0.2.2", "about:blank"), "192.0.2.2");
  assert.throws(() => secrets.resolveForPage("{{password:tau1-web}}", "http://198.51.100.7/login"), /只能填写在 192\.0\.2\.2 的页面中，当前页面是 198\.51\.100\.7/);
  assert.throws(() => secrets.resolveForPage("{{password:host1-ssh}}", "http://192.0.2.11/"), /只能填写 Web 接口的密码/);
});

test("device tools send real secrets to the device but the model only writes placeholders", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const adapters: DeviceProtocolAdapters = {
    ssh: async (request) => { sent.push({ ssh: request.command }); return { success: true }; },
    telnet: async (request) => { sent.push({ telnet: request.command }); return { success: true }; },
    serial: async (request) => { sent.push({ serial: request.input }); return { success: true }; },
    http: async (request) => { sent.push({ path: request.path, headers: request.headers, body: request.body }); return { success: true }; },
  };
  const evidence = createToolEvidence();
  const driver = new DeviceToolDriver(devices(), evidence, adapters);
  await driver.serial({ deviceId: "tau1", input: "{{password:tau1-console}}" });
  await driver.ssh({ deviceId: "host1", command: "echo '{{password:host1-ssh}}' | sudo -S true" });
  await driver.telnet({ deviceId: "host1", command: "show run" });
  await driver.http({ deviceId: "host1", method: "POST", path: "login?p={{password:host1-ssh}}", headers: [{ name: "X-Token", value: "{{token:host1-api}}" }], body: '{"password":"{{password:tau1-web}}"}' });
  assert.deepEqual(sent, [
    { serial: "console-pass" },
    { ssh: "echo 'host-pass' | sudo -S true" },
    { telnet: "show run" },
    { path: "login?p=host-pass", headers: [{ name: "X-Token", value: "api-token" }], body: '{"password":"web-pass"}' },
  ]);

  const unused = createToolEvidence();
  const failing = new DeviceToolDriver(devices(), unused, adapters);
  await assert.rejects(failing.ssh({ deviceId: "host1", command: "echo {{password:nope}}" }), /不在当前可用设备中/);
  assert.equal(sent.length, 4, "nothing is sent when a placeholder cannot be resolved");
  assert.equal(unused.hasEvidence(), false);
});

test("browser_fill types the stored Web password only on the interface's site", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<form><label>账号 <input id="user"></label><label>密码 <input id="pass" type="password"></label></form>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const { port } = server.address() as AddressInfo;

  const own = new SecretPlaceholders(devices(`http://127.0.0.1:${port}/`));
  const driver = new BrowserDriver("/tmp/auto-test-platform-browser-secret", undefined, (text, pageUrl) => own.resolveForPage(text, pageUrl));
  t.after(() => driver.close());
  await driver.open(`http://127.0.0.1:${port}/`);
  const snapshot = await driver.fill("#pass", "{{password:tau1-web}}");
  assert.doesNotMatch(snapshot, /web-pass/);
  const page = (driver as unknown as { page: Page }).page;
  assert.equal(await page.evaluate(() => (document.querySelector("#pass") as HTMLInputElement).value), "web-pass");

  const other = new SecretPlaceholders(devices("http://192.0.2.2/"));
  const elsewhere = new BrowserDriver("/tmp/auto-test-platform-browser-secret-other", undefined, (text, pageUrl) => other.resolveForPage(text, pageUrl));
  t.after(() => elsewhere.close());
  await elsewhere.open(`http://127.0.0.1:${port}/`);
  await assert.rejects(elsewhere.fill("#pass", "{{password:tau1-web}}"), /只能填写在 192\.0\.2\.2 的页面中/);
  const otherPage = (elsewhere as unknown as { page: Page }).page;
  assert.equal(await otherPage.evaluate(() => (document.querySelector("#pass") as HTMLInputElement).value), "");
});

test("masks stored secrets in tool results and errors before the model reads them", async () => {
  const redact = createRedactor(["console-pass", "console-pass-2", "pw", undefined]);
  assert.equal(redact("a console-pass-2 b console-pass c pw"), "a [REDACTED] b [REDACTED] c pw");

  const echo = { name: "echo", label: "echo", description: "", parameters: {}, execute: async () => ({ content: [{ type: "text", text: "Password: console-pass" }, { type: "image", data: "console-pass", mimeType: "image/png" }], details: {} }) } as unknown as ToolDefinition;
  const result = await withRedactedResults(echo, redact).execute("1", {}, undefined, undefined, undefined as never);
  assert.deepEqual(result.content, [{ type: "text", text: "Password: [REDACTED]" }, { type: "image", data: "console-pass", mimeType: "image/png" }]);

  const failing = { ...echo, execute: async () => { const error = new Error("login failed for console-pass"); error.name = "LoginError"; throw error; } } as unknown as ToolDefinition;
  await assert.rejects(withRedactedResults(failing, redact).execute("1", {}, undefined, undefined, undefined as never), (error: Error) => error.message === "login failed for [REDACTED]" && error.name === "LoginError");
  const plain = new Error("timeout");
  const unchanged = { ...echo, execute: async () => { throw plain; } } as unknown as ToolDefinition;
  await assert.rejects(withRedactedResults(unchanged, redact).execute("1", {}, undefined, undefined, undefined as never), (error) => error === plain);
});
