export const DEVICE_PORT_KINDS = ["ethernet", "serial", "usb", "power", "rf", "other"] as const;
export type DevicePortKind = (typeof DEVICE_PORT_KINDS)[number];

export interface DevicePort {
  id: string;
  name: string;
  kind: DevicePortKind;
  specification: string;
  note: string;
}

export const DEVICE_PORT_LABELS: Record<DevicePortKind, string> = {
  ethernet: "以太网口", serial: "串口", usb: "USB", power: "电源", rf: "射频", other: "其他",
};

export function parseDevicePorts(value: unknown): DevicePort[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("设备端口必须是数组，且不超过 256 个");
  const ports = value.map((entry): DevicePort => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("设备端口格式不正确");
    const item = entry as Record<string, unknown>;
    const text = (key: string, max: number) => {
      if (item[key] !== undefined && typeof item[key] !== "string") throw new Error("设备端口字段必须是文本");
      const result = ((item[key] as string | undefined) || "").trim();
      if (result.length > max) throw new Error("设备端口字段过长");
      return result;
    };
    const id = text("id", 100);
    const name = text("name", 80);
    if (!id || !name) throw new Error("请填写端口名称");
    if (!DEVICE_PORT_KINDS.includes(item.kind as DevicePortKind)) throw new Error(`端口“${name}”的类型不正确`);
    return { id, name, kind: item.kind as DevicePortKind, specification: text("specification", 120), note: text("note", 1_000) };
  });
  if (new Set(ports.map((port) => port.id)).size !== ports.length) throw new Error("端口 ID 不能重复");
  if (new Set(ports.map((port) => port.name.toLowerCase())).size !== ports.length) throw new Error("同一设备的端口名称不能重复");
  return ports;
}

export function devicePortUsage(ports: DevicePort[], controls: { portId?: string }[]) {
  const reserved = new Set(controls.map((control) => control.portId).filter(Boolean));
  const ethernet = ports.filter((port) => port.kind === "ethernet");
  return {
    reserved,
    ethernet: ethernet.length,
    controlEthernet: ethernet.filter((port) => reserved.has(port.id)).length,
    businessEthernet: ethernet.filter((port) => !reserved.has(port.id)).length,
  };
}
