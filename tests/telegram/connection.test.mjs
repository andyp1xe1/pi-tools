import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { TelegramBridge } from "../../src/telegram/bridge.ts";
import { isPollingConflict, TelegramClient } from "../../src/telegram/client.ts";
import { TelegramConnection } from "../../src/telegram/connection.ts";

const token = () => `${randomUUID()}:test-token`;

test("one local owner per bot, including rotated tokens", async () => {
  const bot = token();
  const owner = await TelegramConnection.acquire(bot);
  try {
    await assert.rejects(TelegramConnection.acquire(bot), /already connected/);
    await assert.rejects(TelegramConnection.acquire(bot.replace("test-token", "rotated")), /already connected/);
    const different = await TelegramConnection.acquire(token());
    await different.release();
  } finally {
    await owner.release();
  }
  const next = await TelegramConnection.acquire(bot);
  await next.release();
  await next.release();
});

test("simultaneous attempts elect exactly one owner", async () => {
  const bot = token();
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => TelegramConnection.acquire(bot)));
  const owners = attempts.filter(({ status }) => status === "fulfilled");
  assert.equal(owners.length, 1);
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 5);
  await owners[0].value.release();
});

test("the OS releases ownership on a process crash", { skip: process.platform !== "linux" && process.platform !== "win32" }, async (t) => {
  const bot = token();
  const module = new URL("../../src/telegram/connection.ts", import.meta.url).href;
  const script = `
    const { TelegramConnection } = await import(${JSON.stringify(module)});
    await TelegramConnection.acquire(${JSON.stringify(bot)});
    process.send("ready");
  `;
  const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child, "message");
  await assert.rejects(TelegramConnection.acquire(bot), /already connected/);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const next = await TelegramConnection.acquire(bot);
  await next.release();
});

function bridgeHarness() {
  const calls = [];
  const notifications = [];
  const bridge = new TelegramBridge({});
  const ctx = {
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus: () => {},
      notify: (text) => notifications.push(text),
    },
  };
  bridge.client.registerCommands = async () => { calls.push("registerCommands"); };
  bridge.pollLoop = async (_ctx, signal) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  };
  return { bridge, ctx, calls, notifications };
}

test("a second bridge refuses before touching Telegram; disconnect transfers ownership", async (t) => {
  const bot = token();
  const first = bridgeHarness();
  const second = bridgeHarness();
  t.after(async () => {
    await first.bridge.stopPolling();
    await second.bridge.stopPolling();
  });
  await first.bridge.startPolling(first.ctx, { botToken: bot });
  await assert.rejects(second.bridge.startPolling(second.ctx, { botToken: bot }), /already connected/);
  assert.deepEqual(second.calls, []);
  assert.match(second.notifications[0], /telegram-disconnect/);
  await first.bridge.stopPolling();
  await second.bridge.startPolling(second.ctx, { botToken: bot });
  assert.deepEqual(second.calls, ["registerCommands"]);
});

test("failed startup releases ownership, and duplicate connect calls share startup", async (t) => {
  const bot = token();
  const h = bridgeHarness();
  t.after(() => h.bridge.stopPolling());
  h.bridge.client.registerCommands = async () => { throw new Error("registration failed"); };
  await assert.rejects(h.bridge.startPolling(h.ctx, { botToken: bot }), /registration failed/);
  h.bridge.client.registerCommands = async () => { h.calls.push("registerCommands"); };
  await Promise.all([
    h.bridge.startPolling(h.ctx, { botToken: bot }),
    h.bridge.startPolling(h.ctx, { botToken: bot }),
  ]);
  assert.deepEqual(h.calls, ["registerCommands"]);
});

test("disconnect cancels a hanging startup and releases ownership", async (t) => {
  const bot = token();
  const h = bridgeHarness();
  let started;
  const registrationStarted = new Promise((resolve) => { started = resolve; });
  h.bridge.client.registerCommands = async (_commands, signal) => {
    started();
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  t.after(() => h.bridge.stopPolling());
  const rejected = assert.rejects(h.bridge.startPolling(h.ctx, { botToken: bot }), /abort/i);
  await registrationStarted;
  await h.bridge.stopPolling();
  await rejected;
  const replacement = await TelegramConnection.acquire(bot);
  await replacement.release();
});

test("disconnect retains ownership until an in-flight Telegram send completes", async (t) => {
  const bot = token();
  const h = bridgeHarness();
  let sent;
  let finish;
  const sending = new Promise((resolve) => { sent = resolve; });
  const gate = new Promise((resolve) => { finish = resolve; });
  h.bridge.client.call = async () => {
    sent();
    await gate;
    return { message_id: 1 };
  };
  t.after(() => h.bridge.stopPolling());
  await h.bridge.startPolling(h.ctx, { botToken: bot });
  h.bridge.preview.start();
  h.bridge.preview.update("Partial");
  const output = h.bridge.preview.finalize(42);
  await sending;
  const stopped = h.bridge.stopPolling();
  await assert.rejects(TelegramConnection.acquire(bot), /already connected/);
  finish();
  await Promise.all([output, stopped]);
  const replacement = await TelegramConnection.acquire(bot);
  await replacement.release();
});

test("a remote polling conflict disconnects the bridge and releases its local owner", async (t) => {
  const bot = token();
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/deleteWebhook")) return Response.json({ ok: true, result: true });
    polls++;
    return Response.json({ ok: false, error_code: 409, description: "Conflict" }, { status: 409 });
  });
  const h = bridgeHarness();
  h.bridge.pollLoop = TelegramBridge.prototype.pollLoop;
  await h.bridge.startPolling(h.ctx, { botToken: bot });
  await h.bridge.pollingPromise;
  assert.equal(polls, 1);
  assert.equal(h.bridge.pollingPromise, undefined);
  assert.equal(h.bridge.inbox.isPaused, true);
  assert.match(h.notifications[0], /conflict/);
  const replacement = await TelegramConnection.acquire(bot);
  await replacement.release();
});

test("a fresh connection does not skip the newest incoming update", async () => {
  const h = bridgeHarness();
  h.bridge.config = { botToken: token() };
  const controller = new AbortController();
  const bodies = [];
  h.bridge.client.call = async (method, body) => {
    if (method === "deleteWebhook") return true;
    bodies.push(body);
    controller.abort();
    return [];
  };
  await TelegramBridge.prototype.pollLoop.call(h.bridge, h.ctx, controller.signal);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].offset, undefined);
  assert.equal(bodies[0].limit, 10);
});

test("Telegram HTTP 409 is recognizable and is not retried", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(JSON.stringify({ ok: false, error_code: 409, description: "Conflict: another getUpdates request" }), { status: 409 });
  });
  const client = new TelegramClient(() => ({ botToken: token() }));
  await assert.rejects(client.call("getUpdates", {}), (error) => isPollingConflict(error));
  assert.equal(requests, 1);
});
