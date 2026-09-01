interface ToolEvent {
  tool?: string;
  args?: unknown;
}

export function sanitizeToolEvent<T extends ToolEvent>(event: T): T {
  if (event.tool !== "browser_fill" || !event.args || typeof event.args !== "object") return event;
  return {
    ...event,
    args: { ...(event.args as Record<string, unknown>), value: "[REDACTED]" },
  };
}
