import { useEffect, useState, type FormEvent } from "react";
import {
  Cable,
  Layers3,
  Network,
  Pencil,
  Plus,
  Server,
  Trash2,
  Workflow,
} from "lucide-react";
import {
  api,
  type ControlInterfaceInput,
  type ControlInterfaceType,
  type DeviceResource,
  type DeviceResourceInput,
  type PhysicalConnection,
  type PhysicalEnvironment,
  type PhysicalEnvironmentInput,
  type ProductSummary,
  type ScenarioParameter,
  type ScenarioRole,
  type TestScenario,
  type TestScenarioInput,
} from "../api";
import { InlineNotice, Modal, PageHeader, type Notice } from "../components/ui";

type ResourceTab = "devices" | "physicalEnvironments" | "scenarios";

type ResourceDialog =
  | { kind: "device"; id?: string; form: DeviceResourceInput }
  | { kind: "physicalEnvironment"; id?: string; form: PhysicalEnvironmentInput }
  | { kind: "scenario"; id?: string; form: TestScenarioInput };

const INTERFACE_LABELS: Record<ControlInterfaceType, string> = {
  web: "Web",
  ssh: "SSH",
  telnet: "Telnet",
  serial: "串口",
  api: "API",
  other: "其他",
};

const INTERFACE_ADDRESS_PLACEHOLDERS: Record<ControlInterfaceType, string> = {
  web: "例如 http://192.168.1.1",
  ssh: "例如 192.168.1.1:22",
  telnet: "例如 192.168.1.1:23",
  serial: "例如 /dev/ttyUSB0?baudRate=115200",
  api: "例如 http://192.168.1.1/api/",
  other: "接口地址",
};

const TAB_META: Record<ResourceTab, { label: string; action: string }> = {
  devices: { label: "设备资源", action: "新增设备" },
  physicalEnvironments: { label: "物理环境", action: "新增物理环境" },
  scenarios: { label: "测试场景", action: "新增场景" },
};

