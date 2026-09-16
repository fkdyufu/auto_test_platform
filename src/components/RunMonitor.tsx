import { useEffect, useMemo, useRef } from "react";
import { AlertCircle, Bot, Check, CircleStop, Clock3, LoaderCircle, TestTubeDiagonal } from "lucide-react";
import type { RunEvent, RunStatus } from "../api";
import { buildTimelineItems, type TimelineItem } from "../run-events";

const TOOL_LABELS: Record<string, string> = {
  browser_open: "打开页面",
  browser_inspect: "读取页面",
  browser_click: "点击元素",
  browser_fill: "填写内容",
  browser_select: "选择选项",
  browser_press: "发送按键",
  browser_wait: "等待页面",
  browser_screenshot: "保存截图",
  device_ssh_exec: "SSH 执行命令",
  device_telnet_exec: "Telnet 执行命令",
  device_serial_exec: "串口交互",
  device_http_request: "设备 API 请求",
  finish_test: "提交结论",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function TimelineEvent({ event }: { event: TimelineItem }) {
  const isTool = Boolean(event.toolState);
  const isError = event.type === "error" || event.toolState === "failed" || (!isTool && event.error);
  const isInterrupted = event.toolState === "interrupted";
  const label = isTool ? TOOL_LABELS[event.tool || ""] || event.tool : event.message;
  const executionContext = event.caseName || event.scenarioName;
  const iconClass = event.toolState ? `tool_${event.toolState}` : event.type;

  return (
    <div className={`timeline-row ${isError ? "error" : ""} ${isInterrupted ? "interrupted" : ""}`}>
      <span className="timeline-time">{formatTime(event.timestamp)}</span>
      <span className={`timeline-icon ${iconClass}`}>
        {isError ? (
          <AlertCircle size={14} />
        ) : event.toolState === "running" ? (
          <LoaderCircle className="spin" size={14} />
        ) : event.toolState === "completed" ? (
          <Check size={14} />
        ) : event.toolState === "interrupted" ? (
          <CircleStop size={14} />
        ) : event.type === "result" || event.type === "case_result" || event.type === "scenario_result" ? (
          <TestTubeDiagonal size={14} />
        ) : (
          <Clock3 size={14} />
        )}
      </span>
      <div className="timeline-content">
        {isTool && executionContext && <span className="case-context">{executionContext}</span>}
        <strong>{label || "状态更新"}</strong>
        {isTool && event.toolState !== "running" && event.message && <p>{event.message}</p>}
        {isTool && event.toolOutput && <details className="tool-output-details"><summary>工具输出</summary><pre>{event.toolOutput}</pre></details>}
      </div>
    </div>
  );
}

export function RunMonitor({
  events,
  status,
  emptyText = "等待任务",
}: {
  events: RunEvent[];
  status: RunStatus | null;
  emptyText?: string;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const isActive = status === "queued" || status === "running";
  const result = [...events].reverse().find((event) => event.type === "result");
  const assistantText = events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => event.message || "")
    .join("");
  const visibleEvents = useMemo(() => buildTimelineItems(events, isActive), [events, isActive]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [events.length]);

  return (
    <div className="execution-log" aria-live="polite">
      {!events.length ? (
        <div className="empty-state">
          <Bot size={28} strokeWidth={1.5} />
          <span>{emptyText}</span>
        </div>
      ) : (
        <>
          {result && (
            <div className={`result-block ${result.outcome}`}>
              {result.outcome === "passed" ? <Check size={20} /> : <AlertCircle size={20} />}
              <div>
                <strong>{result.outcome === "passed" ? "测试通过" : "测试失败"}</strong>
                <p>{result.message}</p>
              </div>
            </div>
          )}
          <div className="timeline">
            {visibleEvents.map((event) => (
              <TimelineEvent key={event.renderKey} event={event} />
            ))}
            {assistantText && isActive && (
              <div className="agent-output">
                <Bot size={16} />
                <p>{assistantText}</p>
              </div>
            )}
            <div ref={endRef} />
          </div>
        </>
      )}
    </div>
  );
}
