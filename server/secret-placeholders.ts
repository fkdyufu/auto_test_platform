import type { ControlInterface, DeviceResource } from "./catalog-store.js";
import { CONTROL_KINDS } from "../shared/control-interfaces.js";

/** `{{password:<interface ID>}}` or `{{token:<interface ID>}}` in tool input stands for a stored secret. */
const PLACEHOLDER = /\{\{\s*(password|token)\s*:\s*([^{}\s]+)\s*\}\}/g;

export const SECRET_PLACEHOLDER_RULE = "已保存的密码和 Token 不会提供给你。SSH、Telnet 和 API 由工具自动认证；需要手动输入时（如网页登录、串口登录、sudo），在工具参数中写 {{password:接口ID}} 或 {{token:接口ID}}，平台执行时替换为真实值，工具输出中的密码显示为 [REDACTED]。";

export const SECRET_PLACEHOLDER_HINT = "需要已保存的密码时写 {{password:接口ID}}";

function hostname(address: string): string {
  const trimmed = (address || "").trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Resolves placeholders against the devices one agent may use; the model never receives the values. */
export class SecretPlaceholders {
  constructor(private readonly devices: DeviceResource[]) {}

  /** For device tools: a secret of any interface on this agent's devices, e.g. TAU2's password typed into a session on host1. */
  resolve(text: string, check?: (control: ControlInterface, label: string) => void): string {
    if (!text.includes("{{")) return text;
    return text.replace(PLACEHOLDER, (placeholder, key: string, interfaceId: string) => {
      const matches = this.devices.flatMap((device) => device.controlInterfaces
        .filter((control) => control.id === interfaceId)
        .map((control) => ({ device, control })));
      if (!matches.length) throw new Error(`${placeholder} 中的接口 ID 不在当前可用设备中`);
      if (matches.length > 1) throw new Error(`${placeholder} 中的接口 ID 对应多个设备的接口`);
      const { device, control } = matches[0];
      const label = `${device.name} 的 ${control.name || CONTROL_KINDS[control.kind].label} 接口`;
      const value = control.settings[key] || "";
      if (!value) throw new Error(`${label}未保存${key === "token" ? " Token" : "密码"}`);
      check?.(control, label);
      return value;
    });
  }

  /** For browser_fill: only a Web interface's secret, and only on that interface's own site. */
  resolveForPage(text: string, pageUrl: string): string {
    return this.resolve(text, (control, label) => {
      if (control.kind !== "web") throw new Error(`网页中只能填写 Web 接口的密码，${label}不是 Web 接口`);
      const expected = hostname(control.settings.url || "");
      const actual = hostname(pageUrl);
      if (!expected || expected !== actual) throw new Error(`${label}的密码只能填写在 ${expected || "其网址"} 的页面中，当前页面是 ${actual || pageUrl}`);
    });
  }
}

/** Masks every stored secret in text, e.g. a password the device echoes back. Secrets shorter than 3 characters are left alone. */
export function createRedactor(secrets: Array<string | undefined>): (text: string) => string {
  const values = [...new Set(secrets.filter((value): value is string => Boolean(value && value.length >= 3)))]
    .sort((left, right) => right.length - left.length);
  return (text) => values.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
}
