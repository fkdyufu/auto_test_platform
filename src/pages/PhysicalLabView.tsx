import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  api,
  type DeviceResource,
  type LabLink,
  type LabLinkEnd,
  type LabLinkRole,
  type LabNode,
  type LabPortKind,
  type PhysicalLab,
  type ProductSummary,
} from "../api";
import {
  LAB_CABLE_LABELS,
  LAB_LINK_ROLE_LABELS,
  LAB_PORT_KINDS,
  LAB_PORT_KIND_LABELS,
  defaultLinkRole,
  endLabel,
  expandPortNames,
  findLinkAt,
  findPort,
  otherEnd,
  portKindsCompatible,
  resolveControlPath,
  sameEnd,
} from "../../shared/physical-lab";
import { CONTROL_KINDS, controlSummary } from "../../shared/control-interfaces";
import { borderPoint, labelWidth, layoutLab, type PlacedNode } from "../lab-layout";
import { AutoResizeTextarea, Modal, type Notice } from "../components/ui";

type LabContent = Pick<PhysicalLab, "rules" | "nodes" | "links">;
type LabViewMode = "panel" | "device";

const ROLE_HINTS: Record<LabLinkRole, string> = {
  data: "场景搭建时可以修改这条链路两端的配置",
  control: "平台经这根线控制设备，场景不得修改两端配置",
  power: "由程控电源供电，可用于断电重启",
};

function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function content(lab: PhysicalLab): LabContent {
  return { rules: lab.rules, nodes: structuredClone(lab.nodes), links: structuredClone(lab.links) };
}

function touches(link: LabLink, nodeId: string, portId?: string): boolean {
  return [link.a, link.b].some((end) => end.nodeId === nodeId && (portId === undefined || end.portId === portId));
}

function nodeSubtitle(node: LabNode, device?: DeviceResource): string {
  if (node.kind === "platform") return "测试平台";
  if (node.kind === "external") return "外部节点 · 不受平台控制";
  return device?.templateName || "";
}

function nodeShortSubtitle(node: LabNode, device?: DeviceResource): string {
  if (node.kind === "platform") return "测试平台";
  if (node.kind === "external") return "外部";
  return device?.templateName || "设备";
}

