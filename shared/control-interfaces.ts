export type ControlKind = "ssh" | "telnet" | "serial" | "web" | "api" | "other";

export interface ControlFieldOption {
  value: string;
  label: string;
}

export interface ControlField {
  key: string;
  label: string;
  input: "text" | "number" | "select" | "secret" | "textarea";
  required?: boolean;
  default?: string;
  placeholder?: string;
  options?: ControlFieldOption[];
  /** Select fields also accept stored values matching this, e.g. a migrated 921600 baud rate. */
  accepts?: RegExp;
  /** Width out of four columns in the edit form. */
  span?: 1 | 2 | 3 | 4;
  /** Shown (and validated) only while another field has this value. */
  showWhen?: { key: string; equals: string };
}

export interface ControlKindDefinition {
  label: string;
  group: string;
  keywords?: string;
  fields: ControlField[];
}

/** A control interface: each method has its own settings, defined below. Secrets live in `settings` on the server. */
export interface ControlInterface {
  id: string;
  name: string;
  kind: ControlKind;
  settings: Record<string, string>;
}

/** What the browser and the assistant see: secret values are removed and only flagged as set. */
export interface PublicControlInterface extends ControlInterface {
  secretsSet: string[];
}

const options = (...values: string[]): ControlFieldOption[] => values.map((value) => ({ value, label: value }));

export const CONTROL_GROUPS = ["命令行", "网页与 API", "其他"];

export const CONTROL_KINDS: Record<ControlKind, ControlKindDefinition> = {
  ssh: {
    label: "SSH",
    group: "命令行",
    fields: [
      { key: "host", label: "地址", input: "text", required: true, placeholder: "192.168.1.1", span: 3 },
      { key: "port", label: "端口", input: "number", default: "22", span: 1 },
      { key: "username", label: "账号", input: "text", required: true, span: 2 },
      { key: "password", label: "密码", input: "secret", span: 2 },
    ],
  },
  telnet: {
    label: "Telnet",
    group: "命令行",
    fields: [
      { key: "host", label: "地址", input: "text", required: true, placeholder: "192.168.1.1", span: 3 },
      { key: "port", label: "端口", input: "number", default: "23", span: 1 },
      { key: "username", label: "账号", input: "text", span: 2 },
      { key: "password", label: "密码", input: "secret", span: 2 },
    ],
  },
  serial: {
    label: "串口",
    group: "命令行",
    keywords: "console com tty",
    fields: [
      { key: "device", label: "串口设备", input: "text", required: true, placeholder: "/dev/ttyUSB0", span: 2 },
      { key: "baudRate", label: "波特率", input: "select", default: "115200", options: options("1200", "2400", "4800", "9600", "19200", "38400", "57600", "115200", "230400", "460800", "921600", "1500000"), accepts: /^[1-9]\d{0,7}$/, span: 1 },
      { key: "frame", label: "数据格式", input: "select", default: "8N1", options: options("8N1", "8E1", "8O1", "7E1", "7O1", "8N2"), accepts: /^[5-8][NEOMS][12]$/, span: 1 },
      { key: "username", label: "登录账号", input: "text", span: 2 },
      { key: "password", label: "登录密码", input: "secret", span: 2 },
    ],
  },
  web: {
    label: "Web",
    group: "网页与 API",
    keywords: "http 浏览器 网页",
    fields: [
      { key: "url", label: "网址", input: "text", required: true, placeholder: "http://192.168.1.1/", span: 4 },
      { key: "username", label: "登录账号", input: "text", span: 2 },
      { key: "password", label: "登录密码", input: "secret", span: 2 },
    ],
  },
  api: {
    label: "API",
    group: "网页与 API",
    keywords: "http rest",
    fields: [
      { key: "baseUrl", label: "接口地址", input: "text", required: true, placeholder: "http://192.168.1.1/api/", span: 3 },
      { key: "auth", label: "认证", input: "select", default: "none", options: [{ value: "none", label: "无" }, { value: "basic", label: "账号密码" }, { value: "token", label: "Token" }], span: 1 },
      { key: "username", label: "账号", input: "text", required: true, span: 2, showWhen: { key: "auth", equals: "basic" } },
      { key: "password", label: "密码", input: "secret", span: 2, showWhen: { key: "auth", equals: "basic" } },
      { key: "token", label: "Token", input: "secret", span: 4, showWhen: { key: "auth", equals: "token" } },
    ],
  },
  other: {
    label: "其他",
    group: "其他",
    fields: [
      { key: "notes", label: "访问方式", input: "textarea", required: true, span: 4 },
      { key: "username", label: "账号", input: "text", span: 2 },
      { key: "password", label: "密码", input: "secret", span: 2 },
    ],
  },
};

export const CONTROL_KIND_ORDER = Object.keys(CONTROL_KINDS) as ControlKind[];

export function isControlKind(value: unknown): value is ControlKind {
  return typeof value === "string" && Object.hasOwn(CONTROL_KINDS, value);
}

export function controlDefaults(kind: ControlKind): Record<string, string> {
  return Object.fromEntries(CONTROL_KINDS[kind].fields.map((field) => [field.key, field.default ?? ""]));
}

export function isFieldShown(field: ControlField, settings: Record<string, string>): boolean {
  return !field.showWhen || (settings[field.showWhen.key] ?? "") === field.showWhen.equals;
}

export function secretKeys(kind: ControlKind): string[] {
  return CONTROL_KINDS[kind].fields.filter((field) => field.input === "secret").map((field) => field.key);
}

