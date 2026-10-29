import { useState, type KeyboardEvent } from "react";
import { Lock, Plus, Trash2 } from "lucide-react";
import type { ControlInterfaceInput, DevicePort } from "../api";
import { CONTROL_KINDS } from "../../shared/control-interfaces";
import { DEVICE_PORT_KINDS, DEVICE_PORT_LABELS, MAX_DEVICE_PORTS, devicePortUsage, type DevicePortKind } from "../../shared/device-ports";
import { expandPortNames } from "../../shared/physical-lab";

function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `port-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The device's ports as a front panel. A lock marks a port that a control method goes through. */
export function DevicePortsEditor({
  ports,
  controls,
  cables,
  showErrors,
  onChange,
}: {
  ports: DevicePort[];
  controls: ControlInterfaceInput[];
  /** Port ID -> the far end of its cable in the lab. */
  cables: Map<string, string>;
  showErrors: boolean;
  onChange: (ports: DevicePort[], controls: ControlInterfaceInput[]) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [names, setNames] = useState("");
  const [kind, setKind] = useState<DevicePortKind>("ethernet");
  const [addError, setAddError] = useState("");
  const selected = ports.find((port) => port.id === selectedId);
  const usage = devicePortUsage(ports, controls);

  const nameCount = new Map<string, number>();
  for (const port of ports) nameCount.set(port.name.trim().toLowerCase(), (nameCount.get(port.name.trim().toLowerCase()) || 0) + 1);
  const invalid = (port: DevicePort) => port.name.trim() ? (nameCount.get(port.name.trim().toLowerCase()) || 0) > 1 : showErrors;

  const update = (id: string, patch: Partial<DevicePort>) => onChange(ports.map((port) => port.id === id ? { ...port, ...patch } : port), controls);
  const remove = (removed: DevicePort) => {
    const peer = cables.get(removed.id);
    if (peer && !window.confirm(`${removed.name} 已接 ${peer}，保存后这根线会一起删除。确定删除吗？`)) return;
    // Methods that went through the port are kept, just no longer tied to a port.
    onChange(ports.filter((port) => port.id !== removed.id), controls.map((control) => control.portId === removed.id ? { ...control, portId: "" } : control));
    setSelectedId(undefined);
  };

  const addPorts = () => {
    const expanded = expandPortNames(names);
    if (!expanded.length) return setAddError("请输入端口名");
    const existing = new Set(ports.map((port) => port.name.trim().toLowerCase()));
    const fresh = expanded.filter((name) => !existing.has(name.toLowerCase()));
    if (!fresh.length) return setAddError("这些端口都已存在");
    if (fresh.some((name) => name.length > 80)) return setAddError("端口名不能超过 80 个字符");
    if (ports.length + fresh.length > MAX_DEVICE_PORTS) return setAddError(`一台设备最多 ${MAX_DEVICE_PORTS} 个端口`);
    onChange([...ports, ...fresh.map((name) => ({ id: newId(), name, kind, specification: "", note: "" }))], controls);
    setNames("");
    setAddError("");
  };

  const onAddKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      // Enter adds the ports instead of submitting the dialog.
      event.preventDefault();
      addPorts();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      setAdding(false);
    }
  };

  return (
    <>
      <div className="device-section-title">
        物理端口
        {usage.ethernet > 0 && <small>网口 {usage.ethernet} · 控制 {usage.controlEthernet} · 业务可用 {usage.businessEthernet}</small>}
      </div>
      <div className="device-port-panel">
        {ports.map((port) => {
          const methods = [...new Set(controls.filter((control) => control.portId === port.id).map((control) => CONTROL_KINDS[control.kind].label))];
          const open = port.id === selectedId && !adding;
          return (
            <button
              type="button"
              key={port.id}
              className={["device-port", open ? "selected" : "", invalid(port) ? "invalid" : ""].filter(Boolean).join(" ")}
              aria-expanded={open}
              title={port.note || undefined}
              onClick={() => { setAdding(false); setSelectedId(open ? undefined : port.id); }}
            >
              <span className="device-port-head">
                <em className={port.name.trim() ? "" : "empty"}>{port.name.trim() || "未命名"}</em>
                {methods.length ? <Lock size={11} aria-label="控制" /> : port.kind !== "ethernet" ? <span>{DEVICE_PORT_LABELS[port.kind]}</span> : null}
              </span>
              <span className="device-port-use">{methods.join(" · ") || port.specification}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={adding ? "device-port add selected" : "device-port add"}
          title="添加端口"
          aria-label="添加端口"
          aria-expanded={adding}
          onClick={() => { setAdding(!adding); setAddError(""); }}
        >
          <Plus size={18} />
        </button>
      </div>

      {adding ? (
        <div className="device-port-add" onKeyDown={onAddKeyDown}>
          <input autoFocus value={names} aria-label="端口名" placeholder="1-8, console" onChange={(event) => setNames(event.target.value)} />
          <select value={kind} aria-label="端口类型" onChange={(event) => setKind(event.target.value as DevicePortKind)}>
            {DEVICE_PORT_KINDS.map((item) => <option key={item} value={item}>{DEVICE_PORT_LABELS[item]}</option>)}
          </select>
          <button type="button" className="button secondary compact" onClick={addPorts}><Plus size={15} />添加</button>
          {addError && <span className="device-port-error">{addError}</span>}
        </div>
      ) : selected ? (
        <div className="control-panel">
          <div className="control-panel-head">
            <input
              value={selected.name}
              maxLength={80}
              placeholder="名称"
              aria-label="端口名称"
              className={invalid(selected) ? "invalid" : ""}
              onChange={(event) => update(selected.id, { name: event.target.value })}
            />
            <button type="button" className="icon-action danger" title="删除端口" onClick={() => remove(selected)}>
              <Trash2 size={16} />
            </button>
          </div>
          <div className="control-fields">
            <label className="control-field">
              <span>类型</span>
              <select value={selected.kind} onChange={(event) => update(selected.id, { kind: event.target.value as DevicePortKind })}>
                {DEVICE_PORT_KINDS.map((item) => <option key={item} value={item}>{DEVICE_PORT_LABELS[item]}</option>)}
              </select>
            </label>
            <label className="control-field">
              <span>规格</span>
              <input value={selected.specification} maxLength={120} onChange={(event) => update(selected.id, { specification: event.target.value })} />
            </label>
            <label className="control-field span-2">
              <span>说明</span>
              <input value={selected.note} maxLength={1_000} onChange={(event) => update(selected.id, { note: event.target.value })} />
            </label>
          </div>
        </div>
      ) : null}
    </>
  );
}
