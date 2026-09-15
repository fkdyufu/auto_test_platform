import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ChevronRight,
  CircleStop,
  ClipboardList,
  Eye,
  FileText,
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
  type PhysicalEnvironment,
  type ProductSummary,
  type RunEvent,
  type RunResponse,
  type RunStatus,
  type TestCase,
  type TestCaseInput,
  type TestOrderDetail,
  type TestOrderInput,
  type TestOrderSummary,
  type TestRun,
  type TestScenario,
} from "../api";
import { RunMonitor } from "../components/RunMonitor";
import { DiagnosticAssistant, type DiagnosticTarget } from "../components/DiagnosticAssistant";
import { TestRunReportDialog } from "../components/TestRunReport";
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
  physicalEnvironmentId: "",
  caseIds: [],
};

type CaseDialog = {
  testCase: TestCase;
  form: TestCaseInput;
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
  const [physicalEnvironments, setPhysicalEnvironments] = useState<PhysicalEnvironment[]>([]);
  const [scenarios, setScenarios] = useState<TestScenario[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<TestOrderDetail | null>(null);
  const [dialog, setDialog] = useState<{ id?: string; form: TestOrderInput } | null>(null);
  const [caseDialog, setCaseDialog] = useState<CaseDialog | null>(null);
  const [availableCases, setAvailableCases] = useState<TestCase[]>([]);
  const [dialogError, setDialogError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [activeRun, setActiveRun] = useState<RunResponse | null>(null);
  const [reportRun, setReportRun] = useState<TestRun | null>(null);
  const [diagnosticTarget, setDiagnosticTarget] = useState<DiagnosticTarget | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const active = activeRun?.status === "queued" || activeRun?.status === "running";

  const loadOrders = async () => setOrders(await api.getTestOrders(product.id));

  const loadDetail = async (id: string) => {
    const nextDetail = await api.getTestOrder(product.id, id);
    setDetail(nextDetail);
    const latestRun = nextDetail.runs[0];
    if (latestRun) {
      try {
        await restoreRun(latestRun.id);
      } catch {
        setActiveRun(null);
      }
    } else {
      eventSourceRef.current?.close();
      setActiveRun(null);
    }
    return nextDetail;
  };

  useEffect(() => {
    setSelectedId("");
    setDetail(null);
    setDialog(null);
    setCaseDialog(null);
    setReportRun(null);
    setDiagnosticTarget(null);
    setActiveRun(null);
    void Promise.all([
      api.getTestOrders(product.id),
      api.getPhysicalEnvironments(product.id),
      api.getTestScenarios(product.id),
    ])
      .then(([nextOrders, nextPhysicalEnvironments, nextScenarios]) => {
        setOrders(nextOrders);
        setPhysicalEnvironments(nextPhysicalEnvironments);
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
      const [nextCases, nextScenarios] = await Promise.all([
        api.getTestCases(product.id),
        api.getTestScenarios(product.id),
      ]);
      setAvailableCases(nextCases);
      setScenarios(nextScenarios);
      setDialog({
        id: order?.id,
        form: order
          ? {
              name: order.name,
              description: order.description,
              physicalEnvironmentId: order.physicalEnvironmentId,
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

  const selectPhysicalEnvironment = (physicalEnvironmentId: string) => {
    if (!dialog) return;
    setDialog({
      ...dialog,
      form: { ...dialog.form, physicalEnvironmentId },
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

  const openCaseDialog = (testCase: TestCase) => {
    setDialogError("");
    setCaseDialog({
      testCase,
      form: {
        scenarioId: testCase.scenarioId,
        name: testCase.name,
        precondition: testCase.precondition,
        steps: testCase.steps,
        expectedResult: testCase.expectedResult,
      },
    });
  };

  const saveCase = async (event: FormEvent) => {
    event.preventDefault();
    if (!caseDialog || !detail) return;
    try {
      setSubmitting(true);
      setDialogError("");
      await api.updateTestCase(product.id, caseDialog.testCase.id, caseDialog.form);
      await Promise.all([loadDetail(detail.id), loadOrders()]);
      setCaseDialog(null);
      setNotice({ kind: "success", message: "测试用例已更新" });
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "保存测试用例失败");
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

  const restoreRun = async (runId: string) => {
    const run = await api.getRun(runId);
    if (run.status === "queued" || run.status === "running") connectEvents(run);
    else {
      eventSourceRef.current?.close();
      setActiveRun(run);
    }
    return run;
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

  const viewRun = async (run: TestRun) => {
    try {
      setNotice(null);
      await restoreRun(run.id);
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "读取执行过程失败" });
    }
  };

  const scenarioName = (scenarioId: string) =>
    scenarios.find((scenario) => scenario.id === scenarioId)?.name || "场景已删除";

  const groupedCases = detail
    ? Array.from(
        detail.cases.reduce((groups, testCase) => {
          const group = groups.get(testCase.scenarioId) || [];
          group.push(testCase);
          groups.set(testCase.scenarioId, group);
          return groups;
        }, new Map<string, TestCase[]>()),
      )
    : [];
  const executionPlanCases = groupedCases.flatMap(([, testCases]) => testCases);
  const activeTestRun = activeRun ? detail?.runs.find((run) => run.id === activeRun.id) : undefined;

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
                  <th>物理环境</th>
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
                    <td>{order.physicalEnvironmentName || "未配置"}</td>
                    <td>{order.caseCount}</td>
                    <td>
                      {order.latestRun ? (
                        <button className="link-button" onClick={() => setSelectedId(order.id)} title="查看最近执行过程">
                          <StatusBadge run={order.latestRun} />
                        </button>
                      ) : <StatusBadge run={order.latestRun} />}
                    </td>
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
            <div><dt>物理环境</dt><dd>{detail.physicalEnvironmentName || "未配置"}</dd></div>
            <div><dt>用例数量</dt><dd>{detail.caseCount}</dd></div>
            <div><dt>最近执行</dt><dd><StatusBadge run={detail.runs[0]} /></dd></div>
            <div><dt>更新时间</dt><dd>{formatDateTime(detail.updatedAt)}</dd></div>
          </dl>

          <section className="detail-section">
            <div className="content-toolbar">
              <div><ClipboardList size={17} /><strong>测试用例</strong></div>
              <span className="muted-count">先搭建场景，再按组执行</span>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>顺序</th><th>测试场景</th><th>用例名称</th><th>前置条件</th><th>测试步骤</th><th>预期结果</th><th aria-label="操作" /></tr>
                </thead>
                <tbody>
                  {groupedCases.map(([scenarioId, testCases]) => <Fragment key={scenarioId}>
                    <tr className="scenario-group-row">
                      <td colSpan={7}><div><Workflow size={14} /><strong>{scenarioName(scenarioId)}</strong><span>{testCases.length} 个用例</span></div></td>
                    </tr>
                    {testCases.map((testCase) => (
                      <tr key={testCase.id}>
                        <td className="order-index">{String(executionPlanCases.indexOf(testCase) + 1).padStart(2, "0")}</td>
                        <td><span className="category-label">{scenarioName(testCase.scenarioId)}</span></td>
                        <td className="name-cell">
                          <button className="link-button" onClick={() => openCaseDialog(testCase)} title="查看并编辑用例">
                            {testCase.name}
                          </button>
                        </td>
                        <td className="truncate-cell">{testCase.precondition || "-"}</td>
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
                  </Fragment>)}
                </tbody>
              </table>
            </div>
          </section>

          {activeRun?.testOrderId === detail.id && (
            <section className="detail-section run-monitor-section">
              <div className="content-toolbar">
                <div><LoaderCircle className={active ? "spin" : ""} size={17} /><strong>执行过程</strong></div>
                <div className="run-monitor-actions">
                  {activeTestRun && !active && (
                    <button className="button secondary compact" onClick={() => setReportRun(activeTestRun)}>
                      <FileText size={15} />
                      查看报告
                    </button>
                  )}
                  <span className="run-id">{activeRun.id.slice(0, 8)}</span>
                </div>
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
                <thead><tr><th>执行时间</th><th>范围</th><th>用例结果</th><th>状态</th><th>耗时</th><th aria-label="操作" /></tr></thead>
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
                        <td>
                          <div className="row-actions">
                            <button className="icon-action" onClick={() => setReportRun(run)} title="查看执行报告">
                              <FileText size={16} />
                            </button>
                            <button className="icon-action" onClick={() => void viewRun(run)} title="查看执行过程">
                              <Eye size={16} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!detail.runs.length && <tr><td colSpan={6} className="table-empty">暂无执行记录</td></tr>}
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
          </div>
          <div className="order-physical-environment-config">
            <div className="form-list-heading"><div><Network size={16} /><strong>物理环境</strong></div><small>可选</small></div>
            <div className="modal-grid">
              <label className="field full-width">
                <span>物理环境</span>
                <select value={dialog.form.physicalEnvironmentId} onChange={(event) => selectPhysicalEnvironment(event.target.value)}>
                  <option value="">不使用物理环境</option>
                  {physicalEnvironments.map((physicalEnvironment) => (
                    <option key={physicalEnvironment.id} value={physicalEnvironment.id}>{physicalEnvironment.name}</option>
                  ))}
                </select>
              </label>
            </div>
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
                <span><strong>{testCase.name}</strong><small>{scenarioName(testCase.scenarioId)} · {testCase.expectedResult}</small></span>
              </label>
            ))}
            {!availableCases.length && <div className="list-empty">{product.name} 暂无测试用例</div>}
          </div>
        </Modal>
      )}

      {caseDialog && (
        <Modal
          title="测试用例详情"
          className="test-case-detail-modal"
          onClose={() => setCaseDialog(null)}
          onSubmit={saveCase}
          submitting={submitting}
        >
          {dialogError && <div className="form-error">{dialogError}</div>}
          <div className="case-detail-metadata">
            <span className={`source-label ${caseDialog.testCase.source}`}>
              {caseDialog.testCase.source === "zentao" ? "禅道" : "本地"}
            </span>
            <span className="mono-cell" title={caseDialog.testCase.id}>
              {caseDialog.testCase.zentaoCaseId ? `禅道用例 #${caseDialog.testCase.zentaoCaseId}` : `用例 ID ${caseDialog.testCase.id}`}
            </span>
          </div>
          <div className="modal-grid">
            <label className="field">
              <span>用例名称</span>
              <input
                value={caseDialog.form.name}
                onChange={(event) => setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, name: event.target.value } })}
                autoFocus
              />
            </label>
            <label className="field">
              <span>测试场景</span>
              <select
                value={caseDialog.form.scenarioId}
                onChange={(event) => setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, scenarioId: event.target.value } })}
              >
                {scenarios.map((scenario) => (
                  <option key={scenario.id} value={scenario.id}>{scenario.name}{scenario.isDefault ? "（系统默认）" : ""}</option>
                ))}
              </select>
            </label>
            <label className="field full-width">
              <span>前置条件</span>
              <textarea
                value={caseDialog.form.precondition}
                onChange={(event) => setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, precondition: event.target.value } })}
                rows={5}
                placeholder="可选"
              />
            </label>
            <label className="field full-width">
              <span>测试步骤</span>
              <textarea
                value={caseDialog.form.steps}
                onChange={(event) => setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, steps: event.target.value } })}
                rows={9}
              />
            </label>
            <label className="field full-width">
              <span>预期结果</span>
              <textarea
                value={caseDialog.form.expectedResult}
                onChange={(event) => setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, expectedResult: event.target.value } })}
                rows={6}
              />
            </label>
          </div>
        </Modal>
      )}

      {reportRun && detail && (
        <TestRunReportDialog
          run={reportRun}
          orderName={detail.name}
          physicalEnvironmentName={detail.physicalEnvironmentName}
          onDiagnose={(target) => {
            setDiagnosticTarget({ testRunId: reportRun.id, ...target });
            setReportRun(null);
          }}
          onClose={() => setReportRun(null)}
        />
      )}

      {diagnosticTarget && (
        <DiagnosticAssistant
          productId={product.id}
          target={diagnosticTarget}
          onClose={() => setDiagnosticTarget(null)}
        />
      )}
    </div>
  );
}
