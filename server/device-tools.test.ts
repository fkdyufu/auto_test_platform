import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { BrowserDriver, createBrowserTools, type FinishResult } from "./browser-tools.js";
import type { DeviceResource } from "./catalog-store.js";
import {
  createDeviceTools,
  DeviceToolDriver,
  parseNetworkAddress,
  parseSerialAddress,
  type DeviceProtocolAdapters,
} from "./device-tools.js";
import { createToolEvidence } from "./tool-evidence.js";

const timestamp = "2026-09-02T00:00:00.000Z";

function testDevice(): DeviceResource {
  return {
    id: "device-1",
    productId: "product-1",
    name: "TAU-1",
    types: ["TAU"],
    model: "WKCJ-II",
    description: "",
    controlInterfaces: [
      { id: "ssh-1", name: "SSH", type: "ssh", address: "192.0.2.10:2222", username: "root", password: "secret" },
      { id: "telnet-1", name: "Telnet", type: "telnet", address: "192.0.2.10", username: "root", password: "secret" },
      { id: "serial-1", name: "Console", type: "serial", address: "/dev/ttyUSB0?baudRate=9600", username: "", password: "" },
      { id: "api-1", name: "REST API", type: "api", address: "http://192.0.2.10/api", username: "api", password: "secret" },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function mockAdapters(calls: string[]): DeviceProtocolAdapters {
  return {
    ssh: async (request) => {
      calls.push(`ssh:${request.control.id}:${request.command}`);
      return { success: true, stdout: "ssh output", exitCode: 0 };
    },
    telnet: async (request) => {
      calls.push(`telnet:${request.control.id}:${request.command}`);
      return { success: true, stdout: "telnet output" };
    },
    serial: async (request) => {
      calls.push(`serial:${request.control.id}:${request.input}`);
      return { success: true, output: "serial output" };
    },
    http: async (request) => {
      calls.push(`http:${request.control.id}:${request.method}:${request.path}`);
      return { success: true, status: 200, body: "api output" };
    },
  };
}

test("parses network and serial control interface addresses", () => {
  assert.deepEqual(parseNetworkAddress("192.0.2.10:2222", 22, ["ssh:"]), { host: "192.0.2.10", port: 2222 });
  assert.deepEqual(parseNetworkAddress("telnet://router.local", 23, ["telnet:"]), { host: "router.local", port: 23 });
  assert.deepEqual(parseSerialAddress("/dev/ttyUSB0?baudRate=9600&dataBits=7&stopBits=2&parity=even"), {
    path: "/dev/ttyUSB0",
    baudRate: 9600,
    dataBits: 7,
    stopBits: 2,
    parity: "even",
  });
  assert.throws(() => parseNetworkAddress("http://192.0.2.10", 22, ["ssh:"]), /协议不正确/);
  assert.throws(() => parseSerialAddress("/dev/ttyUSB0?dataBits=9"), /dataBits/);
});

test("resolves configured interfaces and marks evidence after device operations", async () => {
  const calls: string[] = [];
  const evidence = createToolEvidence();
  const driver = new DeviceToolDriver([testDevice()], evidence, mockAdapters(calls));

  await driver.ssh({ deviceId: "device-1", command: "uname -a" });
  await driver.telnet({ deviceId: "device-1", command: "show version" });
  await driver.serial({ deviceId: "device-1", input: "status" });
  await driver.http({ deviceId: "device-1", method: "GET", path: "status" });

  assert.deepEqual(calls, [
    "ssh:ssh-1:uname -a",
    "telnet:telnet-1:show version",
    "serial:serial-1:status",
    "http:api-1:GET:status",
  ]);
  assert.equal(evidence.hasEvidence(), true);
  assert.throws(() => driver.resolve("unknown", undefined, "ssh"), /不在当前 Agent 可用范围/);
});

test("requires interfaceId when a device has multiple interfaces of one type", () => {
  const device = testDevice();
  device.controlInterfaces.push({
    id: "ssh-2",
    name: "Backup SSH",
    type: "ssh",
    address: "192.0.2.11:22",
    username: "root",
    password: "",
  });
  const driver = new DeviceToolDriver([device], createToolEvidence(), mockAdapters([]));
  assert.throws(() => driver.resolve(device.id, undefined, "ssh"), /多个 SSH 控制接口/);
  assert.equal(driver.resolve(device.id, "ssh-2", "ssh").control.address, "192.0.2.11:22");
});

test("registers only tools available on the bound devices", () => {
  const allTools = createDeviceTools({ devices: [testDevice()], evidence: createToolEvidence() });
  assert.deepEqual(allTools.toolNames, [
    "device_ssh_exec",
    "device_telnet_exec",
    "device_serial_exec",
    "device_http_request",
  ]);

  const browserOnly = testDevice();
  browserOnly.controlInterfaces = [{
    id: "web-1",
    name: "Web",
    type: "web",
    address: "http://192.0.2.10",
    username: "",
    password: "",
  }];
  assert.deepEqual(createDeviceTools({ devices: [browserOnly], evidence: createToolEvidence() }).toolNames, []);
});

test("aborts active device operations when the driver closes", async () => {
  const evidence = createToolEvidence();
  const adapters = mockAdapters([]);
  adapters.ssh = async (_request, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const driver = new DeviceToolDriver([testDevice()], evidence, adapters);
  const execution = driver.ssh({ deviceId: "device-1", command: "sleep 60" });
  await driver.close();

  await assert.rejects(execution, /aborted/);
  assert.equal(evidence.hasEvidence(), false);
});

test("performs a real same-origin API request with configured credentials", async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/status");
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("api-user:api-password").toString("base64")}`);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "ready" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const { port } = server.address() as AddressInfo;
  const device = testDevice();
  device.controlInterfaces = [{
    id: "api-local",
    name: "Local API",
    type: "api",
    address: `http://127.0.0.1:${port}/api`,
    username: "api-user",
    password: "api-password",
  }];
  const evidence = createToolEvidence();
  const driver = new DeviceToolDriver([device], evidence);

  const result = await driver.http({ deviceId: device.id, method: "GET", path: "status" });
  const payload = JSON.parse(result.content[0].text) as { success: boolean; status: number; body: string };
  assert.equal(payload.success, true);
  assert.equal(payload.status, 200);
  assert.deepEqual(JSON.parse(payload.body), { status: "ready" });
  assert.equal(evidence.hasEvidence(), true);
  await assert.rejects(
    driver.http({ deviceId: device.id, method: "GET", path: "http://example.com/outside" }),
    /不能跳转到控制接口之外/,
  );
});

