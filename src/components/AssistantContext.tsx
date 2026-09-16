import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AssistantPageContext, ProductSummary } from "../api";
import { applyDraftPatch } from "../../shared/assistant-draft";
import { PlatformAssistant } from "./PlatformAssistant";

interface PageRegistration {
  context: AssistantPageContext;
  productId: string;
  apply?: (draft: Record<string, unknown>) => void;
  refresh?: () => Promise<void>;
}
interface AssistantContextValue {
  productId: string;
  register: (registration: PageRegistration) => () => void;
}
const AssistantContext = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({ product, page, children, onAssetsChanged }: {
  product: ProductSummary | null;
  page: string;
  children: ReactNode;
  onAssetsChanged: () => Promise<void>;
}) {
  const [registration, setRegistration] = useState<PageRegistration | null>(null);
  const registrationRef = useRef<PageRegistration | null>(null);
  const register = useCallback((next: PageRegistration) => {
    registrationRef.current = next;
    setRegistration(next);
    return () => {
      if (registrationRef.current === next) {
        registrationRef.current = null;
        setRegistration(null);
      }
    };
  }, []);
  const titles: Record<string, string> = { products: "产品概览", resources: "资源与场景", cases: "用例库", orders: "测试单", run: "自由执行", settings: "设置" };
  const current = registration && registration.productId === product?.id && registration.context.page === page ? registration : null;
  const context: AssistantPageContext = current?.context || { page, title: titles[page] || page };
  const getCurrent = () => {
    const item = registrationRef.current;
    return item && item.productId === product?.id && item.context.page === page ? item : null;
  };
  const prepareDraft = (token: string, values: Record<string, unknown>) => {
    const item = getCurrent();
    if (!item?.context.assetKind || !item.context.draft || !item.apply || item.context.draftToken !== token) throw new Error("当前编辑表单已变化或关闭，请让助手重新生成修改");
    const next = applyDraftPatch(item.context.assetKind, item.context.draft, values);
    return () => {
      if (getCurrent()?.context.draftToken !== token) throw new Error("当前编辑表单已变化，未应用修改");
      item.apply!(next);
    };
  };
  const refreshAssets = async () => {
    await Promise.all([onAssetsChanged(), getCurrent()?.refresh?.()]);
  };
  return <AssistantContext.Provider value={{ productId: product?.id || "", register }}>
    {children}
    <PlatformAssistant key={product?.id || "none"} product={product} context={context} prepareDraft={prepareDraft} onAssetsChanged={refreshAssets} />
  </AssistantContext.Provider>;
}

export function useAssistantPage(context: Omit<AssistantPageContext, "draftToken">, apply?: (draft: Record<string, unknown>) => void, refresh?: () => Promise<void>) {
  const provider = useContext(AssistantContext);
  const callbackRef = useRef({ apply, refresh });
  callbackRef.current = { apply, refresh };
  const encoded = JSON.stringify(context);
  const register = provider?.register;
  const productId = provider?.productId || "";
  useEffect(() => {
    if (!register) return;
    const next = JSON.parse(encoded) as AssistantPageContext;
    if (next.draft) next.draftToken = `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return register({
      context: next, productId,
      apply: (draft) => callbackRef.current.apply?.(draft),
      refresh: () => callbackRef.current.refresh?.() || Promise.resolve(),
    });
  }, [encoded, productId, register]);
}
