import { Telnet } from "telnet-client";
import type { ControlInterface } from "./catalog-store.js";

export const TELNET_PROMPT = /(?:^|\r?\n)(?:[^\r\n]*[#$>]|\[[^\r\n\]]+\])\s*$/;
const CLI_ERROR = /(?:^|\n)\s*(?:Error:\s*(?:Unrecognized command|Wrong parameter|Incomplete command|Too many parameters|Ambiguous command|The command|Permission|Invalid)|%\s*(?:Invalid input|Unknown command|Incomplete command|Ambiguous command|Error))/i;

class TelnetCommandError extends Error {}
interface Entry { connection: Telnet; connected: boolean; queue: Promise<void> }

export class TelnetSessionPool {
  private readonly entries = new Map<string, Entry>();
  private readonly interrupted = new Set<string>();
  private readonly shutdown = new AbortController();

  async execute(key: string, control: ControlInterface, target: { host: string; port: number }, command: string, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.shutdown.signal.aborted) throw new Error("Telnet 工具会话已关闭");
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { connection: new Telnet(), connected: false, queue: Promise.resolve() };
      this.entries.set(key, entry);
    }
    const current = entry;
    const operation = current.queue.then(async () => {
      const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
      combined.throwIfAborted();
      if (this.entries.get(key) !== current) throw new Error("Telnet 连接已中断，命令未发送；请重新调用并确认当前视图");
      const reused = current.connected;
      const reset = this.interrupted.has(key);
      const output: string[] = [];
      let timer: NodeJS.Timeout | undefined;
      let onAbort = () => {};
      const stopped = new Promise<never>((_resolve, reject) => {
        onAbort = () => { void current.connection.destroy(); reject(new Error("Telnet 操作已取消，未自动重发命令")); };
        combined.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          void current.connection.destroy();
          reject(new Error(`Telnet 操作超时（${timeoutMs}ms），未自动重发命令；后续调用需重新确认视图`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([stopped, (async () => {
          if (!current.connected) {
            await current.connection.connect({
              ...target, username: control.username || undefined, password: control.password || undefined,
              disableLogon: !control.username, shellPrompt: TELNET_PROMPT,
              loginPrompt: /(?:login|username)[: ]*$/i, passwordPrompt: /password[: ]*$/i,
              timeout: timeoutMs, execTimeout: timeoutMs, encoding: "utf8", stripControls: true,
              stripShellPrompt: false, echoLines: 0, ors: "\r\n",
              pageSeparator: /(?:-{2,}\s*More\s*-*|More:|Press (?:any key|SPACE)[^\r\n]*)/i,
              maxBufferLength: 1_000_000,
            });
            current.connection.getSocket()?.setTimeout(0);
            current.connected = true;
            this.interrupted.delete(key);
          }
          const socket = current.connection.getSocket();
          if (!socket?.writable || socket.destroyed) throw new Error("Telnet 连接已断开，命令未发送；后续调用需重新确认视图");
          const lines = command.split(/\r\n|\r|\n/).filter((line) => line.trim());
          // Each CLI line must complete before the next one can change views.
          for (const line of lines.length ? lines : [""]) {
            combined.throwIfAborted();
            const text = await current.connection.exec(line, { execTimeout: timeoutMs });
            output.push(text);
            if (CLI_ERROR.test(text)) throw new TelnetCommandError(`设备拒绝 Telnet 命令“${line}”，后续命令未执行：\n${text}`);
          }
          const text = output.join("\n");
          const limit = 32_000;
          return { success: true, stdout: text.length > limit ? `${text.slice(0, limit / 2)}\n... 输出已截断 ...\n${text.slice(-limit / 2)}` : text, stderr: "", exitCode: null, truncated: text.length > limit, sessionReused: reused, sessionReset: reset };
        })()]);
      } catch (error) {
        if (!(error instanceof TelnetCommandError)) {
          if (this.entries.get(key) === current) this.entries.delete(key);
          this.interrupted.add(key);
          void current.connection.destroy();
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        combined.removeEventListener("abort", onAbort);
      }
    });
    current.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => entry.connection.destroy()));
  }
}
