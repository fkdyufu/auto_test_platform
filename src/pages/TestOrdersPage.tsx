import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ChevronRight,
  CircleStop,
  ClipboardList,
  Eye,
  LoaderCircle,
  Network,
  Pencil,
  Play,
  Plus,
  Trash2,
  Workflow,
} from "lucide-react";
import {
  api,
  type DeviceResource,
  type LabEnvironment,
  type ProductSummary,
  type RunEvent,
  type RunResponse,
  type RunStatus,
  type TestCase,
  type TestOrderDetail,
  type TestOrderInput,
  type TestOrderSummary,
  type TestRun,
  type TestScenario,
} from "../api";
import { RunMonitor } from "../components/RunMonitor";
import { InlineNotice, Modal, PageHeader, type Notice } from "../components/ui";

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "等待执行",
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

const EMPTY_ORDER: TestOrderInput = {
  name: "",
  description: "",
  targetUrl: "",
  username: "",
  password: "",
  environmentId: "",
  scenarioId: "",
  roleBindings: {},
  caseIds: [],
};

function formatDateTime(value?: string): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function StatusBadge({ run }: { run?: TestRun }) {
  if (!run) return <span className="status-badge idle">未执行</span>;
  const appearance = run.status === "completed" && run.outcome ? run.outcome : run.status;
  const label = run.status === "completed" && run.outcome ? (run.outcome === "passed" ? "通过" : "失败") : STATUS_LABELS[run.status];
  return <span className={`status-badge ${appearance}`}>{label}</span>;
}

