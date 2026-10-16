import type { ControlInterfaceType } from "./api";

export const INTERFACE_LABELS: Record<ControlInterfaceType, string> = {
  web: "Web",
  ssh: "SSH",
  telnet: "Telnet",
  serial: "串口",
  api: "API",
  other: "其他",
};
