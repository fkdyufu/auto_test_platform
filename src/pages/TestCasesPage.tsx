import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  CloudDownload,
  FileText,
  Library,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import {
  api,
  type ProductSummary,
  type TestCase,
  type TestCaseInput,
  type TestScenario,
  type ZentaoCaseSummary,
  type ZentaoTestTaskSummary,
} from "../api";
import { AutoResizeTextarea, InlineNotice, Modal, PageHeader, type Notice } from "../components/ui";
import { useAssistantPage } from "../components/AssistantContext";
import { CaseStepsEditor } from "../components/CaseStepsEditor";
import { stepRowsFromLegacy, stepRowsToText } from "../../shared/test-case-steps";
import { matchesTestCaseSearch, testCaseDisplayId } from "../test-case-search";

type CaseDialog = { id?: string; form: TestCaseInput } | null;
type ImportSource = "product" | "testTask";

interface ImportDialogState {
  source: ImportSource;
  testTasks: ZentaoTestTaskSummary[];
  testTaskId: string;
  cases: ZentaoCaseSummary[];
  selectedIds: number[];
  overwrite: boolean;
  query: string;
  loading: boolean;
}

const EMPTY_CASE: TestCaseInput = { scenarioId: "", name: "", precondition: "", steps: "", expectedResult: "", stepRows: [{ step: "", expected: "" }] };

