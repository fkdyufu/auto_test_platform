export class AgentInactivityError extends Error {
  constructor(timeoutMs: number) {
    super(`Agent 连续 ${Math.ceil(timeoutMs / 1000)} 秒没有模型或工具事件，已自动终止`);
    this.name = "AgentInactivityError";
  }
}

export function createInactivityGuard(timeoutMs: number, onTimeout: () => void | Promise<void>) {
  let timer: NodeJS.Timeout | undefined;
  let active = true;
  let rejectTimeout: (error: AgentInactivityError) => void = () => undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });

  const touch = () => {
    if (!active) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      active = false;
      timer = undefined;
      void Promise.resolve().then(onTimeout).catch(() => undefined);
      rejectTimeout(new AgentInactivityError(timeoutMs));
    }, timeoutMs);
  };

  const dispose = () => {
    active = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return { timeout, touch, dispose };
}

export function createTextDeltaBatcher(
  emit: (text: string) => void,
  delayMs: number,
) {
  let buffer = "";
  let timer: NodeJS.Timeout | undefined;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!buffer) return;
    const text = buffer;
    buffer = "";
    emit(text);
  };

  const push = (text: string) => {
    buffer += text;
    if (timer) return;
    timer = setTimeout(flush, delayMs);
    timer.unref();
  };

  return { push, flush };
}
