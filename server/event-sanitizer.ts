interface ToolEvent {
  tool?: string;
  args?: unknown;
}

export function sanitizeToolEvent<T extends ToolEvent>(event: T): T {
  if (!event.args || typeof event.args !== "object") return event;
  if (event.tool?.startsWith("platform_")) {
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(password|apiKey|token)$/i.test(key) ? "[REDACTED]" : redact(item)]));
    };
    return { ...event, args: redact(event.args) };
  }
  if (event.tool === "browser_fill") {
    return {
      ...event,
      args: { ...(event.args as Record<string, unknown>), value: "[REDACTED]" },
    };
  }
  if (event.tool === "device_http_request") {
    const args = event.args as Record<string, unknown>;
    const sensitiveHeader = /^(authorization|cookie|proxy-authorization|x-api-key)$/i;
    return {
      ...event,
      args: {
        ...args,
        headers: Array.isArray(args.headers)
          ? args.headers.map((header) => {
              if (!header || typeof header !== "object") return header;
              const value = header as Record<string, unknown>;
              return sensitiveHeader.test(String(value.name || "")) ? { ...value, value: "[REDACTED]" } : value;
            })
          : args.headers,
      },
    };
  }
  return event;
}
