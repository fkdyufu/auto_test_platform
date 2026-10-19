import { Buffer } from "node:buffer";
import { Client as SshClient } from "ssh2";
import { SerialPort } from "serialport";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ControlInterface, ControlKind, DeviceResource } from "./catalog-store.js";
import { CONTROL_KINDS, parseSerialFrame } from "../shared/control-interfaces.js";
import type { ToolEvidence } from "./tool-evidence.js";
import { TelnetSessionPool } from "./telnet-session.js";
import { SECRET_PLACEHOLDER_HINT, SecretPlaceholders } from "./secret-placeholders.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_LENGTH = 32_000;

interface ResolvedControlInterface {
  device: DeviceResource;
  control: ControlInterface;
}

interface NetworkAddress {
  host: string;
  port: number;
}

interface SshRequest {
  control: ControlInterface;
  command: string;
  timeoutMs: number;
}

interface TelnetRequest extends SshRequest { sessionKey: string }

interface SerialRequest {
  control: ControlInterface;
  input: string;
  waitMs: number;
  appendNewline: boolean;
}

interface HttpRequest {
  control: ControlInterface;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  headers: Array<{ name: string; value: string }>;
  body?: string;
  timeoutMs: number;
}

interface DeviceProtocolAdapters {
  ssh(request: SshRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
  telnet(request: TelnetRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
  serial(request: SerialRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
  http(request: HttpRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

interface DeviceToolsOptions {
  devices: DeviceResource[];
  evidence: ToolEvidence;
  adapters?: DeviceProtocolAdapters;
}

function abortError(): Error {
  const error = new Error("设备操作已取消");
  error.name = "AbortError";
  return error;
}

function limitedText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_OUTPUT_LENGTH) return { text: value, truncated: false };
  const half = Math.floor(MAX_OUTPUT_LENGTH / 2);
  return {
    text: `${value.slice(0, half)}\n... 输出已截断 ...\n${value.slice(-half)}`,
    truncated: true,
  };
}

function textResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function settingText(control: ControlInterface, key: string): string {
  return (control.settings[key] || "").trim();
}

/** Host and port of an SSH or Telnet interface. */
export function networkTarget(control: ControlInterface, defaultPort: number): NetworkAddress {
  const host = settingText(control, "host");
  if (!host) throw new Error(`${CONTROL_KINDS[control.kind].label} 控制接口未配置地址`);
  const port = Number(settingText(control, "port") || defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${CONTROL_KINDS[control.kind].label} 控制接口端口不正确`);
  return { host, port };
}

export interface SerialOptions {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: "none" | "even" | "mark" | "odd" | "space";
}

export function serialOptions(control: ControlInterface): SerialOptions {
  const path = settingText(control, "device");
  if (!path) throw new Error("串口控制接口未配置串口设备");
  const baudRate = Number(settingText(control, "baudRate") || "115200");
  if (!Number.isInteger(baudRate) || baudRate <= 0) throw new Error("串口波特率不正确");
  return { path, baudRate, ...parseSerialFrame(settingText(control, "frame") || "8N1") };
}

function sshExec(request: SshRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const username = settingText(request.control, "username");
  if (!username) throw new Error("SSH 控制接口未配置账号");
  const target = networkTarget(request.control, 22);
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`SSH 操作超时（${request.timeoutMs}ms）`)), request.timeoutMs);
    const onAbort = () => finish(abortError());
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      client.destroy();
      if (error) reject(error);
      else resolve(result || {});
    };

    if (signal?.aborted) {
      finish(abortError());
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    client.once("error", (error) => finish(error));
    client.once("ready", () => {
      client.exec(request.command, (error, stream) => {
        if (error) {
          finish(error);
          return;
        }
        let stdout = "";
        let stderr = "";
        stream.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        stream.stderr.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        stream.once("error", (streamError: Error) => finish(streamError));
        stream.once("close", (exitCode: number | null, remoteSignal: string | null) => {
          const safeStdout = limitedText(stdout);
          const safeStderr = limitedText(stderr);
          finish(undefined, {
            success: exitCode === 0,
            stdout: safeStdout.text,
            stderr: safeStderr.text,
            exitCode,
            signal: remoteSignal,
            truncated: safeStdout.truncated || safeStderr.truncated,
          });
        });
      });
    });
    client.connect({
      host: target.host,
      port: target.port,
      username,
      password: settingText(request.control, "password") || undefined,
      readyTimeout: request.timeoutMs,
      keepaliveInterval: 5_000,
      keepaliveCountMax: 2,
    });
  });
}

function openSerialPort(port: SerialPort): Promise<void> {
  return new Promise((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
}

function writeSerialPort(port: SerialPort, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    port.write(input, (writeError) => {
      if (writeError) {
        reject(writeError);
        return;
      }
      port.drain((drainError) => (drainError ? reject(drainError) : resolve()));
    });
  });
}

function closeSerialPort(port: SerialPort): Promise<void> {
  if (!port.isOpen) return Promise.resolve();
  return new Promise((resolve) => port.close(() => resolve()));
}

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function serialExec(request: SerialRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const options = serialOptions(request.control);
  const port = new SerialPort({ ...options, autoOpen: false });
  let output = "";
  let portError: Error | undefined;
  const onData = (chunk: Buffer | string) => {
    output += chunk.toString();
  };
  const onError = (error: Error) => {
    portError = error;
  };
  const onAbort = () => port.destroy();
  port.on("data", onData);
  port.on("error", onError);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw abortError();
    await openSerialPort(port);
    if (request.input || request.appendNewline) await writeSerialPort(port, `${request.input}${request.appendNewline ? "\r\n" : ""}`);
    await waitFor(request.waitMs, signal);
    if (portError) throw portError;
    const safeOutput = limitedText(output);
    return { success: true, output: safeOutput.text, truncated: safeOutput.truncated };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    port.off("data", onData);
    port.off("error", onError);
    await closeSerialPort(port);
  }
}

async function httpRequest(request: HttpRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const address = settingText(request.control, "baseUrl");
  if (!address) throw new Error("API 控制接口未配置接口地址");
  const baseUrl = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `http://${address}`);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") throw new Error("API 控制接口仅支持 HTTP/HTTPS");
  const requestUrl = new URL(request.path || "", baseUrl.href.endsWith("/") ? baseUrl : new URL(`${baseUrl.href}/`));
  if (requestUrl.origin !== baseUrl.origin) throw new Error("API 请求路径不能跳转到控制接口之外的地址");
  const headers = new Headers(request.headers.map((item): [string, string] => [item.name, item.value]));
  const auth = settingText(request.control, "auth");
  if (!headers.has("Authorization") && auth === "basic") {
    headers.set("Authorization", `Basic ${Buffer.from(`${settingText(request.control, "username")}:${settingText(request.control, "password")}`).toString("base64")}`);
  } else if (!headers.has("Authorization") && auth === "token" && settingText(request.control, "token")) {
    headers.set("Authorization", `Bearer ${settingText(request.control, "token")}`);
  }
  if (request.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(requestUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" ? undefined : request.body,
    redirect: "manual",
    signal: combinedSignal,
  });
  const responseBody = limitedText(await response.text());
  return {
    success: response.ok,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type") || "",
    body: responseBody.text,
    truncated: responseBody.truncated,
  };
}

export class DeviceToolDriver {
  private readonly activeOperations = new Set<AbortController>();
  private readonly telnetSessions = new TelnetSessionPool();
  private readonly adapters: DeviceProtocolAdapters;
  private readonly serialQueue = new Map<string, Promise<void>>();
  private readonly secrets: SecretPlaceholders;
  private closed = false;

  constructor(
    private readonly devices: DeviceResource[],
    private readonly evidence: ToolEvidence,
    adapters?: DeviceProtocolAdapters,
  ) {
    this.secrets = new SecretPlaceholders(devices);
    this.adapters = adapters || {
      ssh: sshExec, serial: serialExec, http: httpRequest,
      telnet: (request, signal) => this.telnetSessions.execute(
        request.sessionKey,
        { username: settingText(request.control, "username"), password: settingText(request.control, "password") },
        networkTarget(request.control, 23),
        request.command,
        request.timeoutMs,
        signal,
      ),
    };
  }

  resolve(deviceId: string, interfaceId: string | undefined, kind: ControlKind): ResolvedControlInterface {
    const device = this.devices.find((item) => item.id === deviceId);
    if (!device) throw new Error(`设备不在当前 Agent 可用范围中：${deviceId}`);
    const label = CONTROL_KINDS[kind].label;
    const controls = device.controlInterfaces.filter((item) => item.kind === kind);
    if (interfaceId) {
      const control = controls.find((item) => item.id === interfaceId);
      if (!control) throw new Error(`设备“${device.name}”不存在指定的 ${label} 控制接口`);
      return { device, control };
    }
    if (!controls.length) throw new Error(`设备“${device.name}”未配置 ${label} 控制接口`);
    if (controls.length > 1) {
      throw new Error(`设备“${device.name}”有多个 ${label} 控制接口，请提供 interfaceId：${controls.map((item) => `${item.name || label}[${item.id}]`).join("、")}`);
    }
    return { device, control: controls[0] };
  }

  private async run<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw abortError();
    const controller = new AbortController();
    this.activeOperations.add(controller);
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      combinedSignal.throwIfAborted();
      const result = await operation(combinedSignal);
      this.evidence.mark();
      return result;
    } finally {
      this.activeOperations.delete(controller);
    }
  }

  async ssh(params: { deviceId: string; interfaceId?: string; command: string; timeoutMs?: number }, signal?: AbortSignal) {
    const { device, control } = this.resolve(params.deviceId, params.interfaceId, "ssh");
    const command = this.secrets.resolve(params.command);
    const result = await this.run(signal, (activeSignal) => this.adapters.ssh({
      control,
      command,
      timeoutMs: params.timeoutMs || DEFAULT_TIMEOUT_MS,
    }, activeSignal));
    return textResult({ device: device.name, interface: control.name || CONTROL_KINDS[control.kind].label, ...result });
  }

  async telnet(params: { deviceId: string; interfaceId?: string; command: string; timeoutMs?: number }, signal?: AbortSignal) {
    const { device, control } = this.resolve(params.deviceId, params.interfaceId, "telnet");
    const command = this.secrets.resolve(params.command);
    const result = await this.run(signal, (activeSignal) => this.adapters.telnet({
      control,
      sessionKey: `${device.id}:${control.id}`,
      command,
      timeoutMs: params.timeoutMs || DEFAULT_TIMEOUT_MS,
    }, activeSignal));
    return textResult({ device: device.name, interface: control.name || CONTROL_KINDS[control.kind].label, ...result });
  }

  async serial(
    params: { deviceId: string; interfaceId?: string; input: string; waitMs?: number; appendNewline?: boolean },
    signal?: AbortSignal,
  ) {
    const { device, control } = this.resolve(params.deviceId, params.interfaceId, "serial");
    const input = this.secrets.resolve(params.input);
    const key = `${device.id}:${control.id}`;
    const operation = (this.serialQueue.get(key) || Promise.resolve()).then(() => this.run(signal, (activeSignal) => this.adapters.serial({
      control,
      input,
      waitMs: params.waitMs || 1_000,
      appendNewline: params.appendNewline !== false,
    }, activeSignal)));
    this.serialQueue.set(key, operation.then(() => undefined, () => undefined));
    const result = await operation;
    return textResult({ device: device.name, interface: control.name || CONTROL_KINDS[control.kind].label, ...result });
  }

  async http(
    params: {
      deviceId: string;
      interfaceId?: string;
      method: HttpRequest["method"];
      path?: string;
      headers?: Array<{ name: string; value: string }>;
      body?: string;
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ) {
    const { device, control } = this.resolve(params.deviceId, params.interfaceId, "api");
    const path = this.secrets.resolve(params.path || "");
    const headers = (params.headers || []).map((header) => ({ name: header.name, value: this.secrets.resolve(header.value) }));
    const body = params.body === undefined ? undefined : this.secrets.resolve(params.body);
    const result = await this.run(signal, (activeSignal) => this.adapters.http({
      control,
      method: params.method,
      path,
      headers,
      body,
      timeoutMs: params.timeoutMs || DEFAULT_TIMEOUT_MS,
    }, activeSignal));
    return textResult({ device: device.name, interface: control.name || CONTROL_KINDS[control.kind].label, ...result });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.activeOperations.forEach((controller) => controller.abort());
    this.activeOperations.clear();
    await this.telnetSessions.close();
  }
}

const commonParameters = {
  deviceId: Type.String({ description: "当前 Agent 可用范围内的设备 ID；必须先通过平台上下文提供的工具查询，不能猜测" }),
  interfaceId: Type.Optional(Type.String({ description: "控制接口 ID；设备只有一个同类型接口时可省略" })),
};

export function createDeviceTools(options: DeviceToolsOptions) {
  const driver = new DeviceToolDriver(options.devices, options.evidence, options.adapters);
  const sshTool = defineTool({
    name: "device_ssh_exec",
    label: "SSH 执行命令",
    description: "通过设备已配置的 SSH 控制接口执行命令。地址和凭据由平台根据设备 ID 获取。",
    parameters: Type.Object({
      ...commonParameters,
      command: Type.String({ minLength: 1, maxLength: 20_000, description: SECRET_PLACEHOLDER_HINT }),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 120_000 })),
    }),
    execute: async (_id, params, signal) => driver.ssh(params, signal),
  });
  const telnetTool = defineTool({
    name: "device_telnet_exec",
    label: "Telnet 执行命令",
    description: "通过已配置的 Telnet 接口执行 CLI 命令。当前 Agent 内保留连接和配置视图，同一接口命令串行执行；多行命令逐条等待提示符，报错后停止后续命令。输出保留提示符。连接中断不会自动重发命令，下次调用须确认并重新进入所需视图。",
    parameters: Type.Object({
      ...commonParameters,
      command: Type.String({ minLength: 1, maxLength: 20_000, description: SECRET_PLACEHOLDER_HINT }),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 120_000 })),
    }),
    execute: async (_id, params, signal) => driver.telnet(params, signal),
  });
  const serialTool = defineTool({
    name: "device_serial_exec",
    label: "串口交互",
    description: "向设备已配置的本地串口发送内容并读取响应。串口设备、波特率和数据格式按接口配置使用。",
    parameters: Type.Object({
      ...commonParameters,
      input: Type.String({ maxLength: 20_000, description: `发送内容；留空且 appendNewline=true 可发送回车，留空且 false 仅读取。${SECRET_PLACEHOLDER_HINT}` }),
      waitMs: Type.Optional(Type.Number({ minimum: 100, maximum: 10_000 })),
      appendNewline: Type.Optional(Type.Boolean({ description: "是否自动追加 CRLF，默认 true" })),
    }),
    execute: async (_id, params, signal) => driver.serial(params, signal),
  });
  const httpTool = defineTool({
    name: "device_http_request",
    label: "设备 API 请求",
    description: "向设备已配置的 API 控制接口发送同源 HTTP 请求。平台按接口配置自动使用账号密码（Basic）或 Token（Bearer）认证。",
    parameters: Type.Object({
      ...commonParameters,
      method: Type.Union([
        Type.Literal("GET"),
        Type.Literal("POST"),
        Type.Literal("PUT"),
        Type.Literal("PATCH"),
        Type.Literal("DELETE"),
      ]),
      path: Type.Optional(Type.String({ maxLength: 4_000, description: "相对于接口基地址的路径，可包含查询参数" })),
      headers: Type.Optional(Type.Array(Type.Object({
        name: Type.String({ minLength: 1, maxLength: 200 }),
        value: Type.String({ maxLength: 4_000 }),
      }), { maxItems: 30 })),
      body: Type.Optional(Type.String({ maxLength: 100_000, description: `请求体；JSON 请求应传入 JSON 字符串。${SECRET_PLACEHOLDER_HINT}，Token 写 {{token:接口ID}}` })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 120_000 })),
    }),
    execute: async (_id, params, signal) => driver.http(params, signal),
  });

  const availableTypes = new Set(options.devices.flatMap((device) => device.controlInterfaces.map((item) => item.kind)));
  const tools = [
    ...(availableTypes.has("ssh") ? [sshTool] : []),
    ...(availableTypes.has("telnet") ? [telnetTool] : []),
    ...(availableTypes.has("serial") ? [serialTool] : []),
    ...(availableTypes.has("api") ? [httpTool] : []),
  ];
  return { driver, tools, toolNames: tools.map((tool) => tool.name) };
}

export type { DeviceProtocolAdapters };
