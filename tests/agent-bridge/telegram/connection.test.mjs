import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { isPollingConflict, TelegramClient } from "../../../src/agent-bridge/telegram/client.ts";
import { TelegramConnection } from "../../../src/agent-bridge/telegram/connection.ts";

const token = () => `${randomUUID()}:test-token`;

// The daemon owns this OS lock. Pi attachment, framing, and disconnect
// coverage is in connection-client.test.mjs and bridge.test.mjs.
// The Pi extension does not own a poll loop or bot lock.
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
  const module = new URL("../../../src/agent-bridge/telegram/connection.ts", import.meta.url).href;
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