function newId(): string {
  const runtimeCrypto = globalThis.crypto;
  if (typeof runtimeCrypto?.randomUUID === "function") return runtimeCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof runtimeCrypto?.getRandomValues === "function") {
    runtimeCrypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function emptyDevice(): DeviceResourceInput {
  return {
    name: "",
    type: "",
    model: "",
    description: "",
    controlInterfaces: [],
  };
}

function emptyPhysicalEnvironment(): PhysicalEnvironmentInput {
  return { name: "", description: "", deviceIds: [], connections: [] };
}

function emptyScenario(): TestScenarioInput {
  return {
    name: "",
    category: "",
    description: "",
    roles: [{ id: newId(), key: "", name: "", deviceType: "" }],
    parameters: [],
    setupInstructions: "",
    verificationInstructions: "",
    cleanupInstructions: "",
  };
}

function scenarioInput(scenario: TestScenario): TestScenarioInput {
  return {
    name: scenario.name,
    category: scenario.category,
    description: scenario.description,
    roles: structuredClone(scenario.roles),
    parameters: structuredClone(scenario.parameters),
    setupInstructions: scenario.setupInstructions,
    verificationInstructions: scenario.verificationInstructions,
    cleanupInstructions: scenario.cleanupInstructions,
  };
}

export function ResourcesPage({ product }: { product: ProductSummary }) {
  const [tab, setTab] = useState<ResourceTab>("devices");
  const [devices, setDevices] = useState<DeviceResource[]>([]);
  const [physicalEnvironments, setPhysicalEnvironments] = useState<PhysicalEnvironment[]>([]);
  const [scenarios, setScenarios] = useState<TestScenario[]>([]);
  const [dialog, setDialog] = useState<ResourceDialog | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [submitting, setSubmitting] = useState(false);

  const reload = async () => {
    const [nextDevices, nextPhysicalEnvironments, nextScenarios] = await Promise.all([
      api.getDeviceResources(product.id),
      api.getPhysicalEnvironments(product.id),
      api.getTestScenarios(product.id),
    ]);
    setDevices(nextDevices);
    setPhysicalEnvironments(nextPhysicalEnvironments);
    setScenarios(nextScenarios);
  };

  useEffect(() => {
    setDialog(null);
    setNotice(null);
    void reload().catch((error) =>
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "读取资源数据失败" }),
    );
  }, [product.id]);

  const openCreate = () => {
    setDialogError("");
    if (tab === "devices") setDialog({ kind: "device", form: emptyDevice() });
    else if (tab === "physicalEnvironments") {
      setDialog({ kind: "physicalEnvironment", form: emptyPhysicalEnvironment() });
    }
    else setDialog({ kind: "scenario", form: emptyScenario() });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog) return;
    try {
      setSubmitting(true);
      setDialogError("");
      if (dialog.kind === "device") {
        if (dialog.id) await api.updateDeviceResource(product.id, dialog.id, dialog.form);
        else await api.createDeviceResource(product.id, dialog.form);
      } else if (dialog.kind === "physicalEnvironment") {
        if (dialog.id) await api.updatePhysicalEnvironment(product.id, dialog.id, dialog.form);
        else await api.createPhysicalEnvironment(product.id, dialog.form);
      } else if (dialog.id) await api.updateTestScenario(product.id, dialog.id, dialog.form);
      else await api.createTestScenario(product.id, dialog.form);
      await reload();
      setDialog(null);
      setNotice({ kind: "success", message: dialog.id ? "配置已更新" : "配置已创建" });
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (kind: ResourceDialog["kind"], id: string, name: string) => {
    if (!window.confirm(`确定删除“${name}”吗？`)) return;
    try {
      if (kind === "device") await api.deleteDeviceResource(product.id, id);
      else if (kind === "physicalEnvironment") await api.deletePhysicalEnvironment(product.id, id);
      else await api.deleteTestScenario(product.id, id);
      await reload();
      setNotice({ kind: "success", message: "配置已删除" });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "删除失败" });
    }
  };

  const deviceName = (id: string) => devices.find((item) => item.id === id)?.name || "未知设备";

  return (
    <div className="page resource-config-page">
      <PageHeader
        icon={<Network size={19} />}
        title="资源与环境"
        actions={
          <button className="button primary" onClick={openCreate}>
            <Plus size={17} />
            {TAB_META[tab].action}
          </button>
        }
      />

      {notice && <InlineNotice notice={notice} onClose={() => setNotice(null)} />}

      <div className="resource-tabs" role="tablist" aria-label="资源类型">
        <button className={tab === "devices" ? "active" : ""} onClick={() => setTab("devices")}>
          <Server size={16} />设备资源<span>{devices.length}</span>
        </button>
        <button className={tab === "physicalEnvironments" ? "active" : ""} onClick={() => setTab("physicalEnvironments")}>
          <Cable size={16} />物理环境<span>{physicalEnvironments.length}</span>
        </button>
        <button className={tab === "scenarios" ? "active" : ""} onClick={() => setTab("scenarios")}>
          <Workflow size={16} />测试场景<span>{scenarios.length}</span>
        </button>
      </div>

      <div className="list-surface resource-list-surface">
        {tab === "devices" ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>设备</th><th>类型 / 型号</th><th>控制接口</th><th>设备说明</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td className="name-cell"><strong>{device.name}</strong><small>{device.description || "暂无说明"}</small></td>
                    <td>{device.type}<span className="cell-subtext">{device.model || "未配置型号"}</span></td>
                    <td>{device.controlInterfaces.length}<span className="cell-subtext">{device.controlInterfaces.slice(0, 2).map((item) => `${INTERFACE_LABELS[item.type]} ${item.address}`).join("；") || "未配置"}</span></td>
                    <td className="truncate-cell">{device.description || "-"}</td>
                    <td><div className="row-actions">
                      <button className="icon-action" title="编辑设备" onClick={() => setDialog({ kind: "device", id: device.id, form: { ...device, controlInterfaces: device.controlInterfaces.map((item) => ({ ...item, password: "" })) } })}><Pencil size={16} /></button>
                      <button className="icon-action danger" title="删除设备" onClick={() => void remove("device", device.id, device.name)}><Trash2 size={16} /></button>
                    </div></td>
                  </tr>
                ))}
                {!devices.length && <tr><td colSpan={5} className="table-empty"><Server size={24} />暂无设备资源</td></tr>}
              </tbody>
            </table>
          </div>
        ) : tab === "physicalEnvironments" ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>物理环境名称</th><th>设备</th><th>连接关系</th><th>物理环境说明</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {physicalEnvironments.map((physicalEnvironment) => (
                  <tr key={physicalEnvironment.id}>
                    <td className="name-cell"><strong>{physicalEnvironment.name}</strong></td>
                    <td>{physicalEnvironment.deviceIds.length}<span className="cell-subtext">{physicalEnvironment.deviceIds.slice(0, 3).map(deviceName).join("、")}</span></td>
                    <td>{physicalEnvironment.connections.length}</td>
                    <td className="truncate-cell">{physicalEnvironment.description || "-"}</td>
                    <td><div className="row-actions">
                      <button className="icon-action" title="编辑物理环境" onClick={() => setDialog({ kind: "physicalEnvironment", id: physicalEnvironment.id, form: { ...physicalEnvironment, deviceIds: [...physicalEnvironment.deviceIds], connections: structuredClone(physicalEnvironment.connections) } })}><Pencil size={16} /></button>
                      <button className="icon-action danger" title="删除物理环境" onClick={() => void remove("physicalEnvironment", physicalEnvironment.id, physicalEnvironment.name)}><Trash2 size={16} /></button>
                    </div></td>
                  </tr>
                ))}
                {!physicalEnvironments.length && <tr><td colSpan={5} className="table-empty"><Layers3 size={24} />暂无物理环境</td></tr>}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>场景名称</th><th>功能分类</th><th>设备角色</th><th>参数</th><th>场景说明</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {scenarios.map((scenario) => (
                  <tr key={scenario.id}>
                    <td className="name-cell"><strong>{scenario.name}</strong>{scenario.isDefault && <small>系统默认</small>}</td>
                    <td><span className="category-label">{scenario.category}</span></td>
                    <td>{scenario.roles.length}<span className="cell-subtext">{scenario.roles.map((role) => role.name).join("、")}</span></td>
                    <td>{scenario.parameters.length}</td>
                    <td className="truncate-cell">{scenario.description || "-"}</td>
                    <td><div className="row-actions">
                      {scenario.isDefault ? <span className="category-label">系统维护</span> : <>
                        <button className="icon-action" title="编辑场景" onClick={() => setDialog({ kind: "scenario", id: scenario.id, form: scenarioInput(scenario) })}><Pencil size={16} /></button>
                        <button className="icon-action danger" title="删除场景" onClick={() => void remove("scenario", scenario.id, scenario.name)}><Trash2 size={16} /></button>
                      </>}
                    </div></td>
                  </tr>
                ))}
                {!scenarios.length && <tr><td colSpan={6} className="table-empty"><Workflow size={24} />暂无测试场景</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog && (
        <Modal
          title={`${dialog.id ? "编辑" : "新增"}${dialog.kind === "device" ? "设备资源" : dialog.kind === "physicalEnvironment" ? "物理环境" : "测试场景"}`}
          onClose={() => setDialog(null)}
          onSubmit={save}
          submitting={submitting}
        >
          {dialogError && <div className="form-error">{dialogError}</div>}
          {dialog.kind === "device" ? <DeviceForm dialog={dialog} setDialog={setDialog} /> : dialog.kind === "physicalEnvironment" ? (
            <PhysicalEnvironmentForm dialog={dialog} setDialog={setDialog} devices={devices} />
          ) : <ScenarioForm dialog={dialog} setDialog={setDialog} />}
        </Modal>
      )}
    </div>
  );
}

