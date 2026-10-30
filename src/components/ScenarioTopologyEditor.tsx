import { useMemo, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import type { DeviceResource, PhysicalLab, ScenarioInterface, ScenarioParameter, ScenarioRole, ScenarioSegment, TestScenarioInput } from "../api";
import { endLabel, findLinkAt, otherEnd } from "../../shared/physical-lab";
import {
  analyzeScenarioTopology,
  planScenarioTopology,
  topologyProblems,
  type AnalyzedSegment,
  type TopologyArea,
  type TopologyProblem,
} from "../../shared/scenario-topology";
import { labLayout, Topology } from "../pages/PhysicalLabView";
import { layoutScenario } from "../scenario-layout";
import { AutoResizeTextarea } from "./ui";

type Tab = TopologyArea | "other" | "steps" | "cases";

function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `scn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Problems of a saved scenario's topology, for marking it in the list. */
export function scenarioTopologyProblems(scenario: Pick<TestScenarioInput, "roles" | "segments">, devices: DeviceResource[], lab: PhysicalLab | null): TopologyProblem[] {
  if (!scenario.segments?.length) return [];
  return topologyProblems(analyzeScenarioTopology({ lab: lab || undefined, roles: scenario.roles, devices, segments: scenario.segments }));
}

/**
 * Edits a scenario one concern at a time — topology, addresses, mapping to the lab, other preparation — next to a
 * diagram that is always in view. What the platform will set up is shown, not edited.
 */
export function ScenarioTopologyEditor({
  form,
  onChange,
  isDefault,
  devices,
  lab,
  cases,
}: {
  form: TestScenarioInput;
  onChange: (patch: Partial<TestScenarioInput>) => void;
  isDefault: boolean;
  devices: DeviceResource[];
  lab: PhysicalLab | null;
  /** The related-cases picker; shown as the last tab when the scenario already exists. */
  cases?: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("topology");
  const [view, setView] = useState<"logic" | "phys">("logic");
  const [openId, setOpenId] = useState(form.segments[0]?.id || "");
  const analysis = useMemo(
    () => analyzeScenarioTopology({ lab: lab || undefined, roles: form.roles, devices, segments: form.segments }),
    [lab, form.roles, devices, form.segments],
  );
  const problems = topologyProblems(analysis);
  const of = (area: TopologyArea) => problems.filter((problem) => problem.area === area);

  const setSegments = (segments: ScenarioSegment[]) => onChange({ segments });
  const updateSegment = (id: string, patch: Partial<ScenarioSegment>) => setSegments(form.segments.map((segment) => segment.id === id ? { ...segment, ...patch } : segment));
  const updateInterface = (segmentId: string, interfaceId: string, patch: Partial<ScenarioInterface>) => setSegments(form.segments.map((segment) => segment.id !== segmentId ? segment : {
    ...segment,
    interfaces: segment.interfaces.map((item) => item.id === interfaceId ? { ...item, ...patch } : item),
  }));
  const updateRole = (id: string, patch: Partial<ScenarioRole>) => {
    const roles = form.roles.map((role) => role.id === id ? { ...role, ...patch } : role);
    // A role moved to another device keeps its interfaces but not the old device's ports.
    const segments = patch.deviceId === undefined ? form.segments : form.segments.map((segment) => ({
      ...segment,
      interfaces: segment.interfaces.map((item) => item.roleId === id ? { ...item, portId: "" } : item),
    }));
    onChange({ roles, segments });
  };
  const removeRole = (id: string) => onChange({
    roles: form.roles.filter((role) => role.id !== id),
    segments: form.segments.map((segment) => ({ ...segment, interfaces: segment.interfaces.filter((item) => item.roleId !== id) })),
  });
  const addRole = () => {
    let n = form.roles.length + 1;
    while (form.roles.some((role) => role.key === `R${n}`)) n += 1;
    onChange({ roles: [...form.roles, { id: newId(), key: `R${n}`, deviceId: "" }] });
  };
  const addSegment = () => {
    const id = newId();
    setSegments([...form.segments, { id, name: `网段${form.segments.length + 1}`, vlan: "", subnet: "", interfaces: [] }]);
    setOpenId(id);
  };
  const addInterface = (segment: ScenarioSegment) => {
    const role = form.roles.find((item) => !segment.interfaces.some((entry) => entry.roleId === item.id)) || form.roles[0];
    if (!role) return;
    updateSegment(segment.id, { interfaces: [...segment.interfaces, { id: newId(), roleId: role.id, name: "eth", address: "", portId: "" }] });
  };
  const updateParameter = (id: string, patch: Partial<ScenarioParameter>) => onChange({ parameters: form.parameters.map((item) => item.id === id ? { ...item, ...patch } : item) });

  const switchTab = (next: Tab) => {
    // Mapping is about the lab, so its tab shows the lab.
    if (next === "mapping") setView("phys");
    else if (tab === "mapping") setView("logic");
    setTab(next);
  };
  const tabs: [Tab, string, number][] = [
    ["topology", "拓扑", of("topology").length],
    ...(!isDefault ? [["addresses", "地址", of("addresses").length] as [Tab, string, number]] : []),
    ["mapping", "映射", of("mapping").length],
    ["other", "其他准备", 0],
    ...(!isDefault ? [["steps", "生成的步骤", 0] as [Tab, string, number]] : []),
    ...(cases ? [["cases", "关联用例", 0] as [Tab, string, number]] : []),
  ];

  return (
    <div className="scn-layout">
      <section className="scn-card scn-diagram">
        <header className="scn-card-head">
          <h3>拓扑</h3>
          <div className="scn-switch" role="group" aria-label="视图">
            <button type="button" aria-pressed={view === "logic"} onClick={() => setView("logic")}>逻辑</button>
            <button type="button" aria-pressed={view === "phys"} onClick={() => setView("phys")}>物理</button>
          </div>
        </header>
        {view === "logic"
          ? <LogicalDiagram roles={form.roles} devices={devices} analysis={analysis} selectedId={openId} onSelect={setOpenId} />
          : <PhysicalDiagram lab={lab} devices={devices} analysis={analysis} selectedId={openId} />}
      </section>

      <section className="scn-card">
        <nav className="scn-tabs" role="tablist">
          {tabs.map(([id, label, count]) => (
            <button type="button" role="tab" key={id} aria-selected={tab === id} onClick={() => switchTab(id)}>
              {label}{count > 0 && <i className="scn-dot" title={`${count} 个问题`} />}
            </button>
          ))}
        </nav>
        <div className="scn-panel" role="tabpanel">
          {tab === "topology" && <>
            <div className="scn-block">
              <h4>角色</h4>
              <div className="scn-chips">
                {form.roles.map((role) => (
                  <span className="scn-chip" key={role.id}>
                    <input value={role.key} size={Math.max(role.key.length, 2)} aria-label="角色标识" onChange={(event) => updateRole(role.id, { key: event.target.value })} />
                    <button type="button" title="删除角色" aria-label={`删除角色 ${role.key}`} onClick={() => removeRole(role.id)}><X size={12} /></button>
                  </span>
                ))}
                <button type="button" className="scn-add" onClick={addRole}><Plus size={13} />角色</button>
              </div>
            </div>
            {!isDefault && (
              <div className="scn-block">
                <h4>网段</h4>
                {analysis.map(({ segment, interfaces, problems: segmentProblems }) => {
                  const open = openId === segment.id;
                  const topologyIssues = [...segmentProblems, ...interfaces.flatMap((item) => item.problems)].filter((problem) => problem.area === "topology");
                  return (
                    <div className={open ? "scn-segment open" : "scn-segment"} key={segment.id}>
                      <button type="button" className="scn-segment-row" aria-expanded={open} onClick={() => setOpenId(open ? "" : segment.id)}>
                        <strong>{segment.name}</strong>
                        <span>{interfaces.map((item) => `${item.role?.key || "?"} ${item.item.name}`).join(" · ") || "还没有接口"}</span>
                        {topologyIssues.length > 0 && <i className="scn-dot" title={topologyIssues.map((problem) => problem.text).join("；")} />}
                        <em>{open ? "收起" : "编辑"}</em>
                      </button>
                      {open && (
                        <div className="scn-segment-edit">
                          <label className="scn-inline">名称<input value={segment.name} maxLength={40} onChange={(event) => updateSegment(segment.id, { name: event.target.value })} /></label>
                          {segment.interfaces.map((item) => (
                            <div className="scn-interface" key={item.id}>
                              <select value={item.roleId} aria-label="角色" onChange={(event) => updateInterface(segment.id, item.id, { roleId: event.target.value, portId: "" })}>
                                {form.roles.map((role) => <option key={role.id} value={role.id}>{role.key}</option>)}
                              </select>
                              <input className="mono" value={item.name} maxLength={40} aria-label="接口名" onChange={(event) => updateInterface(segment.id, item.id, { name: event.target.value })} />
                              <button type="button" className="icon-action danger" title="移除接口" onClick={() => updateSegment(segment.id, { interfaces: segment.interfaces.filter((entry) => entry.id !== item.id) })}><X size={14} /></button>
                            </div>
                          ))}
                          <Problems items={topologyIssues} />
                          <div className="scn-segment-actions">
                            <button type="button" className="scn-add" disabled={!form.roles.length} onClick={() => addInterface(segment)}><Plus size={13} />接口</button>
                            <button type="button" className="scn-quiet" onClick={() => setSegments(form.segments.filter((entry) => entry.id !== segment.id))}>删除网段</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button type="button" className="scn-add" onClick={addSegment}><Plus size={13} />网段</button>
              </div>
            )}
          </>}

          {tab === "addresses" && analysis.map(({ segment, interfaces, problems: segmentProblems }) => (
            <div className="scn-block" key={segment.id}>
              <div className="scn-block-head">
                <strong>{segment.name}</strong>
                <label className="scn-inline">地址范围<input className="mono scn-cidr" value={segment.subnet} onChange={(event) => updateSegment(segment.id, { subnet: event.target.value.trim() })} /></label>
              </div>
              {interfaces.map(({ item, role }) => (
                <div className="scn-address" key={item.id}>
                  <span className="mono">{role?.key || "?"} {item.name}</span>
                  <input className="mono" value={item.address} aria-label={`${role?.key} ${item.name} 的地址`} onChange={(event) => updateInterface(segment.id, item.id, { address: event.target.value.trim() })} />
                  <span className="scn-muted">{item.address ? "" : "不配地址"}</span>
                </div>
              ))}
              <Problems items={[...segmentProblems, ...interfaces.flatMap((entry) => entry.problems)].filter((problem) => problem.area === "addresses")} />
            </div>
          ))}

          {tab === "mapping" && <MappingTab
            form={form}
            isDefault={isDefault}
            devices={devices}
            lab={lab}
            analysis={analysis}
            onRole={updateRole}
            onPort={(segmentId, interfaceId, portId) => updateInterface(segmentId, interfaceId, { portId })}
            onVlan={(segmentId, vlan) => updateSegment(segmentId, { vlan })}
          />}

          {tab === "other" && <>
            <div className="scn-block">
              <h4>参数</h4>
              {form.parameters.length > 0 && <div className="scn-param scn-param-head"><span>标识</span><span>名称</span><span>默认值</span><span /></div>}
              {form.parameters.map((item) => (
                <div className="scn-param" key={item.id}>
                  <input className="mono" value={item.key} aria-label="参数标识" onChange={(event) => updateParameter(item.id, { key: event.target.value })} />
                  <input value={item.name} aria-label="参数名称" onChange={(event) => updateParameter(item.id, { name: event.target.value })} />
                  <input className="mono" value={item.defaultValue} aria-label="默认值" onChange={(event) => updateParameter(item.id, { defaultValue: event.target.value })} />
                  <button type="button" className="icon-action danger" title="删除参数" onClick={() => onChange({ parameters: form.parameters.filter((parameter) => parameter.id !== item.id) })}><X size={14} /></button>
                </div>
              ))}
              <button type="button" className="scn-add" onClick={() => onChange({ parameters: [...form.parameters, { id: newId(), key: "", name: "", defaultValue: "" }] })}><Plus size={13} />参数</button>
            </div>
            {!isDefault && (
              <label className="scn-block">
                <span className="scn-label">准备</span>
                <AutoResizeTextarea rows={3} value={form.setupInstructions} onChange={(event) => onChange({ setupInstructions: event.target.value })} />
              </label>
            )}
            <label className="scn-block">
              <span className="scn-label">检查</span>
              <AutoResizeTextarea rows={2} value={form.verificationInstructions} onChange={(event) => onChange({ verificationInstructions: event.target.value })} />
            </label>
            {!isDefault && (
              <label className="scn-block">
                <span className="scn-label">清理</span>
                <AutoResizeTextarea rows={2} value={form.cleanupInstructions} onChange={(event) => onChange({ cleanupInstructions: event.target.value })} />
              </label>
            )}
          </>}

          {tab === "steps" && <Steps lab={lab} devices={devices} roles={form.roles} analysis={analysis} />}

          {tab === "cases" && cases}
        </div>
      </section>
    </div>
  );
}

function Problems({ items }: { items: TopologyProblem[] }) {
  if (!items.length) return null;
  return <div className="scn-problems">{items.map((item, index) => <p key={index}>{item.text}</p>)}</div>;
}

function MappingTab({
  form,
  isDefault,
  devices,
  lab,
  analysis,
  onRole,
  onPort,
  onVlan,
}: {
  form: TestScenarioInput;
  isDefault: boolean;
  devices: DeviceResource[];
  lab: PhysicalLab | null;
  analysis: AnalyzedSegment[];
  onRole: (id: string, patch: Partial<ScenarioRole>) => void;
  onPort: (segmentId: string, interfaceId: string, portId: string) => void;
  onVlan: (segmentId: string, vlan: string) => void;
}) {
  const portOptions = (device: DeviceResource) => (device.ports || []).map((port) => {
    const end = { nodeId: device.id, portId: port.id };
    const link = lab ? findLinkAt(lab, end) : undefined;
    const control = link?.role === "control";
    return { port, control, label: `${port.name}${link && lab ? ` → ${endLabel(lab, otherEnd(link, end))}` : "（未接线）"}${control ? "（控制）" : ""}` };
  });
  const transit = [...new Set(planScenarioTopology({ lab: lab || undefined, devices, roles: form.roles }, analysis).switches.map((item) => item.name))];
  const segmentIssues = analysis.flatMap((item) => item.problems).filter((problem) => problem.area === "mapping");
  return <>
    {form.roles.map((role) => {
      const device = devices.find((item) => item.id === role.deviceId);
      const entries = analysis.flatMap(({ segment, interfaces }) => interfaces.filter((entry) => entry.item.roleId === role.id).map((entry) => ({ segment, entry })));
      const issues = entries.flatMap(({ entry }) => entry.problems).filter((problem) => problem.area === "mapping");
      return (
        <div className="scn-block" key={role.id}>
          <div className="scn-role-map">
            <strong className="mono">{role.key}</strong>
            <span className="scn-muted">→</span>
            <select value={role.deviceId} aria-label={`${role.key} 绑定的设备`} onChange={(event) => onRole(role.id, { deviceId: event.target.value })}>
              <option value="">选择设备</option>
              {role.deviceId && !device && <option value={role.deviceId} disabled>设备已删除或不可用</option>}
              {devices.map((item) => <option key={item.id} value={item.id} disabled={form.roles.some((other) => other.id !== role.id && other.deviceId === item.id)}>{item.name}</option>)}
            </select>
          </div>
          {entries.map(({ segment, entry }) => (
            <div className="scn-port-map" key={entry.item.id}>
              <span><span className="mono">{entry.item.name}</span><span className="scn-muted">{segment.name}</span></span>
              <select value={entry.item.portId} disabled={!device} aria-label={`${role.key} ${entry.item.name} 的物理端口`} onChange={(event) => onPort(segment.id, entry.item.id, event.target.value)}>
                <option value="">{device ? "选择端口" : "先绑定设备"}</option>
                {device && portOptions(device).map(({ port, control, label }) => <option key={port.id} value={port.id} disabled={control && port.id !== entry.item.portId}>{label}</option>)}
              </select>
            </div>
          ))}
          <Problems items={issues} />
        </div>
      );
    })}
    {!isDefault && analysis.length > 0 && (
      <div className="scn-block">
        <h4>VLAN</h4>
        <div className="scn-vlans">
          {analysis.map(({ segment, direct }) => direct && !segment.vlan
            ? <span className="scn-inline" key={segment.id}>{segment.name}<em className="scn-tag">直连</em></span>
            : <label className="scn-inline" key={segment.id}>{segment.name}<input className="mono scn-vlan" value={segment.vlan} onChange={(event) => onVlan(segment.id, event.target.value.trim())} /></label>)}
        </div>
        <Problems items={segmentIssues} />
        {transit.length > 0 && <p className="scn-muted">经过 {transit.join("、")}，由平台自动加入</p>}
      </div>
    )}
  </>;
}

function Steps({ lab, devices, roles, analysis }: { lab: PhysicalLab | null; devices: DeviceResource[]; roles: ScenarioRole[]; analysis: AnalyzedSegment[] }) {
  if (!analysis.length) return <p className="scn-muted">没有网段时，按其他准备执行。</p>;
  const plan = planScenarioTopology({ lab: lab || undefined, devices, roles }, analysis);
  const group = (title: string, items: string[], note?: string) => items.length ? (
    <div className="scn-steps" key={title}>
      <h4>{title}{note && <small>{note}</small>}</h4>
      <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </div>
  ) : null;
  return <>
    {plan.switches.map((item) => group(item.name, item.lines, "自动加入，平台配置"))}
    {group("需要确认", plan.passThrough, "平台不配置这些设备")}
    {group("直连", plan.direct)}
    {group("接口地址", plan.addresses)}
    {group("验证", plan.verify)}
    {group("清理", plan.cleanup)}
  </>;
}

function PhysicalDiagram({ lab, devices, analysis, selectedId }: { lab: PhysicalLab | null; devices: DeviceResource[]; analysis: AnalyzedSegment[]; selectedId: string }) {
  const deviceById = useMemo(() => new Map(devices.map((device) => [device.id, device])), [devices]);
  const layout = useMemo(() => lab ? labLayout(lab, deviceById) : null, [lab, deviceById]);
  const usage = useMemo(() => {
    const selected = new Set<string>();
    const used = new Set<string>();
    for (const { segment, interfaces } of analysis) {
      for (const entry of interfaces) for (const link of entry.path?.links || []) (segment.id === selectedId ? selected : used).add(link.id);
    }
    return { selected, used };
  }, [analysis, selectedId]);
  if (!lab || !layout) return <p className="scn-muted scn-empty">正在读取物理环境...</p>;
  return <div className="scn-phys"><Topology lab={lab} layout={layout} deviceById={deviceById} selected={null} usage={usage} /></div>;
}

const ROLE_W = 96;
const ROLE_H = 42;

function textWidth(text: string, size: number): number {
  return [...text].reduce((sum, char) => sum + (/[　-鿿＀-￯]/.test(char) ? size : size * 0.62), 0);
}

/** Where the line from a box's centre towards `to` leaves the box. */
function exitPoint(center: { x: number; y: number }, halfW: number, halfH: number, to: { x: number; y: number }) {
  const dx = to.x - center.x;
  const dy = to.y - center.y;
  const t = Math.min(dx ? halfW / Math.abs(dx) : Infinity, dy ? halfH / Math.abs(dy) : Infinity, 1);
  return { x: center.x + dx * t, y: center.y + dy * t };
}

/** The logical topology, laid out by how its roles and segments connect (see `layoutScenario`). */
function LogicalDiagram({ roles, devices, analysis, selectedId, onSelect }: {
  roles: ScenarioRole[];
  devices: DeviceResource[];
  analysis: AnalyzedSegment[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (!roles.length) return <p className="scn-muted scn-empty">先在「拓扑」里添加角色。</p>;
  const layout = layoutScenario(roles.map((role) => role.id), analysis.map(({ segment }) => ({ id: segment.id, roleIds: [...new Set(segment.interfaces.map((item) => item.roleId))] })));
  const rolePos = layout.roles;
  const pills = analysis.map(({ segment, direct }) => {
    const sub = direct && !segment.vlan ? "直连" : `VLAN ${segment.vlan || "?"}`;
    const at = layout.segments.get(segment.id)!;
    return { segment, sub, x: at.x, y: at.y, w: Math.max(textWidth(segment.name, 12), textWidth(sub, 10.5)) + 26, h: 36 };
  });
  // The drawing is as large as what is in it, with room for interface labels at the sides.
  const xs = [...rolePos.values()].flatMap((p) => [p.x - ROLE_W / 2, p.x + ROLE_W / 2]).concat(pills.flatMap((p) => [p.x - p.w / 2, p.x + p.w / 2]));
  const ys = [...rolePos.values()].flatMap((p) => [p.y - ROLE_H / 2, p.y + ROLE_H / 2]).concat(pills.flatMap((p) => [p.y - p.h / 2, p.y + p.h / 2]));
  const left = Math.min(...xs) - 80;
  const top = Math.min(...ys) - 24;
  const width = Math.max(...xs) + 80 - left;
  const height = Math.max(...ys) + 24 - top;
  const C = { x: left + width / 2, y: top + height / 2 };
  const deviceName = (id: string) => devices.find((device) => device.id === id)?.name || "未绑定";
  return (
    <div className="scn-logic">
      <svg viewBox={`${left} ${top} ${width} ${height}`} role="img" aria-label="逻辑拓扑">
        {analysis.flatMap(({ segment, interfaces }, index) => {
          const pill = pills[index];
          const selected = segment.id === selectedId;
          return interfaces.map((entry) => {
            const r = rolePos.get(entry.item.roleId);
            if (!r) return null;
            const a = exitPoint(r, ROLE_W / 2, ROLE_H / 2, pill);
            const b = exitPoint(pill, pill.w / 2, pill.h / 2, r);
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const flat = Math.abs(dy) < Math.abs(dx) * 0.4;
            const anchor = flat ? "middle" : dx > 2 || (Math.abs(dx) <= 2 && r.x > C.x + 1) ? "end" : "start";
            const lx = flat ? (a.x + b.x) / 2 : a.x + dx * 0.32 + (anchor === "end" ? -6 : 6);
            const ly = flat ? (a.y + b.y) / 2 - 7 : a.y + dy * 0.32 + 4;
            const cls = entry.problems.length ? "bad" : selected ? "sel" : "";
            return (
              <g key={entry.item.id}>
                <line className={`scn-wire ${cls}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                <text className={`scn-if ${selected ? "sel" : ""}`} x={lx} y={ly} textAnchor={anchor}>{entry.item.name}{entry.item.address ? ` ${entry.item.address}` : ""}</text>
              </g>
            );
          });
        })}
        {pills.map((pill) => (
          <g key={pill.segment.id} className={pill.segment.id === selectedId ? "scn-pill sel" : "scn-pill"} onClick={() => onSelect(pill.segment.id)}>
            <rect x={pill.x - pill.w / 2} y={pill.y - pill.h / 2} width={pill.w} height={pill.h} rx={pill.h / 2} />
            <text className="name" x={pill.x} y={pill.y - 2} textAnchor="middle">{pill.segment.name}</text>
            <text className="sub" x={pill.x} y={pill.y + 11} textAnchor="middle">{pill.sub}</text>
          </g>
        ))}
        {roles.map((role) => {
          const p = rolePos.get(role.id)!;
          const hl = analysis.some(({ segment }) => segment.id === selectedId && segment.interfaces.some((item) => item.roleId === role.id));
          return (
            <g key={role.id} className={hl ? "scn-role hl" : "scn-role"}>
              <rect x={p.x - ROLE_W / 2} y={p.y - ROLE_H / 2} width={ROLE_W} height={ROLE_H} rx={8} />
              <text className="name" x={p.x} y={p.y - 2} textAnchor="middle">{role.key}</text>
              <text className="sub" x={p.x} y={p.y + 13} textAnchor="middle">{deviceName(role.deviceId)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
