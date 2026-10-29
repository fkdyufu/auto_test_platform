import { useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { DeviceResource, PhysicalLab, ScenarioRole } from "../api";
import { endLabel, findLinkAt, otherEnd } from "../../shared/physical-lab";
import { scenarioPortUse } from "../../shared/scenario-ports";

/** Picked ports of a role whose cable is not registered in the lab. */
export function uncabledScenarioPorts(lab: PhysicalLab | null, role: ScenarioRole, device?: DeviceResource): string[] {
  return (role.portIds || [])
    .filter((portId) => !(lab && findLinkAt(lab, { nodeId: role.deviceId, portId })))
    .map((portId) => device?.ports?.find((port) => port.id === portId)?.name || portId);
}

/** The ports of a role's device, to pick the ones the scenario uses. A picked port brings the far end of its cable. */
export function ScenarioRolePorts({
  role,
  roles,
  device,
  lab,
  onChange,
}: {
  role: ScenarioRole;
  roles: ScenarioRole[];
  device: DeviceResource;
  lab: PhysicalLab | null;
  onChange: (portIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ports = device.ports || [];
  if (!ports.length) return null;
  const picked = new Set(role.portIds || []);
  const used = scenarioPortUse(lab || undefined, roles).used.get(device.id) || new Set<string>();
  const peerOf = (portId: string) => {
    const end = { nodeId: device.id, portId };
    const link = lab ? findLinkAt(lab, end) : undefined;
    return lab && link ? endLabel(lab, otherEnd(link, end)) : "";
  };
  const uncabled = uncabledScenarioPorts(lab, role, device);
  const summary = ports.filter((port) => used.has(port.id)).map((port) => port.name).join("、");
  const toggle = (portId: string) => {
    const next = new Set(picked);
    if (next.has(portId)) next.delete(portId);
    else next.add(portId);
    onChange(ports.filter((port) => next.has(port.id)).map((port) => port.id));
  };

  return (
    <div className="scenario-role-ports">
      <button type="button" className="scenario-ports-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        使用端口
        <span>{summary || "未选择"}</span>
        {uncabled.length > 0 && <i className="port-warning-dot" title={`${uncabled.join("、")} 未接线`} />}
      </button>
      {open && (
        <div className="device-port-panel">
          {ports.map((port) => {
            const explicit = picked.has(port.id);
            const implied = !explicit && used.has(port.id);
            const peer = peerOf(port.id);
            return (
              <button
                type="button"
                key={port.id}
                className={["device-port", explicit ? "selected" : "", implied ? "implied" : "", explicit && !peer ? "missing" : ""].filter(Boolean).join(" ")}
                aria-pressed={explicit}
                title={[peer, implied ? "对端已选用" : ""].filter(Boolean).join("，") || undefined}
                onClick={() => toggle(port.id)}
              >
                <span className="device-port-head"><em>{port.name}</em>{explicit && <Check size={12} />}</span>
                <span className="device-port-use">{peer || "未接线"}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