function DeviceForm({ dialog, setDialog }: { dialog: Extract<ResourceDialog, { kind: "device" }>; setDialog: (value: ResourceDialog) => void }) {
  const update = (value: Partial<DeviceResourceInput>) => setDialog({ ...dialog, form: { ...dialog.form, ...value } });
  const updateControl = (id: string, value: Partial<ControlInterfaceInput>) =>
    update({ controlInterfaces: dialog.form.controlInterfaces.map((item) => item.id === id ? { ...item, ...value } : item) });
  return <>
    <div className="modal-grid">
      <label className="field"><span>设备名称</span><input autoFocus value={dialog.form.name} onChange={(event) => update({ name: event.target.value })} /></label>
      <label className="field"><span>设备类型</span><input value={dialog.form.type} placeholder="例如 TAU、交换机、终端主机" onChange={(event) => update({ type: event.target.value })} /></label>
      <label className="field"><span>设备型号</span><input value={dialog.form.model} onChange={(event) => update({ model: event.target.value })} /></label>
      <label className="field full-width"><span>设备说明</span><textarea rows={2} value={dialog.form.description} onChange={(event) => update({ description: event.target.value })} /></label>
    </div>
    <div className="form-list-heading"><div><Server size={16} /><strong>控制接口</strong></div><button type="button" className="button secondary compact" onClick={() => update({ controlInterfaces: [...dialog.form.controlInterfaces, { id: newId(), name: "", type: "web", address: "", username: "", password: "" }] })}><Plus size={15} />添加接口</button></div>
    <div className="structured-list">
      {dialog.form.controlInterfaces.map((item) => <div className="structured-row control-row" key={item.id}>
        <label><span>类型</span><select value={item.type} onChange={(event) => updateControl(item.id, { type: event.target.value as ControlInterfaceType })}>{Object.entries(INTERFACE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>名称</span><input value={item.name} placeholder="例如 Web 管理" onChange={(event) => updateControl(item.id, { name: event.target.value })} /></label>
        <label className="grow"><span>接口地址</span><input value={item.address} placeholder={INTERFACE_ADDRESS_PLACEHOLDERS[item.type]} onChange={(event) => updateControl(item.id, { address: event.target.value })} /></label>
        <label><span>账号</span><input value={item.username} placeholder="可选" autoComplete="off" onChange={(event) => updateControl(item.id, { username: event.target.value })} /></label>
        <label><span>密码</span><input type="password" value={item.password} placeholder={dialog.id ? "留空保持不变" : "可选"} autoComplete="new-password" onChange={(event) => updateControl(item.id, { password: event.target.value })} /></label>
        <button type="button" className="icon-action danger row-remove" title="删除接口" onClick={() => update({ controlInterfaces: dialog.form.controlInterfaces.filter((control) => control.id !== item.id) })}><Trash2 size={16} /></button>
      </div>)}
      {!dialog.form.controlInterfaces.length && <div className="structured-empty">暂未配置控制接口</div>}
    </div>
  </>;
}

function PhysicalEnvironmentForm({ dialog, setDialog, devices }: { dialog: Extract<ResourceDialog, { kind: "physicalEnvironment" }>; setDialog: (value: ResourceDialog) => void; devices: DeviceResource[] }) {
  const update = (value: Partial<PhysicalEnvironmentInput>) => setDialog({ ...dialog, form: { ...dialog.form, ...value } });
  const toggleDevice = (deviceId: string) => {
    const selected = dialog.form.deviceIds.includes(deviceId);
    const deviceIds = selected ? dialog.form.deviceIds.filter((id) => id !== deviceId) : [...dialog.form.deviceIds, deviceId];
    update({ deviceIds, connections: dialog.form.connections.filter((item) => deviceIds.includes(item.sourceDeviceId) && deviceIds.includes(item.targetDeviceId)) });
  };
  const updateConnection = (id: string, value: Partial<PhysicalConnection>) =>
    update({ connections: dialog.form.connections.map((item) => item.id === id ? { ...item, ...value } : item) });
  const selectedDevices = devices.filter((item) => dialog.form.deviceIds.includes(item.id));
  return <>
    <div className="modal-grid">
      <label className="field"><span>物理环境名称</span><input autoFocus value={dialog.form.name} onChange={(event) => update({ name: event.target.value })} /></label>
      <label className="field full-width"><span>物理环境说明</span><textarea rows={3} value={dialog.form.description} onChange={(event) => update({ description: event.target.value })} /></label>
    </div>
    <div className="form-list-heading"><div><Server size={16} /><strong>环境设备</strong></div><small>已选择 {dialog.form.deviceIds.length} 台</small></div>
    <div className="case-picker resource-picker">
      {devices.map((device) => <label key={device.id} className="case-option"><input type="checkbox" checked={dialog.form.deviceIds.includes(device.id)} onChange={() => toggleDevice(device.id)} /><span><strong>{device.name}</strong><small>{device.type}{device.model ? ` / ${device.model}` : ""}</small></span></label>)}
      {!devices.length && <div className="list-empty">请先创建设备资源</div>}
    </div>
    <div className="form-list-heading"><div><Cable size={16} /><strong>物理连接</strong></div><button type="button" className="button secondary compact" disabled={selectedDevices.length < 2} onClick={() => update({ connections: [...dialog.form.connections, { id: newId(), sourceDeviceId: selectedDevices[0]?.id || "", sourcePort: "", targetDeviceId: selectedDevices[1]?.id || "", targetPort: "", description: "" }] })}><Plus size={15} />添加连接</button></div>
    <div className="structured-list">
      {dialog.form.connections.map((item) => <div className="structured-row connection-row" key={item.id}>
        <label><span>本端设备</span><select value={item.sourceDeviceId} onChange={(event) => updateConnection(item.id, { sourceDeviceId: event.target.value })}>{selectedDevices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
        <label><span>本端端口</span><input value={item.sourcePort} onChange={(event) => updateConnection(item.id, { sourcePort: event.target.value })} /></label>
        <span className="connection-arrow">↔</span>
        <label><span>对端设备</span><select value={item.targetDeviceId} onChange={(event) => updateConnection(item.id, { targetDeviceId: event.target.value })}>{selectedDevices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
        <label><span>对端端口</span><input value={item.targetPort} onChange={(event) => updateConnection(item.id, { targetPort: event.target.value })} /></label>
        <label><span>说明</span><input value={item.description} onChange={(event) => updateConnection(item.id, { description: event.target.value })} /></label>
        <button type="button" className="icon-action danger row-remove" title="删除连接" onClick={() => update({ connections: dialog.form.connections.filter((connection) => connection.id !== item.id) })}><Trash2 size={16} /></button>
      </div>)}
      {!dialog.form.connections.length && <div className="structured-empty">暂未配置物理连接</div>}
    </div>
  </>;
}

function ScenarioForm({ dialog, setDialog }: { dialog: Extract<ResourceDialog, { kind: "scenario" }>; setDialog: (value: ResourceDialog) => void }) {
  const update = (value: Partial<TestScenarioInput>) => setDialog({ ...dialog, form: { ...dialog.form, ...value } });
  const updateRole = (id: string, value: Partial<ScenarioRole>) => update({ roles: dialog.form.roles.map((item) => item.id === id ? { ...item, ...value } : item) });
  const updateParameter = (id: string, value: Partial<ScenarioParameter>) => update({ parameters: dialog.form.parameters.map((item) => item.id === id ? { ...item, ...value } : item) });
  return <>
    <div className="modal-grid">
      <label className="field"><span>场景名称</span><input autoFocus value={dialog.form.name} onChange={(event) => update({ name: event.target.value })} /></label>
      <label className="field"><span>功能分类</span><input value={dialog.form.category} placeholder="例如 VRRP、OSPF" onChange={(event) => update({ category: event.target.value })} /></label>
      <label className="field full-width"><span>场景说明</span><textarea rows={2} value={dialog.form.description} onChange={(event) => update({ description: event.target.value })} /></label>
    </div>
    <div className="form-list-heading"><div><Server size={16} /><strong>设备角色</strong></div><button type="button" className="button secondary compact" onClick={() => update({ roles: [...dialog.form.roles, { id: newId(), key: "", name: "", deviceType: "" }] })}><Plus size={15} />添加角色</button></div>
    <div className="structured-list">
      {dialog.form.roles.map((item) => <div className="structured-row role-row" key={item.id}>
        <label><span>角色标识</span><input value={item.key} placeholder="master" onChange={(event) => updateRole(item.id, { key: event.target.value })} /></label>
        <label><span>显示名称</span><input value={item.name} placeholder="主设备" onChange={(event) => updateRole(item.id, { name: event.target.value })} /></label>
        <label><span>设备类型</span><input value={item.deviceType} placeholder="TAU" onChange={(event) => updateRole(item.id, { deviceType: event.target.value })} /></label>
        <button type="button" className="icon-action danger row-remove" title="删除角色" onClick={() => update({ roles: dialog.form.roles.filter((role) => role.id !== item.id) })}><Trash2 size={16} /></button>
      </div>)}
    </div>
    <div className="form-list-heading"><div><Layers3 size={16} /><strong>场景参数</strong></div><button type="button" className="button secondary compact" onClick={() => update({ parameters: [...dialog.form.parameters, { id: newId(), key: "", name: "", defaultValue: "" }] })}><Plus size={15} />添加参数</button></div>
    <div className="structured-list">
      {dialog.form.parameters.map((item) => <div className="structured-row parameter-row" key={item.id}>
        <label><span>参数标识</span><input value={item.key} placeholder="virtual_ip" onChange={(event) => updateParameter(item.id, { key: event.target.value })} /></label>
        <label><span>参数名称</span><input value={item.name} placeholder="虚拟 IP" onChange={(event) => updateParameter(item.id, { name: event.target.value })} /></label>
        <label className="grow"><span>默认值</span><input value={item.defaultValue} onChange={(event) => updateParameter(item.id, { defaultValue: event.target.value })} /></label>
        <button type="button" className="icon-action danger row-remove" title="删除参数" onClick={() => update({ parameters: dialog.form.parameters.filter((parameter) => parameter.id !== item.id) })}><Trash2 size={16} /></button>
      </div>)}
      {!dialog.form.parameters.length && <div className="structured-empty">暂无场景参数</div>}
    </div>
    <div className="modal-grid instruction-grid">
      <label className="field full-width"><span>场景搭建要求</span><textarea rows={4} value={dialog.form.setupInstructions} onChange={(event) => update({ setupInstructions: event.target.value })} /></label>
      <label className="field full-width"><span>场景验证要求</span><textarea rows={3} value={dialog.form.verificationInstructions} onChange={(event) => update({ verificationInstructions: event.target.value })} /></label>
      <label className="field full-width"><span>场景清理要求</span><textarea rows={3} value={dialog.form.cleanupInstructions} onChange={(event) => update({ cleanupInstructions: event.target.value })} /></label>
    </div>
  </>;
}
