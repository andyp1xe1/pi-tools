import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import * as v from "valibot";
import { ClientFrameSchema, ServerFrameSchema } from "../../src/agent-bridge/protocol.ts";
import { BridgeServer } from "../../src/agent-bridge/server.ts";
import { Store } from "../../src/agent-bridge/store.ts";
import { TelegramHttpClient } from "../../src/agent-bridge/telegram/api.ts";
import { TelegramClient } from "../../src/agent-bridge/telegram/client.ts";
import { TelegramFrontend } from "../../src/agent-bridge/telegram/frontend.ts";
import { unavailableBackend } from "./fixtures.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup(owners = ["7"], fetcher?: ConstructorParameters<typeof TelegramHttpClient>[1]) {
  const directory = mkdtempSync(join(tmpdir(), "bridge-notify-"));
  const path = join(directory, "bridge.sock");
  const calls: Record<string, unknown>[] = [];
  const api = new TelegramHttpClient("99:fake", fetcher ?? (async (_url, request) => {
    const body = JSON.parse(String(request.body));
    calls.push(body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 100, chat: { id: Number(body.chat_id), type: "private" } } }));
  }));
  const store = new Store(":memory:");
  const frontend = new TelegramFrontend({ database: ":memory:", ownerTelegramUserIds: owners }, store, api, { id: 99, username: "test_bot" }, new TelegramClient(() => ({ botToken: "99:fake" })), unavailableBackend);
  const server = new BridgeServer(frontend, () => {});
  frontend.connect(server);
  await server.listen(path);
  cleanup.push(async () => { await frontend.close(); await server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, calls, frontend, server };
}
async function command(path: string, frame: unknown) {
  return new Promise<v.InferOutput<typeof ServerFrameSchema>>((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    socket.once("error", reject);
    socket.setTimeout(2000, () => socket.destroy(new Error("Notification timed out")));
    socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try { resolve(v.parse(ServerFrameSchema, JSON.parse(buffer.split("\n")[0]!))); }
      catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
  });
}
async function cli(path: string, ...args: string[]) {
  const child = spawn("bun", ["--no-env-file", "bin/agent-bridge.mjs", ...args], {
    cwd: process.cwd(), env: { ...process.env, AGENT_BRIDGE_SOCKET: path, AGENT_BRIDGE_ENV_FILE: `${path}.absent-env` }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { code, stdout, stderr };
}

test("local notifications are daemon-owned, owner-only and require no agent attachment", async () => {
  const h = await setup();
  expect(await command(h.path, { type: "notify", userId: "7", text: "Systemd bridge ready" })).toEqual({ type: "notified", userId: "7" });
  expect(h.calls).toEqual([{ chat_id: "7", text: "Systemd bridge ready" }]);
  expect(h.server.inspect().sessions).toEqual([]);
  expect((await command(h.path, { type: "notify", userId: "8", text: "Not allowed" })).type).toBe("error");
  expect(h.calls).toHaveLength(1);
  expect((await command(h.path, { type: "status" })).type).toBe("status");
});

test("discovery mode never allows notifications and closed frontends reject them", async () => {
  const h = await setup([]);
  await expect(h.frontend.notify({ userId: "7", text: "hello" })).rejects.toThrow("configured owner");
  expect(h.calls).toHaveLength(0);
  await h.frontend.close();
  await expect(h.frontend.notify({ userId: "7", text: "hello" })).rejects.toThrow("closed");
});

test("notification validation bounds text and preserves opaque recipient IDs", () => {
  for (const text of ["", "   ", "x".repeat(4001)]) expect(v.safeParse(ClientFrameSchema, { type: "notify", userId: "7", text }).success).toBe(false);
  expect(v.safeParse(ClientFrameSchema, { type: "notify", userId: "owner", text: "x".repeat(4000) }).success).toBe(true);
});

test("uncertain notification creation is reported without resending", async () => {
  let attempts = 0;
  const h = await setup(["7"], async () => { attempts++; throw new Error("lost response"); });
  const frame = await command(h.path, { type: "notify", userId: "7", text: "once" });
  expect(frame.type).toBe("error");
  if (frame.type === "error") expect(frame.unknownOutcome).toBe(true);
  expect(attempts).toBe(1);
});

test("CLI notify contacts the existing daemon, propagates refusal and prints only acknowledged success", async () => {
  const h = await setup();
  const accepted = await cli(h.path, "notify", "7", "service ready");
  expect(accepted.code, accepted.stderr).toBe(0);
  expect(JSON.parse(accepted.stdout)).toEqual({ type: "notified", userId: "7" });
  const denied = await cli(h.path, "notify", "8", "not allowed");
  expect(denied.code).toBe(1);
  expect(denied.stdout).toBe("");
  expect(denied.stderr).toContain("Bridge request failed");
  expect(h.calls).toHaveLength(1);
  const missing = await cli(h.path, "notify", "7");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("Usage:");
});

test("frontend shutdown cancels an in-flight notification", async () => {
  let started = false;
  const h = await setup(["7"], async (_url, request) => {
    started = true;
    return await new Promise<Response>((_resolve, reject) => {
      const signal = request.signal!;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const result = h.frontend.notify({ userId: "7", text: "slow" });
  const failure = result.catch((error: unknown) => error);
  while (!started) await Bun.sleep(1);
  await h.frontend.close();
  expect(await failure).toMatchObject({ name: "AbortError" });
});
