import { useEffect, useState, type FormEvent } from "react";
import { ClipboardList, Library, Link2, Package, Pencil, Plus, Trash2 } from "lucide-react";
import {
  api,
  type ProductInput,
  type ProductSummary,
} from "../api";
import { AutoResizeTextarea, InlineNotice, Modal, PageHeader, type Notice } from "../components/ui";

type ProductDialog = { id?: string; form: ProductInput } | null;

const EMPTY_PRODUCT: ProductInput = { name: "", description: "", zentaoId: "" };

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function ProductsPage({
  product,
  onProductsChanged,
}: {
  product: ProductSummary | null;
  onProductsChanged: (preferredId?: string) => Promise<void>;
}) {
  const [notice, setNotice] = useState<Notice>(null);
  const [productDialog, setProductDialog] = useState<ProductDialog>(null);
  const [dialogError, setDialogError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setProductDialog(null);
    setNotice(null);
  }, [product?.id]);

  const openProductDialog = (current?: ProductSummary) => {
    setDialogError("");
    setProductDialog({
      id: current?.id,
      form: current
        ? { name: current.name, description: current.description, zentaoId: current.zentaoId }
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
      await onProductsChanged(saved.id);
      setProductDialog(null);
      setNotice({ kind: "success", message: productDialog.id ? "产品已更新" : "产品已新增并切换" });
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : "保存产品失败");
    } finally {
      setSubmitting(false);
    }
  };

  const deleteProduct = async () => {
    if (!product || !window.confirm(`确定删除产品“${product.name}”吗？其全部资产将一并归档。`)) return;
    try {
      await api.deleteProduct(product.id);
      await onProductsChanged();
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "删除产品失败" });
    }
  };

  return (
    <div className="page product-page">
      <PageHeader
        icon={<Package size={19} />}
        title="产品概览"
        actions={<button className="button primary" onClick={() => openProductDialog()}><Plus size={17} />新增产品</button>}
      />

      {notice && <InlineNotice notice={notice} onClose={() => setNotice(null)} />}

      {product ? (
        <div className="product-detail-surface">
          <header className="detail-header">
            <div>
              <span className="detail-kicker">当前产品</span>
              <h2>{product.name}</h2>
              <p>{product.description || "暂无产品描述"}</p>
            </div>
            <div className="row-actions">
              <button className="icon-action" onClick={() => openProductDialog(product)} title="编辑当前产品"><Pencil size={17} /></button>
              <button className="icon-action danger" onClick={() => void deleteProduct()} title="删除当前产品"><Trash2 size={17} /></button>
            </div>
          </header>

          <div className="detail-content">
            <div className="product-stats">
              <div className="product-stat">
                <span className="product-stat-icon"><Library size={18} /></span>
                <div><span>用例</span><strong>{product.caseCount}</strong></div>
              </div>
              <div className="product-stat">
                <span className="product-stat-icon"><ClipboardList size={18} /></span>
                <div><span>测试单</span><strong>{product.orderCount}</strong></div>
              </div>
              <div className="product-stat">
                <span className="product-stat-icon"><Link2 size={18} /></span>
                <div><span>禅道产品 ID</span><strong className={product.zentaoId ? "" : "unset"}>{product.zentaoId || "未配置"}</strong></div>
              </div>
            </div>
            <dl className="definition-grid">
              <div className="wide"><dt>产品描述</dt><dd>{product.description || "暂无产品描述"}</dd></div>
              <div><dt>创建日期</dt><dd>{formatDate(product.createdAt)}</dd></div>
              <div><dt>最后更新</dt><dd>{formatDate(product.updatedAt)}</dd></div>
            </dl>
          </div>
        </div>
      ) : (
        <div className="detail-empty"><Package size={28} /><span>请先新增产品</span></div>
      )}

      {productDialog && (
        <Modal title={productDialog.id ? "编辑产品" : "新增产品"} onClose={() => setProductDialog(null)} onSubmit={saveProduct} submitting={submitting}>
          {dialogError && <div className="form-error">{dialogError}</div>}
          <label className="field"><span>产品名称</span><input value={productDialog.form.name} onChange={(event) => setProductDialog({ ...productDialog, form: { ...productDialog.form, name: event.target.value } })} autoFocus /></label>
          <label className="field"><span>产品描述</span><AutoResizeTextarea value={productDialog.form.description} onChange={(event) => setProductDialog({ ...productDialog, form: { ...productDialog.form, description: event.target.value } })} rows={4} /></label>
          <label className="field"><span>禅道产品 ID</span><input inputMode="numeric" value={productDialog.form.zentaoId} onChange={(event) => setProductDialog({ ...productDialog, form: { ...productDialog.form, zentaoId: event.target.value } })} /></label>
        </Modal>
      )}

    </div>
  );
}