export function TestOrdersPage({ product }: { product: ProductSummary }) {
  const [orders, setOrders] = useState<TestOrderSummary[]>([]);
  const [devices, setDevices] = useState<DeviceResource[]>([]);
  const [environments, setEnvironments] = useState<LabEnvironment[]>([]);
  const [scenarios, setScenarios] = useState<TestScenario[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<TestOrderDetail | null>(null);
  const [dialog, setDialog] = useState<{ id?: string; form: TestOrderInput } | null>(null);
  const [availableCases, setAvailableCases] = useState<TestCase[]>([]);
  const [dialogError, setDialogError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [activeRun, setActiveRun] = useState<RunResponse | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const active = activeRun?.status === "queued" || activeRun?.status === "running";

  const loadOrders = async () => setOrders(await api.getTestOrders(product.id));

  const loadDetail = async (id: string) => {
    const nextDetail = await api.getTestOrder(product.id, id);
    setDetail(nextDetail);
    return nextDetail;
  };

  useEffect(() => {
    setSelectedId("");
    setDetail(null);
    setDialog(null);
    setActiveRun(null);
    void Promise.all([
      api.getTestOrders(product.id),
      api.getDeviceResources(product.id),
      api.getLabEnvironments(product.id),
      api.getTestScenarios(product.id),
    ])
      .then(([nextOrders, nextDevices, nextEnvironments, nextScenarios]) => {
        setOrders(nextOrders);
        setDevices(nextDevices);
        setEnvironments(nextEnvironments);
        setScenarios(nextScenarios);
      })
      .catch((error) => setNotice({ kind: "error", message: error instanceof Error ? error.message : "读取测试单失败" }));
    return () => eventSourceRef.current?.close();
  }, [product.id]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId).catch((error) =>
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "读取测试单详情失败" }),
    );
  }, [selectedId, product.id]);

  const openDialog = async (order?: TestOrderDetail | TestOrderSummary) => {
    try {
      setDialogError("");
      setAvailableCases(await api.getTestCases(product.id));
      setDialog({
        id: order?.id,
        form: order
          ? {
              name: order.name,
              description: order.description,
              targetUrl: order.targetUrl,
              username: order.username,
              password: "",
              environmentId: order.environmentId,
              scenarioId: order.scenarioId,
              roleBindings: { ...order.roleBindings },
              caseIds: [...order.caseIds],
            }
          : { ...EMPTY_ORDER },
      });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "读取产品用例失败" });
    }
  };

  const toggleCase = (caseId: string) => {
    if (!dialog) return;
    const selected = dialog.form.caseIds.includes(caseId);
    setDialog({
      ...dialog,
      form: {
        ...dialog.form,
        caseIds: selected ? dialog.form.caseIds.filter((id) => id !== caseId) : [...dialog.form.caseIds, caseId],
      },
    });
  };

  const dialogEnvironment = environments.find((item) => item.id === dialog?.form.environmentId);
  const dialogScenario = scenarios.find((item) => item.id === dialog?.form.scenarioId);
  const environmentDevices = devices.filter((item) => dialogEnvironment?.deviceIds.includes(item.id));

  const matchesRole = (device: DeviceResource, role: TestScenario["roles"][number]) =>
    device.type.toLowerCase() === role.deviceType.toLowerCase();

  const autoBindRoles = (scenarioId: string, environmentId: string) => {
    const scenario = scenarios.find((item) => item.id === scenarioId);
    const environment = environments.find((item) => item.id === environmentId);
    if (!scenario || !environment) return {};
    const candidates = devices.filter((item) => environment.deviceIds.includes(item.id));
    const used = new Set<string>();
    const bindings: Record<string, string> = {};
    for (const role of scenario.roles) {
      const device = candidates.find((item) => !used.has(item.id) && matchesRole(item, role));
      if (device) {
        bindings[role.key] = device.id;
        used.add(device.id);
      }
    }
    return bindings;
  };

  const selectEnvironment = (environmentId: string) => {
    if (!dialog) return;
    const scenarioId = environmentId ? dialog.form.scenarioId : "";
    setDialog({
      ...dialog,
      form: { ...dialog.form, environmentId, scenarioId, roleBindings: autoBindRoles(scenarioId, environmentId) },
    });
  };

  const selectScenario = (scenarioId: string) => {
    if (!dialog) return;
    setDialog({
      ...dialog,
      form: { ...dialog.form, scenarioId, roleBindings: autoBindRoles(scenarioId, dialog.form.environmentId) },
    });
  };

  const bindRole = (roleKey: string, deviceId: string) => {
    if (!dialog) return;
    setDialog({
      ...dialog,
      form: { ...dialog.form, roleBindings: { ...dialog.form.roleBindings, [roleKey]: deviceId } },
    });
  };

  const saveOrder = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog) return;
    try {
      setSubmitting(true);
      setDialogError("");
      const saved = dialog.id
        ? await api.updateTestOrder(product.id, dialog.id, dialog.form)
        : await api.createTestOrder(product.id, dialog.form);
      await loadOrders();
      setSelectedId(saved.id);
      setDetail(saved);
      setDialog(null);
      setNotice({ kind: "success", message: dialog.id ? "测试单已更新" : "测试单已创建" });
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "保存测试单失败");
    } finally {
      setSubmitting(false);
    }
  };

  const deleteOrder = async (order: TestOrderSummary | TestOrderDetail) => {
    if (!window.confirm(`确定删除测试单“${order.name}”吗？历史执行记录将保留。`)) return;
    try {
      await api.deleteTestOrder(product.id, order.id);
      if (selectedId === order.id) setSelectedId("");
      await loadOrders();
      setNotice({ kind: "success", message: "测试单已删除" });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "删除测试单失败" });
    }
  };

  const connectEvents = (run: RunResponse) => {
    eventSourceRef.current?.close();
    setActiveRun(run);
    const source = new EventSource(`/api/runs/${run.id}/events`);
    eventSourceRef.current = source;
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      setActiveRun((current) => {
        if (!current || current.id !== run.id || current.events.some((item) => item.id === event.id)) return current;
        const nextStatus = event.type === "run_state" && event.status ? event.status : current.status;
        if (["completed", "failed", "cancelled"].includes(nextStatus)) {
          source.close();
          void loadOrders();
          if (selectedId || run.testOrderId) void loadDetail(run.testOrderId || selectedId);
        }
        return { ...current, status: nextStatus, events: [...current.events, event] };
      });
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) return;
      setNotice({ kind: "error", message: "执行事件连接已中断" });
    };
  };

  const execute = async (order: TestOrderSummary | TestOrderDetail, testCaseId?: string) => {
    try {
      setNotice(null);
      setSelectedId(order.id);
      connectEvents(await api.executeTestOrder(product.id, order.id, testCaseId));
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "创建执行任务失败" });
    }
  };

  const cancel = async () => {
    if (!activeRun) return;
    try {
      await api.cancelRun(activeRun.id);
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "取消执行失败" });
    }
  };

  return (
    <div className="page orders-page">
      <PageHeader
        icon={<ClipboardList size={19} />}
        title={selectedId ? "测试单详情" : "测试单"}
        actions={
          selectedId ? (
            <button className="button secondary" onClick={() => setSelectedId("")}>
              <ArrowLeft size={17} />
              返回列表
            </button>
          ) : (
            <button className="button primary" onClick={() => void openDialog()}>
              <Plus size={17} />
              新建测试单
            </button>
          )
        }
      />

      {notice && <InlineNotice notice={notice} onClose={() => setNotice(null)} />}

      {!selectedId ? (
        <div className="list-surface">
          <div className="table-wrap">
            <table className="data-table orders-table">
              <thead>
                <tr>
                  <th>测试单</th>
                  <th>环境 / 场景</th>
                  <th>用例</th>
                  <th>最近执行</th>
                  <th>更新时间</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td className="name-cell">
                      <button className="link-button" onClick={() => setSelectedId(order.id)}>{order.name}</button>
                    </td>
                    <td>{order.environmentName || "未配置"}<span className="cell-subtext">{order.scenarioName || "无测试场景"}</span></td>
                    <td>{order.caseCount}</td>
                    <td><StatusBadge run={order.latestRun} /></td>
                    <td>{formatDateTime(order.updatedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="button primary compact" onClick={() => void execute(order)} disabled={active}>
                          {active && activeRun?.testOrderId === order.id ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
                          执行
                        </button>
                        <button className="icon-action" onClick={() => setSelectedId(order.id)} title="查看详情">
                          <ChevronRight size={17} />
                        </button>
                        <button className="icon-action" onClick={() => void openDialog(order)} title="编辑测试单">
                          <Pencil size={16} />
                        </button>
                        <button className="icon-action danger" onClick={() => void deleteOrder(order)} title="删除测试单">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!orders.length && (
                  <tr>
                    <td colSpan={6} className="table-empty">
                      <ClipboardList size={24} />
                      暂无测试单
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : detail ? (
        <div className="order-detail">
          <section className="order-summary-band">
            <div>
              <span className="detail-kicker">{detail.productName}</span>
              <h2>{detail.name}</h2>
              <p>{detail.description || "暂无测试单描述"}</p>
            </div>
            <div className="summary-actions">
              {active ? (
                <button className="button secondary danger" onClick={() => void cancel()}>
                  <CircleStop size={17} />
                  取消执行
                </button>
              ) : (
                <button className="button primary" onClick={() => void execute(detail)}>
                  <Play size={17} />
                  执行全部
                </button>
              )}
              <button className="icon-action" onClick={() => void openDialog(detail)} title="编辑测试单">
                <Pencil size={17} />
              </button>
              <button className="icon-action danger" onClick={() => void deleteOrder(detail)} title="删除测试单">
                <Trash2 size={17} />
              </button>
            </div>
          </section>

          <dl className="order-meta">
            <div><dt>目标地址</dt><dd>{detail.targetUrl}</dd></div>
            <div><dt>登录账号</dt><dd>{detail.username || "未配置"}</dd></div>
            <div><dt>实验环境</dt><dd>{detail.environmentName || "未配置"}</dd></div>
            <div><dt>测试场景</dt><dd>{detail.scenarioName || "未配置"}</dd></div>
            <div><dt>用例数量</dt><dd>{detail.caseCount}</dd></div>
            <div><dt>最近执行</dt><dd><StatusBadge run={detail.runs[0]} /></dd></div>
          </dl>

          {detail.scenario && (
            <section className="detail-section environment-binding-section">
              <div className="content-toolbar">
                <div><Network size={17} /><strong>测试环境</strong></div>
                <span className="muted-count">{detail.environment?.deviceIds.length || 0} 台设备</span>
              </div>
              <div className="binding-summary">
                <div>
                  <span>场景要求</span>
                  <strong>{detail.scenario.setupInstructions}</strong>
                </div>
                <div className="role-binding-list">
                  {detail.scenario.roles.map((role) => {
                    const device = detail.boundDevices.find((item) => item.id === detail.roleBindings[role.key]);
                    return <span key={role.id}><b>{role.name}</b><i>→</i>{device?.name || "未绑定"}</span>;
                  })}
                </div>
              </div>
            </section>
          )}

          <section className="detail-section">
            <div className="content-toolbar">
              <div><ClipboardList size={17} /><strong>测试用例</strong></div>
              <span className="muted-count">按列表顺序执行</span>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>顺序</th><th>用例名称</th><th>测试步骤</th><th>预期结果</th><th aria-label="操作" /></tr>
                </thead>
                <tbody>
                  {detail.cases.map((testCase, index) => (
                    <tr key={testCase.id}>
                      <td className="order-index">{String(index + 1).padStart(2, "0")}</td>
                      <td className="name-cell">{testCase.name}</td>
                      <td className="truncate-cell">{testCase.steps}</td>
                      <td className="truncate-cell">{testCase.expectedResult}</td>
                      <td>
                        <button className="button secondary compact" onClick={() => void execute(detail, testCase.id)} disabled={active}>
                          <Play size={15} />
                          执行
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {activeRun?.testOrderId === detail.id && (
            <section className="detail-section run-monitor-section">
              <div className="content-toolbar">
                <div><LoaderCircle className={active ? "spin" : ""} size={17} /><strong>执行过程</strong></div>
                <span className="run-id">{activeRun.id.slice(0, 8)}</span>
              </div>
              <RunMonitor events={activeRun.events} status={activeRun.status} emptyText="等待执行" />
            </section>
          )}

          <section className="detail-section">
            <div className="content-toolbar">
              <div><Eye size={17} /><strong>执行历史</strong></div>
              <span className="muted-count">最近 {detail.runs.length} 次</span>
            </div>
            <div className="table-wrap">
              <table className="data-table history-table">
                <thead><tr><th>执行时间</th><th>范围</th><th>用例结果</th><th>状态</th><th>耗时</th></tr></thead>
                <tbody>
                  {detail.runs.map((run) => {
                    const passed = run.caseRuns.filter((item) => item.outcome === "passed").length;
                    const failed = run.caseRuns.filter((item) => item.outcome === "failed").length;
                    const duration = run.startedAt && run.finishedAt
                      ? `${Math.max(1, Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000))} 秒`
                      : "-";
                    return (
                      <tr key={run.id}>
                        <td>{formatDateTime(run.createdAt)}</td>
                        <td>{run.triggerType === "all" ? "整单" : "单用例"}</td>
                        <td>{passed} 通过 / {failed} 失败</td>
                        <td><StatusBadge run={run} /></td>
                        <td>{duration}</td>
                      </tr>
                    );
                  })}
                  {!detail.runs.length && <tr><td colSpan={5} className="table-empty">暂无执行记录</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : (
        <div className="detail-empty"><LoaderCircle className="spin" size={26} /><span>加载测试单...</span></div>
      )}

      {dialog && (
        <Modal
          title={dialog.id ? "编辑测试单" : "新建测试单"}
          onClose={() => setDialog(null)}
          onSubmit={saveOrder}
          submitting={submitting}
        >
          {dialogError && <div className="form-error">{dialogError}</div>}
          <div className="modal-grid">
            <label className="field">
              <span>测试单名称</span>
              <input
                value={dialog.form.name}
                onChange={(event) => setDialog({ ...dialog, form: { ...dialog.form, name: event.target.value } })}
                autoFocus
              />
            </label>
            <label className="field full-width">
              <span>测试单描述</span>
              <textarea
                value={dialog.form.description}
                onChange={(event) => setDialog({ ...dialog, form: { ...dialog.form, description: event.target.value } })}
                rows={3}
              />
            </label>
            <label className="field full-width">
              <span>目标地址</span>
              <input
                value={dialog.form.targetUrl}
                onChange={(event) => setDialog({ ...dialog, form: { ...dialog.form, targetUrl: event.target.value } })}
                placeholder="http://192.168.1.1"
              />
            </label>
            <label className="field">
              <span>登录账号</span>
              <input
                value={dialog.form.username}
                onChange={(event) => setDialog({ ...dialog, form: { ...dialog.form, username: event.target.value } })}
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>登录密码</span>
              <input
                type="password"
                value={dialog.form.password}
                onChange={(event) => setDialog({ ...dialog, form: { ...dialog.form, password: event.target.value } })}
                placeholder={dialog.id ? "留空保持不变" : "可选"}
                autoComplete="new-password"
              />
            </label>
          </div>
          <div className="order-environment-config">
            <div className="form-list-heading"><div><Network size={16} /><strong>测试环境</strong></div><small>可选</small></div>
            <div className="modal-grid">
              <label className="field">
                <span>实验环境</span>
                <select value={dialog.form.environmentId} onChange={(event) => selectEnvironment(event.target.value)}>
                  <option value="">不使用实验环境</option>
                  {environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span>测试场景</span>
                <select value={dialog.form.scenarioId} disabled={!dialog.form.environmentId} onChange={(event) => selectScenario(event.target.value)}>
                  <option value="">不使用测试场景</option>
                  {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name} / {scenario.category}</option>)}
                </select>
              </label>
            </div>
            {dialogScenario && (
              <div className="role-binding-editor">
                <div className="form-list-heading"><div><Workflow size={16} /><strong>设备角色绑定</strong></div><small>{dialogScenario.roles.length} 个角色</small></div>
                <div className="role-binding-grid">
                  {dialogScenario.roles.map((role) => (
                    <label className="field" key={role.id}>
                      <span>{role.name} <small>{role.key} / {role.deviceType}</small></span>
                      <select value={dialog.form.roleBindings[role.key] || ""} onChange={(event) => bindRole(role.key, event.target.value)}>
                        <option value="">请选择设备</option>
                        {environmentDevices.map((device) => {
                          const compatible = matchesRole(device, role);
                          return <option key={device.id} value={device.id} disabled={!compatible}>{device.name} / {device.type}{compatible ? "" : "（不匹配）"}</option>;
                        })}
                      </select>
                    </label>
                  ))}
                </div>
                {!environmentDevices.length && <div className="form-error">所选实验环境中没有可绑定的设备</div>}
              </div>
            )}
          </div>
          <div className="case-picker-heading">
            <span>选择用例</span>
            <small>{dialog.form.caseIds.length} / {availableCases.length}</small>
          </div>
          <div className="case-picker">
            {availableCases.map((testCase) => (
              <label key={testCase.id} className="case-option">
                <input
                  type="checkbox"
                  checked={dialog.form.caseIds.includes(testCase.id)}
                  onChange={() => toggleCase(testCase.id)}
                />
                <span><strong>{testCase.name}</strong><small>{testCase.expectedResult}</small></span>
              </label>
            ))}
            {!availableCases.length && <div className="list-empty">{product.name} 暂无测试用例</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