export function TestCasesPage({
  product,
  onCasesChanged,
}: {
  product: ProductSummary;
  onCasesChanged: () => Promise<void>;
}) {
  const [cases, setCases] = useState<TestCase[]>([]);
  const [scenarios, setScenarios] = useState<TestScenario[]>([]);
  const [caseQuery, setCaseQuery] = useState("");
  const [scenarioFilter, setScenarioFilter] = useState("");
  const [caseDialog, setCaseDialog] = useState<CaseDialog>(null);
  const [importDialog, setImportDialog] = useState<ImportDialogState | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [submitting, setSubmitting] = useState(false);

  const reload = async () => {
    const [nextCases, nextScenarios] = await Promise.all([
      api.getTestCases(product.id),
      api.getTestScenarios(product.id),
    ]);
    setCases(nextCases);
    setScenarios(nextScenarios);
    setScenarioFilter((current) => nextScenarios.some((scenario) => scenario.id === current) ? current : "");
  };

  useAssistantPage({ page: "cases", title: caseDialog ? caseDialog.form.name || "新增测试用例" : "用例库", assetKind: "case", assetId: caseDialog?.id, ...(caseDialog && !submitting ? { draft: { ...caseDialog.form } } : {}) }, (draft) => {
    setCaseDialog((current) => current ? { ...current, form: draft as unknown as TestCaseInput } : current);
  }, reload);

  useEffect(() => {
    setCaseDialog(null);
    setImportDialog(null);
    setNotice(null);
    setCaseQuery("");
    setScenarioFilter("");
    void reload().catch((error) =>
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "读取用例库失败" }),
    );
  }, [product.id]);

  const openCaseDialog = (testCase?: TestCase) => {
    setDialogError("");
    setCaseDialog({
      id: testCase?.id,
      form: testCase
        ? {
            scenarioId: testCase.scenarioId,
            name: testCase.name,
            precondition: testCase.precondition,
            steps: testCase.steps,
            expectedResult: testCase.expectedResult,
            stepRows: testCase.stepRows || stepRowsFromLegacy(testCase.steps, testCase.expectedResult),
          }
        : { ...EMPTY_CASE, scenarioId: scenarioFilter || scenarios.find((scenario) => scenario.isDefault)?.id || scenarios[0]?.id || "" },
    });
  };

  const saveCase = async (event: FormEvent) => {
    event.preventDefault();
    if (!caseDialog) return;
    try {
      setSubmitting(true);
      setDialogError("");
      if (caseDialog.id) await api.updateTestCase(product.id, caseDialog.id, caseDialog.form);
      else await api.createTestCase(product.id, caseDialog.form);
      await reload();
      await onCasesChanged();
      setCaseDialog(null);
      setNotice({ kind: "success", message: caseDialog.id ? "测试用例已更新" : "测试用例已新增" });
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "保存测试用例失败");
    } finally {
      setSubmitting(false);
    }
  };

  const deleteCase = async (testCase: TestCase) => {
    if (!window.confirm(`确定删除用例“${testCase.name}”吗？`)) return;
    try {
      await api.deleteTestCase(product.id, testCase.id);
      await reload();
      await onCasesChanged();
      setNotice({ kind: "success", message: "测试用例已删除" });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "删除测试用例失败" });
    }
  };

  const openImportDialog = async () => {
    if (!/^[1-9]\d*$/.test(product.zentaoId.trim())) {
      setNotice({ kind: "error", message: "请先在产品概览中为当前产品填写有效的禅道产品 ID" });
      return;
    }
    const initial: ImportDialogState = {
      source: "product",
      testTasks: [],
      testTaskId: "",
      cases: [],
      selectedIds: [],
      overwrite: false,
      query: "",
      loading: true,
    };
    setDialogError("");
    setImportDialog(initial);
    try {
      const [testTasks, zentaoCases] = await Promise.all([
        api.getZentaoTestTasks(product.id),
        api.getZentaoTestCases(product.id),
      ]);
      setImportDialog((current) => current ? {
        ...current,
        testTasks,
        testTaskId: testTasks[0] ? String(testTasks[0].id) : "",
        cases: zentaoCases,
        loading: false,
      } : null);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "读取禅道用例失败");
      setImportDialog((current) => current ? { ...current, loading: false } : null);
    }
  };

  const loadImportCases = async (source: ImportSource, testTaskId: string) => {
    if (!importDialog) return;
    setDialogError("");
    setImportDialog({ ...importDialog, source, testTaskId, selectedIds: [], cases: [], loading: true });
    if (source === "testTask" && !testTaskId) {
      setImportDialog((current) => current ? { ...current, loading: false } : null);
      return;
    }
    try {
      const zentaoCases = await api.getZentaoTestCases(
        product.id,
        source === "testTask" ? Number(testTaskId) : undefined,
      );
      setImportDialog((current) => current ? { ...current, cases: zentaoCases, loading: false } : null);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "读取禅道用例失败");
      setImportDialog((current) => current ? { ...current, loading: false } : null);
    }
  };

  const submitImport = async (event: FormEvent) => {
    event.preventDefault();
    if (!importDialog?.selectedIds.length) return;
    try {
      setSubmitting(true);
      setDialogError("");
      const result = await api.importZentaoTestCases(product.id, importDialog.selectedIds, importDialog.overwrite);
      await reload();
      await onCasesChanged();
      setImportDialog(null);
      setNotice({
        kind: "success",
        message: `禅道用例导入完成：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}`,
      });
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "导入禅道用例失败");
    } finally {
      setSubmitting(false);
    }
  };

  const filteredImportCases = useMemo(() => {
    if (!importDialog) return [];
    const query = importDialog.query.trim().toLowerCase();
    return query
      ? importDialog.cases.filter((testCase) => testCase.title.toLowerCase().includes(query) || String(testCase.id).includes(query))
      : importDialog.cases;
  }, [importDialog]);

  const toggleImportCase = (caseId: number) => {
    if (!importDialog) return;
    const selected = importDialog.selectedIds.includes(caseId);
    setImportDialog({
      ...importDialog,
      selectedIds: selected
        ? importDialog.selectedIds.filter((id) => id !== caseId)
        : [...importDialog.selectedIds, caseId],
    });
  };

  const toggleVisibleImportCases = () => {
    if (!importDialog) return;
    const visibleIds = filteredImportCases.map((testCase) => testCase.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => importDialog.selectedIds.includes(id));
    setImportDialog({
      ...importDialog,
      selectedIds: allSelected
        ? importDialog.selectedIds.filter((id) => !visibleIds.includes(id))
        : [...new Set([...importDialog.selectedIds, ...visibleIds])],
    });
  };

  const scenarioName = (scenarioId: string) =>
    scenarios.find((scenario) => scenario.id === scenarioId)?.name || "场景已删除";

  const filteredCases = cases.filter((testCase) =>
    (!scenarioFilter || testCase.scenarioId === scenarioFilter) && matchesTestCaseSearch(testCase, caseQuery),
  );
  const scenarioCaseCounts = new Map<string, number>();
  for (const testCase of cases) scenarioCaseCounts.set(testCase.scenarioId, (scenarioCaseCounts.get(testCase.scenarioId) || 0) + 1);

  return (
    <div className="page cases-page">
      <PageHeader
        icon={<Library size={19} />}
        title="用例库"
        actions={
          <div className="page-actions">
            <button className="button secondary" onClick={() => void openImportDialog()}>
              <CloudDownload size={17} />
              从禅道导入
            </button>
            <button className="button primary" onClick={() => openCaseDialog()}>
              <Plus size={17} />
              新增用例
            </button>
          </div>
        }
      />

      {notice && <InlineNotice notice={notice} onClose={() => setNotice(null)} />}

      <div className="list-surface cases-list-surface">
        <div className="case-library-filters">
          <label className="field case-search-field">
            <span>搜索用例</span>
            <div className="input-with-icon">
              <Search size={16} />
              <input type="search" value={caseQuery} onChange={(event) => setCaseQuery(event.target.value)} placeholder="输入用例名称或 ID" />
            </div>
          </label>
          <label className="field case-scenario-field">
            <span>按测试场景查看</span>
            <select value={scenarioFilter} onChange={(event) => setScenarioFilter(event.target.value)}>
              <option value="">全部场景（{cases.length}）</option>
              {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}（{scenarioCaseCounts.get(scenario.id) || 0}）</option>)}
            </select>
          </label>
          <div className="case-filter-summary">
            <span role="status">显示 {filteredCases.length} / {cases.length} 个用例</span>
            {(caseQuery || scenarioFilter) && <button type="button" className="button secondary compact" onClick={() => { setCaseQuery(""); setScenarioFilter(""); }}>清除筛选</button>}
          </div>
        </div>
        <div className="table-wrap">
          {filteredCases.length ? (
            <table className="data-table cases-table">
              <thead><tr><th>ID</th><th>名称</th><th>来源</th><th>测试场景</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {filteredCases.map((testCase) => (
                  <tr key={testCase.id}>
                    <td className="mono-cell" title={testCase.zentaoCaseId ? `禅道用例 #${testCase.zentaoCaseId}` : testCase.id}>{testCaseDisplayId(testCase)}</td>
                    <td className="name-cell"><button className="link-button" onClick={() => openCaseDialog(testCase)} title="查看并编辑用例">{testCase.name}</button></td>
                    <td><span className={`source-label ${testCase.source}`}>{testCase.source === "zentao" ? "禅道" : "本地"}</span></td>
                    <td><span className="category-label">{scenarioName(testCase.scenarioId)}</span></td>
                    <td><div className="row-actions">
                      <button className="icon-action" onClick={() => openCaseDialog(testCase)} title="编辑用例"><Pencil size={16} /></button>
                      <button className="icon-action danger" onClick={() => void deleteCase(testCase)} title="删除用例"><Trash2 size={16} /></button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="cases-empty-state"><FileText size={24} />{cases.length ? "没有匹配的用例，请调整搜索词或场景筛选" : "暂无测试用例"}</div>
          )}
        </div>
      </div>

      {caseDialog && (
        <Modal title={caseDialog.id ? "编辑测试用例" : "新增测试用例"} className="test-case-detail-modal" onClose={() => setCaseDialog(null)} onSubmit={saveCase} submitting={submitting}>
          {dialogError && <div className="form-error">{dialogError}</div>}
          <label className="field"><span>用例名称</span><input value={caseDialog.form.name} onChange={(event) => setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, name: event.target.value } })} autoFocus /></label>
          <label className="field"><span>测试场景</span><select value={caseDialog.form.scenarioId} onChange={(event) => setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, scenarioId: event.target.value } })}>{scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}{scenario.isDefault ? "（系统默认）" : ""}</option>)}</select></label>
          <label className="field"><span>前置条件</span><AutoResizeTextarea value={caseDialog.form.precondition} onChange={(event) => setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, precondition: event.target.value } })} rows={4} placeholder="可选" /></label>
          <CaseStepsEditor rows={caseDialog.form.stepRows || stepRowsFromLegacy(caseDialog.form.steps, caseDialog.form.expectedResult)} disabled={submitting} onChange={(stepRows) => setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, stepRows, ...stepRowsToText(stepRows) } })} />
        </Modal>
      )}

      {importDialog && (
        <Modal
          title="从禅道导入用例"
          className="import-cases-modal"
          onClose={() => setImportDialog(null)}
          onSubmit={submitImport}
          submitting={submitting}
          submitLabel={`导入 ${importDialog.selectedIds.length} 个用例`}
          submitDisabled={!importDialog.selectedIds.length || importDialog.loading}
        >
          {dialogError && <div className="form-error">{dialogError}</div>}
          <div className="import-controls">
            <label className="field">
              <span>导入范围</span>
              <select
                value={importDialog.source}
                onChange={(event) => {
                  const source = event.target.value as ImportSource;
                  void loadImportCases(source, source === "testTask" ? importDialog.testTaskId : "");
                }}
              >
                <option value="product">产品用例库</option>
                <option value="testTask">指定禅道测试单</option>
              </select>
            </label>
            {importDialog.source === "testTask" && (
              <label className="field import-task-field">
                <span>禅道测试单</span>
                <select value={importDialog.testTaskId} onChange={(event) => void loadImportCases("testTask", event.target.value)}>
                  {!importDialog.testTasks.length && <option value="">暂无测试单</option>}
                  {importDialog.testTasks.map((task) => <option key={task.id} value={task.id}>#{task.id} {task.name}</option>)}
                </select>
              </label>
            )}
            <label className="field import-search-field">
              <span>筛选用例</span>
              <div className="input-with-icon">
                <Search size={17} />
                <input value={importDialog.query} onChange={(event) => setImportDialog({ ...importDialog, query: event.target.value })} placeholder="输入 ID 或名称" />
              </div>
            </label>
          </div>

          <div className="import-picker-heading">
            <label>
              <input
                type="checkbox"
                checked={filteredImportCases.length > 0 && filteredImportCases.every((testCase) => importDialog.selectedIds.includes(testCase.id))}
                onChange={toggleVisibleImportCases}
              />
              选择当前结果
            </label>
            <span>已选择 {importDialog.selectedIds.length} / {importDialog.cases.length}</span>
          </div>

          <div className="import-case-list">
            {importDialog.loading ? (
              <div className="import-empty"><LoaderCircle className="spin" size={22} />正在读取禅道用例</div>
            ) : filteredImportCases.length ? filteredImportCases.map((testCase) => (
              <label className="import-case-row" key={testCase.id}>
                <input type="checkbox" checked={importDialog.selectedIds.includes(testCase.id)} onChange={() => toggleImportCase(testCase.id)} />
                <span className="mono-cell">#{testCase.id}</span>
                <strong>{testCase.title}</strong>
                <span className="category-label">{testCase.status || "未标记"}</span>
              </label>
            )) : (
              <div className="import-empty"><FileText size={22} />暂无可导入用例</div>
            )}
          </div>

          <label className="overwrite-option">
            <input type="checkbox" checked={importDialog.overwrite} onChange={(event) => setImportDialog({ ...importDialog, overwrite: event.target.checked })} />
            <span><strong>覆盖已导入用例</strong><small>更新名称、步骤和预期结果，保留平台中的测试场景</small></span>
          </label>
        </Modal>
      )}
    </div>
  );
}
