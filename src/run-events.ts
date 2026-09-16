import type { RunEvent } from "./api";

export type ToolState = "running" | "completed" | "failed" | "interrupted";

export interface TimelineItem extends RunEvent {
  renderKey: string;
  toolState?: ToolState;
}

function isHiddenEvent(event: RunEvent): boolean {
  return event.type === "assistant_delta" || event.type === "assistant" || event.type === "agent_info";
}

export function buildTimelineItems(events: RunEvent[], isActive: boolean): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolIndexes = new Map<string, number>();

  for (const event of events) {
    if (isHiddenEvent(event)) continue;

    if (event.type === "tool_start") {
      const renderKey = event.toolCallId || `tool-start-${event.id}`;
      toolIndexes.set(renderKey, items.length);
      items.push({ ...event, renderKey, toolState: "running" });
      continue;
    }

    if (event.type === "tool_end") {
      const renderKey = event.toolCallId || `tool-end-${event.id}`;
      const startIndex = event.toolCallId ? toolIndexes.get(event.toolCallId) : undefined;
      const toolState: ToolState = event.error ? "failed" : "completed";

      if (startIndex !== undefined) {
        const start = items[startIndex];
        items[startIndex] = {
          ...start,
          tool: event.tool || start.tool,
          message: event.message,
          toolOutput: event.toolOutput,
          error: event.error,
          renderKey,
          toolState,
        };
      } else {
        items.push({ ...event, renderKey, toolState });
      }
      continue;
    }

    items.push({ ...event, renderKey: `event-${event.id}` });
  }

  if (!isActive) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item.toolState === "running") {
        items[index] = {
          ...item,
          message: "任务结束前未收到工具完成事件",
          toolState: "interrupted",
        };
      }
    }
  }

  return items;
}
