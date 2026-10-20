import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, Bot, Check, CircleStop, LoaderCircle, MessageSquareText, Plus, Send, Wrench, X } from "lucide-react";
import { api, type AssistantConversation, type AssistantPageContext, type AssistantProposal, type ProductSummary, type RunEvent, type RunResponse } from "../api";
import { buildTimelineItems } from "../run-events";

const KIND_LABELS = { case: "用例", scenario: "场景", device: "设备", order: "测试单" };
const FIELD_LABELS: Record<string, string> = { name: "名称", scenarioId: "场景", precondition: "前置条件", steps: "步骤", expectedResult: "预期结果", stepRows: "用例步骤", description: "描述", category: "功能分类", roles: "设备角色", parameters: "场景参数", setupInstructions: "搭建要求", verificationInstructions: "验证要求", cleanupInstructions: "清理要求", caseIds: "关联用例", template: "设备类型", controlInterfaces: "控制接口" };
const TOOL_LABELS: Record<string, string> = { platform_context: "读取页面上下文", platform_query: "查询资产", platform_get: "读取资产详情", platform_propose_changes: "生成资产变更预览", platform_propose_draft: "生成表单修改预览", platform_lab: "读取物理环境", platform_propose_lab: "生成接线变更预览", device_ssh_exec: "SSH 执行命令", device_telnet_exec: "Telnet 执行命令", device_serial_exec: "串口交互", device_http_request: "设备 API 请求" };
const display = (value: unknown) => value === undefined || value === null || value === "" ? "（空）" : typeof value === "string" ? value : JSON.stringify(value, null, 2);

function ProposalPreview({ proposal }: { proposal: AssistantProposal }) {
  if (proposal.target === "lab") {
    return <ul className="assistant-lab-changes">{proposal.labPreview?.changes.map((change, index) => <li key={index} className={change.type}>
      {change.before === undefined ? change.text : <details>
        <summary>{change.text}</summary>
        <div className="assistant-field-diff">
          <div className="before"><small>修改前</small><pre>{change.before}</pre></div>
          <div className="after"><small>修改后</small><pre>{change.after}</pre></div>
        </div>
      </details>}
    </li>)}</ul>;
  }
  const differences = proposal.target === "draft"
    ? [{ kind: proposal.context!.assetKind!, id: "draft", name: proposal.context?.title || "当前表单", before: proposal.context?.draft || null, after: { ...proposal.context?.draft, ...proposal.values } }]
    : proposal.preview?.differences || [];
  const ignored = new Set(["id", "productId", "createdAt", "updatedAt", "source", "lastImportedAt", "zentaoCaseId", "archivedAt", "isDefault", "templateName"]);
  return <div className="assistant-differences">{differences.map((difference) => {
    const fields = [...new Set([...Object.keys(difference.before || {}), ...Object.keys(difference.after || {})])].filter((key) => !ignored.has(key) && JSON.stringify(difference.before?.[key]) !== JSON.stringify(difference.after?.[key]));
    return <details key={`${difference.kind}-${difference.id}`}>
      <summary><span>{KIND_LABELS[difference.kind]} · {difference.name}</span><small>{!difference.before ? "新增" : !difference.after ? "删除" : `${fields.length} 个字段`}</small></summary>
      {fields.map((field) => <div className="assistant-field-diff" key={field}>
        <strong>{FIELD_LABELS[field] || field}</strong>
        <div className="before"><small>修改前</small><pre>{display(difference.before?.[field])}</pre></div>
        <div className="after"><small>修改后</small><pre>{display(difference.after?.[field])}</pre></div>
      </div>)}
    </details>;
  })}</div>;
}