export function PhysicalLabView({
  product,
  lab,
  devices,
  onLabChange,
  onNotice,
}: {
  product: ProductSummary;
  lab: PhysicalLab;
  devices: DeviceResource[];
  onLabChange: (lab: PhysicalLab) => void;
  onNotice: (notice: Notice) => void;
}) {
  const [view, setView] = useState<LabViewMode>("panel");
  const [focusId, setFocusId] = useState("");
  const [selected, setSelected] = useState<LabLinkEnd | null>(null);
  const [editing, setEditing] = useState<LabLinkEnd | null>(null);
  const [rulesDraft, setRulesDraft] = useState<string | null>(null);
  const [nodeDialog, setNodeDialog] = useState<{ nodeId?: string; name: string } | null>(null);
  const [nodeDialogError, setNodeDialogError] = useState("");
  const [busy, setBusy] = useState(false);
  const deviceById = useMemo(() => new Map(devices.map((device) => [device.id, device])), [devices]);

  const layout = useMemo(() => layoutLab(
    lab.nodes.map((node) => ({ id: node.id, label: node.name, sub: nodeShortSubtitle(node, deviceById.get(node.id)) })),
    lab.links.map((link) => ({ from: link.a.nodeId, to: link.b.nodeId })),
  ), [lab, deviceById]);
  const focusNode = lab.nodes.find((node) => node.id === focusId) || lab.nodes.find((node) => node.id === layout.hub) || lab.nodes[0];

  useEffect(() => {
    setSelected(null);
    setEditing(null);
    setRulesDraft(null);
  }, [product.id]);

  const commit = async (next: LabContent) => {
    const saved = await api.updatePhysicalLab(product.id, { ...next, baseUpdatedAt: lab.updatedAt });
    onLabChange(saved);
    return saved;
  };

  const run = async (next: LabContent, success?: string) => {
    try {
      setBusy(true);
      await commit(next);
      if (success) onNotice({ kind: "success", message: success });
      return true;
    } catch (error) {
      onNotice({ kind: "error", message: error instanceof Error ? error.message : "保存失败" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openEditor = (end: LabLinkEnd) => {
    setSelected(end);
    setEditing(end);
  };

  const focus = (nodeId: string) => {
    setFocusId(nodeId);
    setView("panel");
  };

  const portCount = lab.nodes.reduce((sum, node) => sum + node.ports.length, 0);

  const saveNodeDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!nodeDialog) return;
    const name = nodeDialog.name.trim();
    if (!name) {
      setNodeDialogError("名称不能为空");
      return;
    }
    const next = content(lab);
    if (nodeDialog.nodeId) {
      next.nodes = next.nodes.map((node) => node.id === nodeDialog.nodeId ? { ...node, name } : node);
    } else {
      const id = newId();
      next.nodes.push({ id, kind: "external", name, ports: [], controlPorts: {} });
      setFocusId(id);
    }
    try {
      setBusy(true);
      setNodeDialogError("");
      await commit(next);
      setNodeDialog(null);
    } catch (error) {
      setNodeDialogError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const removeExternal = async (node: LabNode) => {
    const linkCount = lab.links.filter((link) => touches(link, node.id)).length;
    if (!window.confirm(`确定删除“${node.name}”吗？${linkCount ? `它的 ${linkCount} 条接线会一起删除。` : ""}`)) return;
    const next = content(lab);
    next.nodes = next.nodes.filter((item) => item.id !== node.id);
    next.links = next.links.filter((link) => !touches(link, node.id));
    if (await run(next, "节点已删除")) setFocusId("");
  };

  return (
    <div className="lab-view">
      <section className="lab-card">
        <header className="lab-card-head">
          <div><h2>环境规则</h2><span>所有场景的搭建、用例、清理和诊断都会带上</span></div>
          {rulesDraft === null && (
            <button type="button" className="button secondary compact" onClick={() => setRulesDraft(lab.rules)}>
              <Pencil size={15} />编辑
            </button>
          )}
        </header>
        <div className="lab-card-body">
          {rulesDraft !== null ? (
            <form
              className="lab-rules-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (await run({ ...content(lab), rules: rulesDraft }, "环境规则已保存")) setRulesDraft(null);
              }}
            >
              <AutoResizeTextarea
                autoFocus
                rows={4}
                value={rulesDraft}
                placeholder={"例如：\n控制面使用 VLAN 176（192.168.176.0/24），场景不得修改\n业务 VLAN 使用 177–191"}
                onChange={(event) => setRulesDraft(event.target.value)}
              />
              <div className="lab-form-actions">
                <button type="button" className="button secondary compact" disabled={busy} onClick={() => setRulesDraft(null)}>取消</button>
                <button type="submit" className="button primary compact" disabled={busy}>保存</button>
              </div>
            </form>
          ) : lab.rules ? (
            <p className="lab-rules-text">{lab.rules}</p>
          ) : (
            <p className="lab-hint">未填写。可以写控制网段、VLAN 和地址规划、哪些配置不能改等全局约定。</p>
          )}
        </div>
      </section>

      <div className="lab-main">
        <section className="lab-card">
          <header className="lab-card-head">
            <div><h2>接线登记</h2><span>{lab.nodes.length} 个节点 · {portCount} 个端口 · {lab.links.length} 条连线</span></div>
            <div className="lab-segmented" role="tablist" aria-label="登记方式">
              <button type="button" role="tab" aria-selected={view === "panel"} className={view === "panel" ? "active" : ""} onClick={() => setView("panel")}>端口面板</button>
              <button type="button" role="tab" aria-selected={view === "device"} className={view === "device" ? "active" : ""} onClick={() => setView("device")}>按设备</button>
            </div>
          </header>
          <div className="lab-card-body">
            {view === "panel" && focusNode ? (
              <PortPanel
                lab={lab}
                node={focusNode}
                device={deviceById.get(focusNode.id)}
                selected={selected}
                busy={busy}
                onFocus={focus}
                onOpen={openEditor}
                onAddExternal={() => { setNodeDialogError(""); setNodeDialog({ name: "" }); }}
                onRename={(node) => { setNodeDialogError(""); setNodeDialog({ nodeId: node.id, name: node.name }); }}
                onRemove={(node) => void removeExternal(node)}
                onChange={run}
              />
            ) : (
              <DeviceCards lab={lab} deviceById={deviceById} selected={selected} onFocus={focus} onOpen={openEditor} />
            )}
          </div>
        </section>

        <section className="lab-card">
          <header className="lab-card-head">
            <div><h2>拓扑图</h2><span>按接线自动布局；点节点查看端口，点连线编辑</span></div>
          </header>
          <div className="lab-card-body">
            <Topology
              lab={lab}
              layout={layout}
              deviceById={deviceById}
              focusId={view === "panel" ? focusNode?.id : undefined}
              selected={selected}
              onFocus={focus}
              onOpen={openEditor}
            />
            <div className="lab-legend">
              <span><i />业务</span>
              <span><i className="dash" />控制（场景不可修改）</span>
              <span><i className="dot" />供电</span>
            </div>
          </div>
        </section>
      </div>

      {editing && (
        <LinkEditor
          key={`${editing.nodeId}:${editing.portId}`}
          lab={lab}
          end={editing}
          deviceById={deviceById}
          onClose={() => setEditing(null)}
          onCommit={commit}
          onRemoved={() => setSelected(null)}
        />
      )}

      {nodeDialog && (
        <Modal
          title={nodeDialog.nodeId ? "重命名节点" : "添加外部节点"}
          className="lab-node-modal"
          onClose={() => setNodeDialog(null)}
          onSubmit={saveNodeDialog}
          submitting={busy}
        >
          {nodeDialogError && <div className="form-error">{nodeDialogError}</div>}
          <label className="field">
            <span>名称</span>
            <input autoFocus value={nodeDialog.name} maxLength={60} placeholder="例如 办公网" onChange={(event) => setNodeDialog({ ...nodeDialog, name: event.target.value })} />
          </label>
          {!nodeDialog.nodeId && <p className="lab-hint">外部节点是接入实验室、但不由平台控制的网络或设备，例如办公网、上级路由。平台不会为它提供控制工具。</p>}
        </Modal>
      )}
    </div>
  );
}

function PortPanel({
  lab,
  node,
  device,
  selected,
  busy,
  onFocus,
  onOpen,
  onAddExternal,
  onRename,
  onRemove,
  onChange,
}: {
  lab: PhysicalLab;
  node: LabNode;
  device?: DeviceResource;
  selected: LabLinkEnd | null;
  busy: boolean;
  onFocus: (nodeId: string) => void;
  onOpen: (end: LabLinkEnd) => void;
  onAddExternal: () => void;
  onRename: (node: LabNode) => void;
  onRemove: (node: LabNode) => void;
  onChange: (next: LabContent, success?: string) => Promise<boolean>;
}) {
  const [names, setNames] = useState("");
  const [kind, setKind] = useState<LabPortKind>("ethernet");
  const [addError, setAddError] = useState("");
  const selectedLink = selected ? findLinkAt(lab, selected) : undefined;
  const highlighted = (end: LabLinkEnd) => Boolean(selected && (sameEnd(selected, end) || (selectedLink && (sameEnd(selectedLink.a, end) || sameEnd(selectedLink.b, end)))));
  const ethernet = node.ports.filter((port) => port.kind === "ethernet");
  const others = node.ports.filter((port) => port.kind !== "ethernet");

  useEffect(() => {
    setNames("");
    setKind("ethernet");
    setAddError("");
  }, [node.id]);

  const addPorts = async (event: FormEvent) => {
    event.preventDefault();
    const expanded = expandPortNames(names);
    if (!expanded.length) {
      setAddError("请输入端口名");
      return;
    }
    const existing = new Set(node.ports.map((port) => port.name.toLowerCase()));
    const fresh = expanded.filter((name) => !existing.has(name.toLowerCase()));
    if (!fresh.length) {
      setAddError("这些端口都已存在");
      return;
    }
    if (fresh.some((name) => name.length > 60)) {
      setAddError("端口名不能超过 60 个字符");
      return;
    }
    const next = content(lab);
    next.nodes = next.nodes.map((item) => item.id === node.id
      ? { ...item, ports: [...item.ports, ...fresh.map((name) => ({ id: newId(), name, kind, note: "" }))] }
      : item);
    setAddError("");
    const skipped = expanded.length - fresh.length;
    if (await onChange(next, `已添加 ${fresh.length} 个端口${skipped ? `，跳过 ${skipped} 个已存在的端口` : ""}`)) setNames("");
  };

  const setControlPort = (controlId: string, portId: string) => {
    const next = content(lab);
    next.nodes = next.nodes.map((item) => {
      if (item.id !== node.id) return item;
      const controlPorts = { ...item.controlPorts };
      if (portId) controlPorts[controlId] = portId;
      else delete controlPorts[controlId];
      return { ...item, controlPorts };
    });
    void onChange(next);
  };

  const portButton = (port: LabNode["ports"][number]) => {
    const end = { nodeId: node.id, portId: port.id };
    const link = findLinkAt(lab, end);
    const peer = link ? findPort(lab, otherEnd(link, end)) : undefined;
    const className = ["lab-port", link ? "" : "empty", link?.role === "control" ? "locked" : "", highlighted(end) ? "hl" : ""].filter(Boolean).join(" ");
    return (
      <button type="button" key={port.id} className={className} title={link?.note || undefined} onClick={() => onOpen(end)}>
        <span className="lab-port-head">
          <em>{port.name}</em>
          <span>{link?.role === "control" ? <Lock size={11} aria-label="控制" /> : port.kind === "ethernet" ? "" : LAB_PORT_KIND_LABELS[port.kind]}</span>
        </span>
        <span className="lab-port-peer">{peer ? peer.node.name : "未接线"}</span>
        <span className="lab-port-peer-port">{peer?.port.name || ""}</span>
      </button>
    );
  };

  return (
    <>
      <div className="lab-chips">
        {lab.nodes.map((item) => (
          <button type="button" key={item.id} className={`lab-chip ${item.id === node.id ? "active" : ""} ${item.kind}`} onClick={() => onFocus(item.id)}>
            {item.name}<span>{item.ports.length} 口</span>
          </button>
        ))}
        <button type="button" className="lab-chip add" onClick={onAddExternal}><Plus size={13} />外部节点</button>
      </div>

      <div className="lab-node-title">
        <div>
          <strong>{node.name}</strong>
          <span>{nodeSubtitle(node, device)}</span>
        </div>
        {node.kind !== "device" && (
          <div className="row-actions">
            <button type="button" className="icon-action" title="重命名" onClick={() => onRename(node)}><Pencil size={15} /></button>
            {node.kind === "external" && <button type="button" className="icon-action danger" title="删除节点" disabled={busy} onClick={() => onRemove(node)}><Trash2 size={15} /></button>}
          </div>
        )}
      </div>

      {!node.ports.length && (
        <p className="lab-hint lab-empty-ports">
          还没有登记端口。{node.kind === "platform" ? "平台服务器用来连接设备的网口和串口（如 ttyUSB0）也要登记，才能画出控制路径。" : "可以一次添加多个，例如 1-16、fe1-2、ge1-2、console。"}
        </p>
      )}
      {ethernet.length > 0 && <><div className="lab-group-title">以太网口</div><div className="lab-panel">{ethernet.map(portButton)}</div></>}
      {others.length > 0 && <><div className="lab-group-title">其他端口</div><div className="lab-panel">{others.map(portButton)}</div></>}

      <form className="lab-add-port" onSubmit={addPorts}>
        <input
          value={names}
          aria-label="端口名"
          placeholder="端口名，如 1-16、fe1-2、console"
          onChange={(event) => setNames(event.target.value)}
        />
        <select value={kind} aria-label="端口类型" onChange={(event) => setKind(event.target.value as LabPortKind)}>
          {LAB_PORT_KINDS.map((item) => <option key={item} value={item}>{LAB_PORT_KIND_LABELS[item]}</option>)}
        </select>
        <button type="submit" className="button secondary compact" disabled={busy}><Plus size={15} />添加端口</button>
        {addError && <span className="lab-error">{addError}</span>}
      </form>

      {node.kind === "device" && (
        <>
          <div className="lab-group-title">控制接口</div>
          {device?.controlInterfaces.length ? (
            <ul className="lab-control-list">
              {device.controlInterfaces.map((control) => {
                const path = resolveControlPath(lab, node.id, control);
                const port = node.ports.find((item) => item.id === path.portId);
                const manual = node.controlPorts[control.id] || "";
                return (
                  <li key={control.id}>
                    <div className="lab-control-what">
                      <strong>{CONTROL_KINDS[control.kind].label}</strong>
                      {control.name && <span>{control.name}</span>}
                      <code>{controlSummary(control)}</code>
                    </div>
                    {path.band && <span className={`lab-tag ${path.band === "out-of-band" ? "strong" : ""}`}>{path.band === "out-of-band" ? "带外" : "带内"}</span>}
                    <div className="lab-control-path">
                      <label>
                        <span>所经端口</span>
                        <select value={manual} disabled={busy || !node.ports.length} onChange={(event) => setControlPort(control.id, event.target.value)}>
                          <option value="">{path.source === "serial" && port ? `自动识别：${port.name}` : "未指定"}</option>
                          {node.ports.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                      </label>
                      <span className="lab-control-route">
                        {port && path.peer ? `${port.name} ── ${endLabel(lab, path.peer)}` : port ? `${port.name}（未接线）` : control.kind === "serial" ? "在平台服务器上登记与串口设备同名的串口并接线后会自动识别" : "未指定"}
                        {path.addressMatches === true && <em className="ok">✓ 地址与连线一致</em>}
                        {path.addressMatches === false && <em className="bad">地址与连线不一致</em>}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="lab-hint">这台设备没有控制接口，可以在“设备资源”中添加。</p>
          )}
        </>
      )}
    </>
  );
}

function DeviceCards({
  lab,
  deviceById,
  selected,
  onFocus,
  onOpen,
}: {
  lab: PhysicalLab;
  deviceById: Map<string, DeviceResource>;
  selected: LabLinkEnd | null;
  onFocus: (nodeId: string) => void;
  onOpen: (end: LabLinkEnd) => void;
}) {
  const selectedLink = selected ? findLinkAt(lab, selected) : undefined;
  return (
    <div className="lab-device-grid">
      {lab.nodes.map((node) => {
        const device = deviceById.get(node.id);
        return (
          <section key={node.id} className="lab-device-card">
            <header>
              <button type="button" onClick={() => onFocus(node.id)}>{node.name}</button>
              <span>{nodeShortSubtitle(node, device)}</span>
            </header>
            {node.ports.length ? (
              <ul className="lab-device-ports">
                {node.ports.map((port) => {
                  const end = { nodeId: node.id, portId: port.id };
                  const link = findLinkAt(lab, end);
                  const peer = link ? otherEnd(link, end) : undefined;
                  const hl = Boolean(selected && (sameEnd(selected, end) || (selectedLink && (sameEnd(selectedLink.a, end) || sameEnd(selectedLink.b, end)))));
                  return (
                    <li key={port.id}>
                      <button type="button" className={hl ? "hl" : ""} onClick={() => onOpen(end)}>
                        <span className="lab-port-name">{port.name}</span>
                        <span className={peer ? "lab-port-to" : "lab-port-to none"}>{peer ? `→ ${endLabel(lab, peer)}` : "未接线"}</span>
                        {link ? <span className="lab-tag">{LAB_LINK_ROLE_LABELS[link.role]}</span> : port.kind !== "ethernet" ? <span className="lab-tag">{LAB_PORT_KIND_LABELS[port.kind]}</span> : <span />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="lab-hint lab-device-empty">未登记端口</p>
            )}
            {Boolean(device?.controlInterfaces.length) && (
              <ul className="lab-device-controls">
                {device!.controlInterfaces.map((control) => {
                  const path = resolveControlPath(lab, node.id, control);
                  return (
                    <li key={control.id}>
                      <span>{CONTROL_KINDS[control.kind].label} {controlSummary(control)}</span>
                      {path.band ? <span className={`lab-tag ${path.band === "out-of-band" ? "strong" : ""}`}>{path.band === "out-of-band" ? "带外" : "带内"}</span> : <span className="lab-muted">未指定端口</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Topology({
  lab,
  layout,
  deviceById,
  focusId,
  selected,
  onFocus,
  onOpen,
}: {
  lab: PhysicalLab;
  layout: ReturnType<typeof layoutLab>;
  deviceById: Map<string, DeviceResource>;
  focusId?: string;
  selected: LabLinkEnd | null;
  onFocus: (nodeId: string) => void;
  onOpen: (end: LabLinkEnd) => void;
}) {
  const { positions, viewBox, hub } = layout;
  const selectedLink = selected ? findLinkAt(lab, selected) : undefined;

  // Parallel cables between the same two nodes with the same role become one line labelled with every port.
  const bundles = new Map<string, { from: string; to: string; role: LabLinkRole; links: LabLink[]; index: number }>();
  lab.links.forEach((link) => {
    if (link.a.nodeId === link.b.nodeId) return;
    const [from, to] = [link.a.nodeId, link.b.nodeId].sort();
    const key = `${from}\u0000${to}\u0000${link.role}`;
    if (!bundles.has(key)) bundles.set(key, { from, to, role: link.role, links: [], index: 0 });
    bundles.get(key)!.links.push(link);
  });
  const pairCount = new Map<string, number>();
  bundles.forEach((bundle) => {
    const key = `${bundle.from}\u0000${bundle.to}`;
    bundle.index = pairCount.get(key) || 0;
    pairCount.set(key, bundle.index + 1);
  });

  const portName = (end: LabLinkEnd) => findPort(lab, end)?.port.name || "?";
  const edges = [...bundles.values()].flatMap((bundle) => {
    const from = positions[bundle.from];
    const to = positions[bundle.to];
    if (!from || !to) return [];
    const count = pairCount.get(`${bundle.from}\u0000${bundle.to}`) || 1;
    const offset = (bundle.index - (count - 1) / 2) * 14;
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const shiftX = (-(to.y - from.y) / length) * offset;
    const shiftY = ((to.x - from.x) / length) * offset;
    const shifted = (node: PlacedNode) => ({ ...node, x: node.x + shiftX, y: node.y + shiftY });
    const start = borderPoint(shifted(from), to.x + shiftX, to.y + shiftY);
    const end = borderPoint(shifted(to), from.x + shiftX, from.y + shiftY);
    const span = Math.hypot(end.x - start.x, end.y - start.y) || 1;
    const unitX = (end.x - start.x) / span;
    const unitY = (end.y - start.y) / span;
    const along = Math.max(20, Math.min(52, span * 0.26));
    const side = offset < 0 ? -1 : 1;
    const portsAt = (nodeId: string) => bundle.links.map((link) => portName(link.a.nodeId === nodeId ? link.a : link.b)).join(" ");
    // Port labels sit beside the line near their own box; slide a label further along until it clears the box.
    const labelAt = (point: { x: number; y: number }, sign: number, text: string, box: PlacedNode, labelSide = side) => {
      const width = labelWidth(text);
      let distance = along;
      let x = 0;
      let y = 0;
      for (let step = 0; step < 40; step += 1) {
        x = point.x + unitX * sign * distance - unitY * 9 * labelSide;
        y = point.y + unitY * sign * distance + unitX * 9 * labelSide;
        const clear = Math.abs(x - box.x) >= (box.w + width) / 2 + 3 || Math.abs(y - box.y) >= (box.h + 12) / 2 + 2;
        if (clear || distance >= span / 2 - 6) break;
        distance += 4;
      }
      return { x, y: y + 4, text };
    };
    const hl = Boolean(selectedLink && bundle.links.includes(selectedLink));
    const first = bundle.links[0];
    const target = first.a.nodeId === bundle.from ? first.a : first.b;
    const fromLabel = labelAt(start, 1, portsAt(bundle.from), from);
    let toLabel = labelAt(end, -1, portsAt(bundle.to), to);
    // On a short line both labels can meet in the middle; put the second one on the other side.
    const collide = Math.abs(fromLabel.x - toLabel.x) < (labelWidth(fromLabel.text) + labelWidth(toLabel.text)) / 2 + 4 && Math.abs(fromLabel.y - toLabel.y) < 14;
    if (collide) toLabel = labelAt(end, -1, toLabel.text, to, -side);
    return [{ key: `${bundle.from}-${bundle.to}-${bundle.role}`, bundle, start, end, hl, target, fromLabel, toLabel }];
  });

  const highlightedNodes = new Set<string>();
  if (selected) highlightedNodes.add(selected.nodeId);
  if (selectedLink) {
    highlightedNodes.add(selectedLink.a.nodeId);
    highlightedNodes.add(selectedLink.b.nodeId);
  }
  if (focusId) highlightedNodes.add(focusId);

  if (!lab.nodes.length) return <p className="lab-hint">当前产品还没有设备。</p>;
  return (
    <>
      {!lab.links.length && <p className="lab-hint lab-topology-empty">还没有登记接线。先给设备添加端口，再点端口登记它连到哪里。</p>}
      <div className="lab-topology-scroll">
        <svg
          className="lab-topology"
          role="img"
          aria-label="物理拓扑图"
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          style={{ maxWidth: viewBox.width }}
        >
          {edges.map((edge) => (
            <g key={edge.key} className={`lab-edge ${edge.bundle.role} ${edge.hl ? "hl" : ""}`} onClick={() => onOpen(edge.target)}>
              <title>{edge.bundle.links.map((link) => `${endLabel(lab, link.a)} ↔ ${endLabel(lab, link.b)}${link.note ? `（${link.note}）` : ""}`).join("\n")}</title>
              <line className="hit" x1={edge.start.x} y1={edge.start.y} x2={edge.end.x} y2={edge.end.y} />
              <line className="vis" x1={edge.start.x} y1={edge.start.y} x2={edge.end.x} y2={edge.end.y} />
            </g>
          ))}
          {lab.nodes.map((node) => {
            const position = positions[node.id];
            if (!position) return null;
            const className = ["lab-node", node.kind, node.id === hub && lab.links.length ? "hub" : "", highlightedNodes.has(node.id) ? "hl" : ""].filter(Boolean).join(" ");
            return (
              <g key={node.id} className={className} onClick={() => onFocus(node.id)}>
                <rect x={position.x - position.w / 2} y={position.y - position.h / 2} width={position.w} height={position.h} rx={8} />
                <text className="name" x={position.x} y={position.y - 3} textAnchor="middle">{node.name}</text>
                <text className="sub" x={position.x} y={position.y + 13} textAnchor="middle">{nodeShortSubtitle(node, deviceById.get(node.id))}</text>
              </g>
            );
          })}
          {edges.map((edge) => (
            <g key={`${edge.key}-labels`} className={`lab-edge-labels ${edge.hl ? "hl" : ""}`} onClick={() => onOpen(edge.target)}>
              <text x={edge.fromLabel.x} y={edge.fromLabel.y} textAnchor="middle">{edge.fromLabel.text}</text>
              <text x={edge.toLabel.x} y={edge.toLabel.y} textAnchor="middle">{edge.toLabel.text}</text>
            </g>
          ))}
        </svg>
      </div>
    </>
  );
}

function LinkEditor({
  lab,
  end,
  deviceById,
  onClose,
  onCommit,
  onRemoved,
}: {
  lab: PhysicalLab;
  end: LabLinkEnd;
  deviceById: Map<string, DeviceResource>;
  onClose: () => void;
  onCommit: (next: LabContent) => Promise<PhysicalLab>;
  onRemoved: () => void;
}) {
  const found = findPort(lab, end);
  const link = findLinkAt(lab, end);
  const peer = link ? otherEnd(link, end) : undefined;
  const [name, setName] = useState(found?.port.name || "");
  const [kind, setKind] = useState<LabPortKind>(found?.port.kind || "ethernet");
  const [peerNodeId, setPeerNodeId] = useState(peer?.nodeId || "");
  const [peerPortId, setPeerPortId] = useState(peer?.portId || "");
  const [role, setRole] = useState<LabLinkRole>(link?.role || defaultLinkRole(found?.port.kind || "ethernet"));
  const [note, setNote] = useState(link?.note || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  if (!found) return null;
  const { node } = found;
  const fits = (candidate: LabNode) => candidate.ports.some((port) => !(candidate.id === end.nodeId && port.id === end.portId) && portKindsCompatible(kind, port.kind));
  const peerNode = lab.nodes.find((item) => item.id === peerNodeId);
  const peerPorts = peerNode ? peerNode.ports.filter((port) => !(peerNode.id === end.nodeId && port.id === end.portId) && portKindsCompatible(kind, port.kind)) : [];

  const apply = async (next: LabContent) => {
    try {
      setSaving(true);
      setError("");
      await onCommit(next);
      onClose();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("端口名不能为空");
    if (node.ports.some((port) => port.id !== end.portId && port.name.toLowerCase() === trimmed.toLowerCase())) return setError(`“${node.name}”已有端口“${trimmed}”`);
    if (peerNodeId && !peerPortId) return setError("请选择对端端口");
    if (peerPortId && !peerPorts.some((port) => port.id === peerPortId)) return setError("对端端口与端口类型不匹配");
    const next = content(lab);
    next.nodes = next.nodes.map((item) => item.id !== node.id ? item : {
      ...item,
      ports: item.ports.map((port) => port.id === end.portId ? { ...port, name: trimmed, kind } : port),
    });
    next.links = next.links.filter((item) => !touches(item, end.nodeId, end.portId));
    if (peerNodeId && peerPortId) next.links.push({ id: link?.id || newId(), a: end, b: { nodeId: peerNodeId, portId: peerPortId }, role, note: note.trim() });
    await apply(next);
  };

  const disconnect = async () => {
    const next = content(lab);
    next.links = next.links.filter((item) => !touches(item, end.nodeId, end.portId));
    if (await apply(next)) onRemoved();
  };

  const removePort = async () => {
    if (!window.confirm(`确定删除端口“${endLabel(lab, end)}”吗？${link ? "这个端口上的接线会一起删除。" : ""}`)) return;
    const next = content(lab);
    next.nodes = next.nodes.map((item) => {
      if (item.id !== node.id) return item;
      const controlPorts = Object.fromEntries(Object.entries(item.controlPorts).filter(([, portId]) => portId !== end.portId));
      return { ...item, ports: item.ports.filter((port) => port.id !== end.portId), controlPorts };
    });
    next.links = next.links.filter((item) => !touches(item, end.nodeId, end.portId));
    if (await apply(next)) onRemoved();
  };

  const busyLabel = (candidate: LabNode, portId: string) => {
    const existing = findLinkAt(lab, { nodeId: candidate.id, portId });
    if (!existing || existing === link) return "";
    return endLabel(lab, otherEnd(existing, { nodeId: candidate.id, portId }));
  };

  return (
    <div className="lab-drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <form className="lab-drawer" role="dialog" aria-modal="true" aria-label={`编辑端口 ${endLabel(lab, end)}`} onSubmit={save}>
        <header>
          <div>
            <span className="lab-eyebrow">{nodeSubtitle(node, deviceById.get(node.id)) || node.name}</span>
            <h3>{endLabel(lab, end)}</h3>
          </div>
          <button type="button" className="icon-button static" title="关闭" disabled={saving} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="lab-drawer-body">
          <div className="lab-drawer-row">
            <label className="field">
              <span>端口名</span>
              <input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field">
              <span>端口类型</span>
              <select
                value={kind}
                onChange={(event) => {
                  const nextKind = event.target.value as LabPortKind;
                  setKind(nextKind);
                  if (!link) setRole(defaultLinkRole(nextKind));
                  const stillFits = peerNode?.ports.some((port) => port.id === peerPortId && portKindsCompatible(nextKind, port.kind));
                  if (!stillFits) setPeerPortId("");
                }}
              >
                {LAB_PORT_KINDS.map((item) => <option key={item} value={item}>{LAB_PORT_KIND_LABELS[item]}</option>)}
              </select>
            </label>
          </div>

          <label className="field">
            <span>对端节点</span>
            <select value={peerNodeId} onChange={(event) => { setPeerNodeId(event.target.value); setPeerPortId(""); }}>
              <option value="">— 未接线 —</option>
              {lab.nodes.map((candidate) => {
                const ok = fits(candidate);
                return <option key={candidate.id} value={candidate.id} disabled={!ok}>{candidate.name}{candidate.id === node.id ? "（本节点）" : ""}{ok ? "" : `（没有可接的${LAB_PORT_KIND_LABELS[kind]}口）`}</option>;
              })}
            </select>
          </label>
          <label className="field">
            <span>对端端口</span>
            <select value={peerPortId} disabled={!peerNode} onChange={(event) => setPeerPortId(event.target.value)}>
              <option value="">{peerNode ? "选择端口" : "—"}</option>
              {peerNode && peerPorts.map((port) => {
                const busyWith = busyLabel(peerNode, port.id);
                return <option key={port.id} value={port.id} disabled={Boolean(busyWith)}>{/^\d+$/.test(port.name) ? `${port.name} 口` : port.name}{busyWith ? `（已接 ${busyWith}）` : ""}</option>;
              })}
            </select>
            <small className="lab-hint">一个端口只能接一根线，已接线的端口不可选</small>
          </label>
          <div className="field">
            <span>线缆</span>
            <p className="lab-readonly">{LAB_CABLE_LABELS[kind]}（按端口类型确定）</p>
          </div>
          <fieldset className="lab-role-options" disabled={!peerNodeId}>
            <legend>用途</legend>
            {(Object.keys(LAB_LINK_ROLE_LABELS) as LabLinkRole[]).map((item) => (
              <label key={item} className={role === item ? "checked" : ""}>
                <input type="radio" name="lab-link-role" value={item} checked={role === item} onChange={() => setRole(item)} />
                <span>{LAB_LINK_ROLE_LABELS[item]}<small>{ROLE_HINTS[item]}</small></span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>备注</span>
            <input value={note} maxLength={300} disabled={!peerNodeId} placeholder="例如：trunk 放行 176、181、182" onChange={(event) => setNote(event.target.value)} />
          </label>
          {error && <div className="form-error">{error}</div>}
        </div>
        <footer>
          <button type="button" className="button secondary compact lab-quiet-danger" disabled={saving} onClick={() => void removePort()}>
            <Trash2 size={14} />删除端口
          </button>
          {link && <button type="button" className="button secondary compact" disabled={saving} onClick={() => void disconnect()}>断开</button>}
          <span className="lab-spacer" />
          <button type="button" className="button secondary compact" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="button primary compact" disabled={saving}>{saving ? "保存中..." : "保存"}</button>
        </footer>
      </form>
    </div>
  );
}
