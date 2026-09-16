import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import { TELNET_PROMPT, TelnetSessionPool } from "./telnet-session.js";
import type { ControlInterface } from "./catalog-store.js";

async function fakeSwitch(t: test.TestContext) {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    connections += 1;
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let view = "user";
    let paging = false;
    const prompt = () => view === "user" ? "<FutureMatrix>" : view === "system" ? "[FutureMatrix]" : "[FutureMatrix-GigabitEthernet0/0/11]";
    socket.write("\r\n<FutureMatrix>");
    socket.on("data", (data) => {
      if (paging && data.toString().startsWith(" ")) {
        paging = false;
        socket.write(`\r\nsecond configuration line\r\n${prompt()}`);
        return;
      }
      buffer += data.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const command = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        commands.push(command);
        if (command === "hang") continue;
        if (command === "disconnect") { socket.destroy(); continue; }
        if (command === "invalid") { socket.write(`invalid\r\nError: Unrecognized command found at '^' position.\r\n${prompt()}`); continue; }
        if (command === "system-view") view = "system";
        if (command.startsWith("interface ")) view = "interface";
        if (command === "quit") view = view === "interface" ? "system" : "user";
        if (command === "display current-configuration") {
          paging = true;
          socket.write("display current-configuration\r\n!Software Version V200\r\nfirst configuration line\r\n---- More ----");
          continue;
        }
        socket.write(`${command}\r\nOK:${command}\r\n${prompt()}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = { host: "127.0.0.1", port: (server.address() as { port: number }).port };
  const control: ControlInterface = { id: "switch-console", name: "Telnet", type: "telnet", address: `127.0.0.1:${target.port}`, username: "", password: "" };
  const pool = new TelnetSessionPool();
  t.after(async () => {
    await pool.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { pool, target, control, commands, getConnections: () => connections };
}

test("recognizes shell, user and Huawei/H3C configuration prompts", () => {
  for (const prompt of ["<FutureMatrix>", "[FutureMatrix]", "[FutureMatrix-GigabitEthernet0/0/11]", "root@tau:/# ", "router(config)#", "router>"]) assert.ok(TELNET_PROMPT.test(`output\r\n${prompt}`), prompt);
  assert.equal(TELNET_PROMPT.test("!Software Version V200\r\n"), false);
  assert.equal(TELNET_PROMPT.test("some output [not a prompt] more text"), false);
});

test("retains Telnet views across tool calls and serializes multiline and parallel requests", async (t) => {
  const f = await fakeSwitch(t);
  const first = await f.pool.execute("switch", f.control, f.target, "system-view", 2000);
  assert.equal(first.sessionReused, false);
  assert.match(String(first.stdout), /\[FutureMatrix\]/);
  const [interfaceResult, display] = await Promise.all([
    f.pool.execute("switch", f.control, f.target, "interface GigabitEthernet0/0/11\nmac-address learning disable", 2000),
    f.pool.execute("switch", f.control, f.target, "display this", 2000),
  ]);
  assert.equal(interfaceResult.sessionReused, true);
  assert.match(String(display.stdout), /\[FutureMatrix-GigabitEthernet0\/0\/11\]/);
  assert.deepEqual(f.commands, ["system-view", "interface GigabitEthernet0/0/11", "mac-address learning disable", "display this"]);
  assert.equal(f.getConnections(), 1);
});

test("collects paginated Telnet output without discarding the first output line", async (t) => {
  const f = await fakeSwitch(t);
  const output = await f.pool.execute("switch", f.control, f.target, "display current-configuration", 2000);
  assert.match(String(output.stdout), /!Software Version V200/);
  assert.match(String(output.stdout), /first configuration line/);
  assert.match(String(output.stdout), /second configuration line/);
  assert.equal(output.truncated, false);
});

test("CLI errors stop the remaining batch but do not destroy a valid configuration view", async (t) => {
  const f = await fakeSwitch(t);
  await assert.rejects(f.pool.execute("switch", f.control, f.target, "system-view\ninvalid\nshould-not-run", 2000), /设备拒绝.*invalid/);
  assert.equal(f.commands.includes("should-not-run"), false);
  const output = await f.pool.execute("switch", f.control, f.target, "display this", 2000);
  assert.equal(output.sessionReused, true);
  assert.match(String(output.stdout), /\[FutureMatrix\]/);
});

test("timeouts do not replay commands and a later connection reports the reset", async (t) => {
  const f = await fakeSwitch(t);
  await assert.rejects(f.pool.execute("switch", f.control, f.target, "hang\nshould-not-run", 80), /超时/);
  const output = await f.pool.execute("switch", f.control, f.target, "display this", 2000);
  assert.equal(output.sessionReset, true);
  assert.equal(f.commands.filter((command) => command === "hang").length, 1);
  assert.equal(f.commands.includes("should-not-run"), false);
});

test("closing the Agent cancels a waiting Telnet request", async (t) => {
  const f = await fakeSwitch(t);
  const pending = f.pool.execute("switch", f.control, f.target, "hang", 5000);
  const rejected = assert.rejects(pending, /取消|关闭/);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await f.pool.close();
  await rejected;
});