export function PlatformAssistant({ product, context, request, prepareDraft, onAssetsChanged }: {
  product: ProductSummary | null;
  context: AssistantPageContext;
  request?: { message: string; id: number } | null;
  prepareDraft: (token: string, values: Record<string, unknown>) => () => void;
  onAssetsChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(() => sessionStorage.getItem("platform-assistant.open") === "true");
  const [conversations, setConversations] = useState<Pick<AssistantConversation, "id" | "title" | "status" | "createdAt" | "updatedAt">[]>([]);
  const [conversation, setConversation] = useState<AssistantConversation | null>(null);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [busyProposal, setBusyProposal] = useState("");
  const [error, setError] = useState("");
  const sourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const running = conversation?.status === "running";
  const storageKey = `platform-assistant.conversation.${product?.id || "none"}`;

  const refresh = async (id: string) => {
    if (!product) return;
    const sequence = ++refreshSequenceRef.current;
    const next = await api.getAssistantConversation(product.id, id);
    if (mountedRef.current && sequence === refreshSequenceRef.current) setConversation((current) => current?.id === id ? next : current);
    return next;
  };
  const connect = (nextRun: RunResponse, id: string) => {
    sourceRef.current?.close();
    setRun(nextRun);
    if (!["queued", "running"].includes(nextRun.status)) return;
    const source = new EventSource(`/api/runs/${nextRun.id}/events`);
    sourceRef.current = source;
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      setRun((current) => !current || current.id !== nextRun.id || current.events.some((item) => item.id === event.id) ? current : { ...current, events: [...current.events, event], status: event.type === "run_state" && event.status ? event.status : current.status });
      if (event.type === "tool_end") void refresh(id).catch(() => undefined);
      if (event.type === "run_state" && ["completed", "failed", "cancelled"].includes(event.status || "")) {
        source.close();
        void refresh(id).catch((reason) => setError(reason instanceof Error ? reason.message : "读取回复失败"));
      }
    };
    source.onerror = () => {
      // EventSource reconnects and the server replays missed events.
      void refresh(id).then((next) => { if (next?.status === "idle") source.close(); }).catch(() => undefined);
    };
  };
  const load = async (id: string) => {
    if (!product) return;
    const sequence = ++loadSequenceRef.current;
    ++refreshSequenceRef.current;
    sourceRef.current?.close();
    setLoading(true);
    setError("");
    setRun(null);
    try {
      const next = await api.getAssistantConversation(product.id, id);
      if (!mountedRef.current || sequence !== loadSequenceRef.current) return;
      setConversation(next);
      localStorage.setItem(storageKey, next.id);
      const runId = next.activeRunId || next.messages.at(-1)?.runId;
      if (runId) {
        const nextRun = await api.getRun(runId);
        if (mountedRef.current && sequence === loadSequenceRef.current) connect(nextRun, next.id);
      }
    } catch (reason) {
      if (mountedRef.current && sequence === loadSequenceRef.current) setError(reason instanceof Error ? reason.message : "加载对话失败");
    } finally { if (mountedRef.current && sequence === loadSequenceRef.current) setLoading(false); }
  };
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; ++loadSequenceRef.current; ++refreshSequenceRef.current; sourceRef.current?.close(); };
  }, []);
  useEffect(() => {
    if (!open || !product || conversation) return;
    let disposed = false;
    setLoading(true);
    void (async () => {
      try {
        const list = await api.getAssistantConversations(product.id);
        if (disposed) return;
        setConversations(list);
        const stored = localStorage.getItem(storageKey);
        const id = list.find((item) => item.id === stored)?.id || list[0]?.id;
        if (id) await load(id);
        else {
          const next = await api.createAssistantConversation(product.id);
          if (disposed) return;
          setConversation(next);
          setConversations([next]);
          localStorage.setItem(storageKey, next.id);
        }
      } catch (reason) { if (!disposed) setError(reason instanceof Error ? reason.message : "加载助手失败"); }
      finally { if (!disposed) setLoading(false); }
    })();
    return () => { disposed = true; };
  }, [open, product?.id]);
  useEffect(() => {
    if (!open || !product) return;
    void api.getAssistantConversations(product.id).then((list) => { if (mountedRef.current) setConversations(list); }).catch(() => undefined);
  }, [open, conversation?.updatedAt]);
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: "nearest" }); }, [open, conversation?.messages.length, run?.events.length]);
  const toggle = (value: boolean) => { setOpen(value); sessionStorage.setItem("platform-assistant.open", String(value)); };
  // A request made before this panel mounted (e.g. for another product) is not replayed.
  const handledRequestRef = useRef(request?.id);
  useEffect(() => {
    if (!request || request.id === handledRequestRef.current) return;
    handledRequestRef.current = request.id;
    toggle(true);
    setQuestion(request.message);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [request?.id]);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!product || !conversation || !question.trim() || running || sending || busyProposal) return;
    setSending(true); setError("");
    try {
      const next = await api.sendAssistantMessage(product.id, conversation.id, question.trim(), context);
      if (!mountedRef.current) return;
      setQuestion(""); setConversation(next.conversation); connect(next.run, next.conversation.id);
    } catch (reason) { if (mountedRef.current) setError(reason instanceof Error ? reason.message : "发送失败"); }
    finally { if (mountedRef.current) setSending(false); }
  };
  const newConversation = async () => {
    if (!product) return;
    setError(""); setLoading(true);
    try {
      const next = await api.createAssistantConversation(product.id);
      if (!mountedRef.current) return;
      sourceRef.current?.close(); setRun(null); setConversation(next); setQuestion(""); localStorage.setItem(storageKey, next.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建对话失败"); }
    finally { if (mountedRef.current) setLoading(false); }
  };
  const resolve = async (proposal: AssistantProposal, decision: "apply" | "reject") => {
    if (!product || !conversation) return;
    setBusyProposal(proposal.id); setError("");
    try {
      const apply = decision === "apply" && proposal.target === "draft" ? prepareDraft(proposal.context?.draftToken || "", proposal.values || {}) : null;
      const next = await api.resolveAssistantProposal(product.id, conversation.id, proposal.id, decision, apply ? context.draftToken : undefined);
      if (mountedRef.current) { setConversation(next); apply?.(); }
      if (decision === "apply" && proposal.target !== "draft" && mountedRef.current) await onAssetsChanged();
    } catch (reason) { if (mountedRef.current) setError(reason instanceof Error ? reason.message : "处理变更失败"); }
    finally { if (mountedRef.current) setBusyProposal(""); }
  };
  const streaming = running ? run?.events.filter((event) => event.type === "assistant_delta").map((event) => event.message || "").join("") : "";
  const tools = run ? buildTimelineItems(run.events, running === true).filter((item) => item.toolState).slice(-4) : [];

  return <>
    {!open && <button type="button" className="assistant-launcher" title="打开 AI 助手" aria-label="打开 AI 助手" onClick={() => toggle(true)}><MessageSquareText size={23} /></button>}
    {open && <aside className="platform-assistant" role="complementary" aria-label="AI 助手">
      <header className="assistant-header"><div><Bot size={19} /><h2>AI 助手</h2></div><div>
        <button type="button" className="icon-action" title="新建对话" disabled={!product || loading || sending || !!busyProposal} onClick={() => void newConversation()}><Plus size={18} /></button>
        <button type="button" className="icon-action" title="收起助手" onClick={() => toggle(false)}><X size={18} /></button>
      </div></header>
      <div className="assistant-context"><strong>{product?.name || "未选择产品"}</strong><span>{context.title}</span></div>
      {conversations.length > 0 && <select className="assistant-history" aria-label="助手对话历史" value={conversation?.id || ""} disabled={loading || sending || !!busyProposal} onChange={(event) => void load(event.target.value)}>{conversations.map((item) => <option key={item.id} value={item.id}>{item.title}{item.status === "running" ? " · 处理中" : ""}</option>)}</select>}
      <div className="assistant-content" aria-live="polite">
        {loading && <div className="assistant-empty"><LoaderCircle size={22} className="spin" />加载对话...</div>}
        {!loading && !conversation?.messages.length && <div className="assistant-empty"><Bot size={30} />{product ? "可讨论平台内容，也可操作当前产品设备" : "请先选择产品"}</div>}
        {conversation?.messages.map((message) => <div key={message.id} className={`assistant-message ${message.role} ${message.error ? "error" : ""}`}>
          <div className="assistant-message-meta"><span>{message.role === "user" ? "你" : "AI 助手"}</span><time>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</time></div>
          {message.context && <small className="assistant-message-context">{message.context.title}</small>}
          <p>{message.content}</p>
          {message.role === "assistant" && conversation.proposals.filter((proposal) => proposal.runId === message.runId).map((proposal) => <section key={proposal.id} className="assistant-proposal">
            <strong>{proposal.summary}</strong>
            <span className={`assistant-proposal-status ${proposal.status}`}>{proposal.status === "pending" ? proposal.target === "draft" ? "待应用到表单" : "待确认保存" : proposal.status === "applied" ? proposal.target === "draft" ? "已应用到表单" : "已保存" : "已拒绝"}</span>
            <ProposalPreview proposal={proposal} />
            {proposal.status === "pending" && <div className="assistant-proposal-actions">
              <button type="button" className="button secondary compact" disabled={running || sending || !!busyProposal} onClick={() => void resolve(proposal, "reject")}><X size={14} />拒绝</button>
              <button type="button" className="button primary compact" disabled={running || sending || !!busyProposal} onClick={() => void resolve(proposal, "apply")}>{busyProposal === proposal.id ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{proposal.target === "draft" ? "应用到表单" : "确认保存"}</button>
            </div>}
          </section>)}
        </div>)}
        {running && <div className="assistant-message assistant"><div className="assistant-message-meta"><span>AI 助手</span><LoaderCircle className="spin" size={13} /></div><p>{streaming || "正在处理..."}</p></div>}
        <div ref={endRef} />
      </div>
      {tools.length > 0 && <div className="assistant-tools">{tools.map((item) => <div className="assistant-tool" key={item.renderKey}>
        <div className="assistant-tool-heading" title={item.message || ""}>{item.toolState === "running" ? <LoaderCircle className="spin" size={12} /> : item.toolState === "failed" ? <AlertCircle size={12} /> : <Wrench size={12} />}<span>{TOOL_LABELS[item.tool || ""] || item.tool}</span></div>
        {item.toolState !== "running" && (item.toolOutput || item.message) && <details><summary>查看结果</summary><pre>{item.toolOutput || item.message}</pre></details>}
      </div>)}</div>}
      {error && <div className="assistant-error" role="alert"><AlertCircle size={14} /><span>{error}</span><button type="button" className="icon-action" title="关闭提示" onClick={() => setError("")}><X size={14} /></button></div>}
      <form className="assistant-composer" onSubmit={send}>
        <textarea ref={inputRef} aria-label="助手消息" placeholder="输入消息..." rows={3} maxLength={8000} value={question} onChange={(event) => setQuestion(event.target.value)} disabled={!conversation || sending || loading} />
        <div><small>{question.length} / 8000</small>{running ? <button type="button" className="button secondary compact danger" onClick={() => { if (run) void api.cancelRun(run.id).catch((reason) => setError(reason.message)); }}><CircleStop size={15} />取消</button> : <button type="submit" className="button primary compact" disabled={!conversation || !question.trim() || sending || loading || !!busyProposal}>{sending ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}发送</button>}</div>
      </form>
    </aside>}
  </>;
}