/** Required fields that are shown but still empty. A secret counts as filled when one is already stored. */
export function missingControlFields(control: Pick<ControlInterface, "kind" | "settings">, secretsSet: string[] = []): ControlField[] {
  return CONTROL_KINDS[control.kind].fields.filter((field) => field.required
    && isFieldShown(field, control.settings)
    && !(control.settings[field.key] ?? "").trim()
    && !(field.input === "secret" && secretsSet.includes(field.key)));
}

/** One line for lists: the address-like settings, never a secret. */
export function controlSummary(control: Pick<ControlInterface, "kind" | "settings">): string {
  const value = control.settings;
  switch (control.kind) {
    case "ssh":
    case "telnet":
      return value.host ? `${value.host}:${value.port || (control.kind === "ssh" ? 22 : 23)}${value.username ? ` · ${value.username}` : ""}` : "";
    case "serial":
      return value.device ? `${value.device} · ${value.baudRate || "115200"} ${value.frame || "8N1"}` : "";
    case "web":
      return value.url || "";
    case "api":
      return value.baseUrl ? `${value.baseUrl}${value.auth === "basic" ? " · 账号密码" : value.auth === "token" ? " · Token" : ""}` : "";
    default:
      return (value.notes || "").split("\n")[0];
  }
}

/**
 * Field-by-field text for prompts. Secrets are written out only when `includeSecrets` is set: test execution needs
 * them to log in through web pages and consoles; diagnostics and the assistant do not.
 */
export function describeControlSettings(control: Pick<ControlInterface, "kind" | "settings">, includeSecrets: boolean): string {
  return CONTROL_KINDS[control.kind].fields
    .filter((field) => isFieldShown(field, control.settings) && (control.settings[field.key] ?? "").trim())
    .filter((field) => includeSecrets || field.input !== "secret")
    .map((field) => {
      const raw = control.settings[field.key];
      const shown = field.options?.find((option) => option.value === raw)?.label ?? raw;
      return `${field.label} ${shown}`;
    })
    .join("，");
}

export interface SerialFrame {
  dataBits: 5 | 6 | 7 | 8;
  parity: "none" | "even" | "odd" | "mark" | "space";
  stopBits: 1 | 2;
}

/** "8N1" -> 8 data bits, no parity, 1 stop bit. */
export function parseSerialFrame(frame: string): SerialFrame {
  const match = /^([5-8])([NEOMS])([12])$/i.exec(frame || "8N1");
  if (!match) throw new Error(`串口数据格式不正确：${frame}`);
  return {
    dataBits: Number(match[1]) as SerialFrame["dataBits"],
    parity: ({ N: "none", E: "even", O: "odd", M: "mark", S: "space" } as const)[match[2].toUpperCase() as "N" | "E" | "O" | "M" | "S"],
    stopBits: Number(match[3]) as 1 | 2,
  };
}

/** The form a control interface had before catalog version 14: one address string plus account and password. */
export interface LegacyControlInterface {
  id: string;
  name: string;
  type: string;
  address: string;
  username?: string;
  password?: string;
}

function splitHostPort(address: string, protocol: string): { host: string; port: string } {
  const trimmed = address.trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `${protocol}://${trimmed}`);
    if (url.hostname) return { host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port };
  } catch {
    // Fall through and keep the text as the host so nothing is lost.
  }
  return { host: trimmed, port: "" };
}

export function controlFromLegacy(legacy: LegacyControlInterface): ControlInterface {
  const username = legacy.username || "";
  const password = legacy.password || "";
  const address = (legacy.address || "").trim();
  const base = { id: legacy.id, name: legacy.name || "" };
  switch (legacy.type) {
    case "ssh":
    case "telnet": {
      const kind = legacy.type;
      const { host, port } = splitHostPort(address, kind);
      return { ...base, kind, settings: { ...controlDefaults(kind), host, ...(port ? { port } : {}), username, password } };
    }
    case "serial": {
      let path = address;
      let query = "";
      if (address.startsWith("serial://")) {
        try {
          const url = new URL(address);
          path = decodeURIComponent(url.pathname);
          query = url.search.slice(1);
        } catch {
          path = address;
        }
      } else if (address.includes("?")) {
        [path, query] = [address.slice(0, address.indexOf("?")), address.slice(address.indexOf("?") + 1)];
      }
      const parameters = new URLSearchParams(query);
      const parity = ({ none: "N", even: "E", odd: "O", mark: "M", space: "S" } as Record<string, string>)[parameters.get("parity") || "none"] || "N";
      const frame = `${parameters.get("dataBits") || "8"}${parity}${parameters.get("stopBits") || "1"}`;
      return {
        ...base,
        kind: "serial",
        settings: { ...controlDefaults("serial"), device: path, baudRate: parameters.get("baudRate") || "115200", frame, username, password },
      };
    }
    case "web":
      return { ...base, kind: "web", settings: { ...controlDefaults("web"), url: address, username, password } };
    case "api": {
      const auth = username ? "basic" : password ? "token" : "none";
      return {
        ...base,
        kind: "api",
        settings: { ...controlDefaults("api"), baseUrl: address, auth, ...(auth === "basic" ? { username, password } : {}), ...(auth === "token" ? { token: password } : {}) },
      };
    }
    default:
      return { ...base, kind: "other", settings: { ...controlDefaults("other"), notes: address, username, password } };
  }
}
