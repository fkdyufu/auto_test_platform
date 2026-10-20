import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  CircleStop,
  LoaderCircle,
  MessageSquareText,
  Send,
  Wrench,
  X,
} from "lucide-react";
import { api, type DiagnosticConversation, type RunEvent, type RunResponse } from "../api";
import { buildTimelineItems } from "../run-events";
import { Markdown } from "./Markdown";

export interface DiagnosticTarget {
  testRunId: string;
  caseRunId: string;
  caseName: string;
  scenarioName: string;
}

const TOOL_LABELS: Record<string, string> = {
  browser_open: "打开页面",
  browser_inspect: "读取页面",
  browser_click: "点击元素",
  browser_fill: "填写内容",
  browser_select: "选择选项",
  browser_drag: "拖拽元素",
  browser_press: "发送按键",
  browser_wait: "等待页面",
  browser_screenshot: "保存截图",
  device_ssh_exec: "SSH 执行命令",
  device_telnet_exec: "Telnet 执行命令",
  device_serial_exec: "串口交互",
  device_http_request: "设备 API 请求",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function DiagnosticAssistant({
  productId,
  target,
  onClose,
}: {
  productId: string;
  target: DiagnosticTarget;
  onClose: () => void;
}) {
  const [conversation, setConversation] = useState<DiagnosticConversation | null>(null);
  const [activeRun, setActiveRun] = useState<RunResponse | null>(null);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const isRunning = conversation?.status === "running";

  const refreshConversation = async (id: string) => {
    const next = await api.getDiagnostic(productId, id);
    setConversation(next);
    return next;
  };

  const connectRun = (run: RunResponse, conversationId: string) => {
    eventSourceRef.current?.close();
    setActiveRun(run);
    if (run.status !== "queued" && run.status !== "running") return;
    const source = new EventSource(`/api/runs/${run.id}/events`);
    eventSourceRef.current = source;
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      setActiveRun((current) => {
        if (!current || current.id !== run.id || current.events.some((item) => item.id === event.id)) return current;
        const status = event.type === "run_state" && event.status ? event.status : current.status;
        if (["completed", "failed", "cancelled"].includes(status)) {
          source.close();
          void refreshConversation(conversationId).catch((refreshError) =>
            setError(refreshError instanceof Error ? refreshError.message : "刷新诊断结果失败"),
          );
        }
        return { ...current, status, events: [...current.events, event] };
      });
    };
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) setError("诊断事件连接已中断");
    };
  };

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    setConversation(null);
    setActiveRun(null);
    void (async () => {
      try {
        const existing = await api.getDiagnostics(productId, target.testRunId, target.caseRunId);
        const next = existing[0] || await api.createDiagnostic(productId, target.testRunId, target.caseRunId);
        if (disposed) return;
        setConversation(next);
        const recentRunId = next.activeRunId || next.messages.at(-1)?.runId;
        if (recentRunId) {
          const run = await api.getRun(recentRunId);
          if (!disposed) connectRun(run, next.id);
        }
      } catch (loadError) {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : "加载诊断对话失败");
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      eventSourceRef.current?.close();
    };
  }, [productId, target.testRunId, target.caseRunId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [conversation?.messages.length, activeRun?.events.length]);

  const streamingText = useMemo(() => {
    if (!isRunning || !activeRun) return "";
    return activeRun.events
      .filter((event) => event.type === "assistant_delta")
      .map((event) => event.message || "")
      .join("");
  }, [activeRun, isRunning]);
  const toolEvents = useMemo(() => {
    if (!activeRun) return [];
    const active = activeRun.status === "queued" || activeRun.status === "running";
    return buildTimelineItems(activeRun.events, active).filter((event) => event.toolState).slice(-6);
  }, [activeRun]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!conversation || !question.trim() || isRunning) return;
    try {
      setError("");
      const result = await api.sendDiagnosticMessage(productId, conversation.id, question.trim());
      setQuestion("");
      setConversation(result.conversation);
      connectRun(result.run, conversation.id);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "发送诊断问题失败");
    }
  };

  const cancel = async () => {
    if (!activeRun) return;
    try {
      await api.cancelRun(activeRun.id);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "取消诊断失败");
    }
  };

  return (
    <div className="modal-backdrop diagnostic-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal diagnostic-modal" role="dialog" aria-modal="true" aria-label="用例诊断助手">
        <header className="modal-header">
          <div className="diagnostic-title"><MessageSquareText size={18} /><h2>用例诊断助手</h2></div>
          <button type="button" className="icon-button static" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="diagnostic-context-bar">
          <div><strong>{target.caseName}</strong><span>{target.scenarioName}</span></div>
          <span className="diagnostic-tool-badge"><Wrench size={13} />设备工具已开放</span>
        </div>

        <div className="diagnostic-body">
          {loading ? (
            <div className="diagnostic-empty"><LoaderCircle className="spin" size={24} /><span>加载诊断上下文...</span></div>
          ) : conversation ? (
            <>
              <div className="diagnostic-messages" aria-live="polite">
                {!conversation.messages.length && (
                  <div className="diagnostic-empty">
                    <Bot size={28} strokeWidth={1.5} />
                    <span>输入你想进一步了解的问题</span>
                  </div>
                )}
                {conversation.messages.map((message) => (
                  <div className={`diagnostic-message ${message.role} ${message.error ? "error" : ""}`} key={message.id}>
                    <div className="diagnostic-message-meta">
                      <span>{message.role === "user" ? "你" : "诊断助手"}</span>
                      <time>{formatTime(message.createdAt)}</time>
                    </div>
                    {message.role === "assistant" && !message.error ? <Markdown text={message.content} /> : <p>{message.content}</p>}
                  </div>
                ))}
                {isRunning && (
                  <div className="diagnostic-message assistant streaming">
                    <div className="diagnostic-message-meta"><span>诊断助手</span><LoaderCircle className="spin" size={13} /></div>
                    {streamingText ? <Markdown text={streamingText} /> : <p>正在分析执行证据...</p>}
                  </div>
                )}
                <div ref={endRef} />
              </div>

              {toolEvents.length > 0 && (
                <div className="diagnostic-tools">
                  <div className="diagnostic-tools-heading"><Wrench size={14} /><strong>最近工具活动</strong></div>
                  <div className="diagnostic-tool-list">
                    {toolEvents.map((item) => (
                      <div className={`diagnostic-tool-item ${item.toolState}`} key={item.renderKey}>
                        {item.toolState === "running" ? <LoaderCircle className="spin" size={13} /> : item.toolState === "failed" ? <AlertCircle size={13} /> : <Check size={13} />}
                        <span>{TOOL_LABELS[item.tool || ""] || item.tool}</span>
                        <small>{item.message || (item.toolState === "running" ? "执行中" : "已完成")}</small>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="diagnostic-empty"><AlertCircle size={24} /><span>诊断对话无法加载</span></div>
          )}
        </div>

        {error && <div className="diagnostic-error"><AlertCircle size={14} /><span>{error}</span></div>}

        <form className="diagnostic-composer" onSubmit={send}>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="询问失败原因、证据含义，或让 Agent 继续检查设备..."
            rows={3}
            maxLength={8_000}
            disabled={!conversation || isRunning}
          />
          <div className="diagnostic-composer-actions">
            {isRunning ? (
              <button type="button" className="button secondary danger" onClick={() => void cancel()}>
                <CircleStop size={16} />取消
              </button>
            ) : (
              <button type="submit" className="button primary" disabled={!conversation || !question.trim()}>
                <Send size={16} />发送
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
