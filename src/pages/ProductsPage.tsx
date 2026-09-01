import { useEffect, useMemo, useState, type FormEvent } from "react";
import { FileText, Library, Package, Pencil, Plus, Trash2 } from "lucide-react";
import {
  api,
  type ProductInput,
  type ProductSummary,
  type TestCase,
  type TestCaseInput,
} from "../api";
import { InlineNotice, Modal, PageHeader, type Notice } from "../components/ui";

type ProductDialog = { id?: string; form: ProductInput } | null;
type CaseDialog = { id?: string; form: TestCaseInput } | null;

const EMPTY_PRODUCT: ProductInput = { name: "", description: "", zentaoId: "" };
const EMPTY_CASE: TestCaseInput = { name: "", steps: "", expectedResult: "" };

function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function ProductsPage() {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [cases, setCases] = useState<TestCase[]>([]);
  const [tab, setTab] = useState<"info" | "cases">("info");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [productDialog, setProductDialog] = useState<ProductDialog>(null);
  const [caseDialog, setCaseDialog] = useState<CaseDialog>(null);
  const [dialogError, setDialogError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === selectedId) || null,
    [products, selectedId],
  );

  const loadProducts = async (preferredId?: string) => {
    const nextProducts = await api.getProducts();
    setProducts(nextProducts);
    const candidate = preferredId || selectedId;
    setSelectedId(nextProducts.some((product) => product.id === candidate) ? candidate : nextProducts[0]?.id || "");
  };

  useEffect(() => {
    void (async () => {
      try {
        await loadProducts();
      } catch (error) {
        setNotice({ kind: "error", message: error instanceof Error ? error.message : "读取产品失败" });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setCases([]);
      return;
    }
    void api
      .getTestCases(selectedId)
      .then(setCases)
      .catch((error) => setNotice({ kind: "error", message: error instanceof Error ? error.message : "读取用例失败" }));
  }, [selectedId]);

  const openProductDialog = (product?: ProductSummary) => {
    setDialogError("");
    setProductDialog({
      id: product?.id,
      form: product
        ? { name: product.name, description: product.description, zentaoId: product.zentaoId }
        : { ...EMPTY_PRODUCT },
    });
  };

  const saveProduct = async (event: FormEvent) => {
    event.preventDefault();
    if (!productDialog) return;
    try {
      setSubmitting(true);
      setDialogError("");
      const saved = productDialog.id
        ? await api.updateProduct(productDialog.id, productDialog.form)
        : await api.createProduct(productDialog.form);
      await loadProducts(saved.id);
      setProductDialog(null);
      setNotice({ kind: "success", message: productDialog.id ? "产品已更新" : "产品已新增" });
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "保存产品失败");
    } finally {
      setSubmitting(false);
    }
  };

  const deleteProduct = async (product: ProductSummary) => {
    if (!window.confirm(`确定删除产品“${product.name}”吗？其用例和测试单将一并归档。`)) return;
    try {
      await api.deleteProduct(product.id);
      await loadProducts();
      setNotice({ kind: "success", message: "产品已删除" });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "删除产品失败" });
    }
  };

  const openCaseDialog = (testCase?: TestCase) => {
    setDialogError("");
    setCaseDialog({
      id: testCase?.id,
      form: testCase
        ? { name: testCase.name, steps: testCase.steps, expectedResult: testCase.expectedResult }
        : { ...EMPTY_CASE },
    });
  };

  const saveCase = async (event: FormEvent) => {
    event.preventDefault();
    if (!caseDialog || !selectedProduct) return;
    try {
      setSubmitting(true);
      setDialogError("");
      if (caseDialog.id) await api.updateTestCase(caseDialog.id, caseDialog.form);
      else await api.createTestCase(selectedProduct.id, caseDialog.form);
      setCases(await api.getTestCases(selectedProduct.id));
      await loadProducts(selectedProduct.id);
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
      await api.deleteTestCase(testCase.id);
      if (selectedProduct) {
        setCases(await api.getTestCases(selectedProduct.id));
        await loadProducts(selectedProduct.id);
      }
      setNotice({ kind: "success", message: "测试用例已删除" });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "删除测试用例失败" });
    }
  };

  return (
    <div className="page resource-page">
      <PageHeader
        icon={<Package size={19} />}
        title="产品管理"
        actions={
          <button className="button primary" onClick={() => openProductDialog()}>
            <Plus size={17} />
            新增产品
          </button>
        }
      />

      {notice && <InlineNotice notice={notice} onClose={() => setNotice(null)} />}

      <div className="master-detail-layout">
        <aside className="master-pane" aria-label="产品列表">
          <div className="pane-heading">
            <span>产品</span>
            <small>{products.length}</small>
          </div>
          <div className="master-list">
            {loading ? (
              <div className="list-empty">加载中...</div>
            ) : products.length ? (
              products.map((product) => (
                <button
                  key={product.id}
                  className={`master-row ${selectedId === product.id ? "active" : ""}`}
                  onClick={() => setSelectedId(product.id)}
                >
                  <span className="master-row-icon">
                    <Package size={16} />
                  </span>
                  <span className="master-row-content">
                    <strong>{product.name}</strong>
                    <small>{product.caseCount} 个用例 · {product.orderCount} 个测试单</small>
                  </span>
                </button>
              ))
            ) : (
              <div className="list-empty">暂无产品</div>
            )}
          </div>
        </aside>

        <section className="detail-pane">
          {selectedProduct ? (
            <>
              <header className="detail-header">
                <div>
                  <span className="detail-kicker">产品</span>
                  <h2>{selectedProduct.name}</h2>
                  <p>{selectedProduct.description || "暂无产品描述"}</p>
                </div>
                <div className="row-actions">
                  <button className="icon-action" onClick={() => openProductDialog(selectedProduct)} title="编辑产品">
                    <Pencil size={17} />
                  </button>
                  <button className="icon-action danger" onClick={() => deleteProduct(selectedProduct)} title="删除产品">
                    <Trash2 size={17} />
                  </button>
                </div>
              </header>

              <div className="tabs" role="tablist">
                <button className={tab === "info" ? "active" : ""} onClick={() => setTab("info")}>
                  基本信息
                </button>
                <button className={tab === "cases" ? "active" : ""} onClick={() => setTab("cases")}>
                  用例库 <span>{cases.length}</span>
                </button>
              </div>

              {tab === "info" ? (
                <div className="detail-content">
                  <dl className="definition-grid">
                    <div>
                      <dt>产品名称</dt>
                      <dd>{selectedProduct.name}</dd>
                    </div>
                    <div>
                      <dt>禅道 ID</dt>
                      <dd>{selectedProduct.zentaoId || "未配置"}</dd>
                    </div>
                    <div className="wide">
                      <dt>产品描述</dt>
                      <dd>{selectedProduct.description || "暂无产品描述"}</dd>
                    </div>
                    <div>
                      <dt>创建日期</dt>
                      <dd>{formatDate(selectedProduct.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>最后更新</dt>
                      <dd>{formatDate(selectedProduct.updatedAt)}</dd>
                    </div>
                  </dl>
                </div>
              ) : (
                <div className="detail-content cases-content">
                  <div className="content-toolbar">
                    <div>
                      <Library size={17} />
                      <strong>测试用例</strong>
                    </div>
                    <button className="button primary compact" onClick={() => openCaseDialog()}>
                      <Plus size={16} />
                      新增用例
                    </button>
                  </div>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>名称</th>
                          <th>步骤</th>
                          <th>预期结果</th>
                          <th aria-label="操作" />
                        </tr>
                      </thead>
                      <tbody>
                        {cases.map((testCase) => (
                          <tr key={testCase.id}>
                            <td className="mono-cell" title={testCase.id}>{shortId(testCase.id)}</td>
                            <td className="name-cell">{testCase.name}</td>
                            <td className="truncate-cell">{testCase.steps}</td>
                            <td className="truncate-cell">{testCase.expectedResult}</td>
                            <td>
                              <div className="row-actions">
                                <button className="icon-action" onClick={() => openCaseDialog(testCase)} title="编辑用例">
                                  <Pencil size={16} />
                                </button>
                                <button className="icon-action danger" onClick={() => deleteCase(testCase)} title="删除用例">
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {!cases.length && (
                          <tr>
                            <td colSpan={5} className="table-empty">
                              <FileText size={22} />
                              暂无测试用例
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="detail-empty">
              <Package size={28} />
              <span>选择一个产品</span>
            </div>
          )}
        </section>
      </div>

      {productDialog && (
        <Modal
          title={productDialog.id ? "编辑产品" : "新增产品"}
          onClose={() => setProductDialog(null)}
          onSubmit={saveProduct}
          submitting={submitting}
        >
          {dialogError && <div className="form-error">{dialogError}</div>}
          <label className="field">
            <span>产品名称</span>
            <input
              value={productDialog.form.name}
              onChange={(event) => setProductDialog({ ...productDialog, form: { ...productDialog.form, name: event.target.value } })}
              autoFocus
            />
          </label>
          <label className="field">
            <span>产品描述</span>
            <textarea
              value={productDialog.form.description}
              onChange={(event) => setProductDialog({ ...productDialog, form: { ...productDialog.form, description: event.target.value } })}
              rows={4}
            />
          </label>
          <label className="field">
            <span>禅道 ID</span>
            <input
              value={productDialog.form.zentaoId}
              onChange={(event) => setProductDialog({ ...productDialog, form: { ...productDialog.form, zentaoId: event.target.value } })}
            />
          </label>
        </Modal>
      )}

      {caseDialog && (
        <Modal
          title={caseDialog.id ? "编辑测试用例" : "新增测试用例"}
          onClose={() => setCaseDialog(null)}
          onSubmit={saveCase}
          submitting={submitting}
        >
          {dialogError && <div className="form-error">{dialogError}</div>}
          <label className="field">
            <span>用例名称</span>
            <input
              value={caseDialog.form.name}
              onChange={(event) => setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, name: event.target.value } })}
              autoFocus
            />
          </label>
          <label className="field">
            <span>测试步骤</span>
            <textarea
              value={caseDialog.form.steps}
              onChange={(event) => setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, steps: event.target.value } })}
              rows={7}
            />
          </label>
          <label className="field">
            <span>预期结果</span>
            <textarea
              value={caseDialog.form.expectedResult}
              onChange={(event) =>
                setCaseDialog({ ...caseDialog, form: { ...caseDialog.form, expectedResult: event.target.value } })
              }
              rows={5}
            />
          </label>
        </Modal>
      )}
    </div>
  );
}
