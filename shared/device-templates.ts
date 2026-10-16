import type { ControlKind } from "./control-interfaces.js";

export type DeviceTemplateId = "product" | "switch" | "router" | "linux" | "power" | "custom";

export interface TemplateInterface {
  kind: ControlKind;
  name?: string;
  settings?: Record<string, string>;
}

export interface DeviceTemplate {
  id: DeviceTemplateId;
  /** Display name; the product card uses the current product's name instead. */
  name: string;
  /** Interfaces a new device of this type starts with. */
  interfaces: TemplateInterface[];
  /** Methods offered first when adding an interface. */
  common: ControlKind[];
  /** Pre-filled settings used the first time a method is added, e.g. the LuCI path. */
  presets: TemplateInterface[];
}

export const DEVICE_TEMPLATES: DeviceTemplate[] = [
  {
    id: "product",
    name: "当前产品",
    interfaces: [{ kind: "ssh", settings: { username: "root" } }],
    common: ["ssh", "web", "serial"],
    presets: [
      { kind: "web", name: "LuCI", settings: { url: "http://192.168.1.1/cgi-bin/luci/", username: "root" } },
      { kind: "serial", name: "调试串口", settings: { device: "/dev/ttyACM0" } },
    ],
  },
  {
    id: "switch",
    name: "交换机",
    interfaces: [{ kind: "telnet" }],
    common: ["telnet", "ssh", "serial"],
    presets: [{ kind: "serial", name: "Console", settings: { baudRate: "9600" } }],
  },
  {
    id: "router",
    name: "路由器",
    interfaces: [{ kind: "ssh" }],
    common: ["ssh", "telnet", "web"],
    presets: [],
  },
  {
    id: "linux",
    name: "Linux 主机",
    interfaces: [{ kind: "ssh", settings: { username: "root" } }],
    common: ["ssh", "serial"],
    presets: [],
  },
  {
    id: "power",
    name: "程控电源",
    interfaces: [{ kind: "serial", settings: { device: "/dev/ttyUSB1", baudRate: "9600" } }],
    common: ["serial", "api"],
    presets: [],
  },
  {
    id: "custom",
    name: "自定义设备",
    interfaces: [],
    common: ["ssh", "telnet", "serial", "web"],
    presets: [],
  },
];

export function isDeviceTemplateId(value: unknown): value is DeviceTemplateId {
  return typeof value === "string" && DEVICE_TEMPLATES.some((template) => template.id === value);
}

export function deviceTemplate(id: string): DeviceTemplate {
  return DEVICE_TEMPLATES.find((template) => template.id === id) || DEVICE_TEMPLATES[DEVICE_TEMPLATES.length - 1];
}

export function deviceTemplateName(id: string, productName: string): string {
  return id === "product" ? productName : deviceTemplate(id).name;
}

/**
 * Picks a type for a device saved before types existed (catalog version 14). Only unambiguous labels are mapped;
 * anything else becomes a custom device so a wrong guess never relabels it.
 */
export function templateFromLegacyTypes(types: string[], model: string, productName: string): DeviceTemplateId {
  const product = productName.trim().toLowerCase();
  if (product && [model, ...types].some((value) => value.trim().toLowerCase() === product)) return "product";
  const mapped = types.map((type): DeviceTemplateId | null => {
    const value = type.trim().toLowerCase();
    if (/交换机|switch/.test(value)) return "switch";
    if (/路由|router/.test(value)) return "router";
    if (/^(host|linux|linux ?主机|主机|pc|server)$/.test(value)) return "linux";
    if (/电源|power/.test(value)) return "power";
    return null;
  });
  const first = mapped[0];
  return first && mapped.every((item) => item === first) ? first : "custom";
}