test("allows finish_test after evidence from a non-browser device tool", async () => {
  const evidence = createToolEvidence();
  let finishResult: FinishResult | undefined;
  const toolset = createBrowserTools({
    runId: "device-evidence",
    artifactsDirectory: "/tmp/auto-test-platform-artifacts",
    evidence,
    onFinish: (result) => {
      finishResult = result;
    },
  });
  const finishTool = toolset.tools.find((tool) => tool.name === "finish_test");
  assert.ok(finishTool);
  assert.equal("roleBindings" in finishTool.parameters.properties, false);
  const execute = finishTool.execute as unknown as (
    id: string,
    params: { status: "passed" | "failed"; summary: string },
  ) => Promise<unknown>;

  await assert.rejects(execute("finish-1", { status: "passed", summary: "未执行工具" }), /真实设备或页面结果/);
  evidence.mark();
  await execute("finish-2", { status: "passed", summary: "SSH 检查通过" });
  assert.deepEqual(finishResult, { status: "passed", summary: "SSH 检查通过" });
  await toolset.driver.close();
});

test("omits finish_test for diagnostic browser tools", async () => {
  const toolset = createBrowserTools({
    runId: "diagnostic-run",
    artifactsDirectory: "/tmp",
    evidence: createToolEvidence(),
    includeFinishTool: false,
    onFinish: () => undefined,
  });

  assert.equal(toolset.toolNames.includes("browser_open"), true);
  assert.equal(toolset.toolNames.includes("browser_drag"), true);
  assert.equal(toolset.toolNames.includes("finish_test"), false);
  await toolset.driver.close();
});

test("drags an HTML5 draggable element to another inspected element", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
      <title>before</title>
      <style>.item { width: 180px; height: 60px; margin: 12px; background: #ddd; }</style>
      <div id="list">
        <div id="first" class="item" draggable="true"><span class="drag-handle" aria-label="拖动第一项">☰</span>第一项</div>
        <div id="second" class="item" draggable="true"><span class="drag-handle" aria-label="拖动第二项">☰</span>第二项</div>
      </div>
      <script>
        let dragged;
        const list = document.querySelector('#list');
        list.addEventListener('dragstart', (event) => {
          dragged = event.target;
          event.dataTransfer.setData('text/plain', dragged.id);
        });
        list.addEventListener('dragover', (event) => event.preventDefault());
        list.addEventListener('drop', (event) => {
          event.preventDefault();
          const target = event.target.closest('[draggable="true"]');
          if (dragged && target && dragged !== target) {
            target.after(dragged);
            document.title = 'dropped';
          }
        });
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const driver = new BrowserDriver("/tmp/auto-test-platform-drag-test");
  t.after(() => driver.close());
  const { port } = server.address() as AddressInfo;

  const before = JSON.parse(await driver.open(`http://127.0.0.1:${port}`)) as {
    elements: Array<{ ref: string; text: string; ariaLabel?: string; draggable?: boolean }>;
  };
  const first = before.elements.find((element) => element.ariaLabel === "拖动第一项");
  const second = before.elements.find((element) => element.ariaLabel === "拖动第二项");
  assert.equal(first?.ref, "@e2");
  assert.equal(second?.ref, "@e4");

  const after = JSON.parse(await driver.drag(first!.ref, second!.ref)) as { title: string; text: string };
  assert.equal(after.title, "dropped");
  assert.equal(after.text, "☰第二项 ☰第一项");
});

test("serial commands for one interface are serialized and empty input is supported", async () => {
  const calls: string[] = [];
  const adapters = mockAdapters(calls);
  let active = 0;
  adapters.serial = async (request) => {
    assert.equal(active, 0);
    active += 1;
    calls.push(request.input);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return { success: true, output: request.input };
  };
  const driver = new DeviceToolDriver([testDevice()], createToolEvidence(), adapters);
  await Promise.all([driver.serial({ deviceId: "device-1", input: "first" }), driver.serial({ deviceId: "device-1", input: "" })]);
  assert.deepEqual(calls, ["first", ""]);
  await driver.close();
  await assert.rejects(driver.serial({ deviceId: "device-1", input: "not-sent" }), /取消/);
  const toolset = createDeviceTools({ devices: [testDevice()], evidence: createToolEvidence(), adapters });
  const serial = toolset.tools.find((tool) => tool.name === "device_serial_exec")!;
  assert.equal(serial.parameters.properties.input.minLength, undefined);
  await toolset.driver.close();
});
