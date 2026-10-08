import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { MAX_MESSAGE_LENGTH, PREVIEW_THROTTLE_MS } from "../../../src/agent-bridge/telegram/constants.ts";
import { TelegramPreview } from "../../../src/agent-bridge/telegram/preview.ts";

function harness(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let nextId = 1;
  const client = {
    async call(method, body) {
      calls.push({ method, ...body });
      return { message_id: nextId++ };
    },
  };
  const preview = new TelegramPreview(client);
  const errors = [];
  t.after(() => preview.stop());
  async function stream(text) {
    preview.update(text);
    preview.schedule(42, (error) => errors.push(error));
    t.mock.timers.tick(PREVIEW_THROTTLE_MS);
    await nextTick();
  }
  return { preview, calls, client, errors, stream };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("streaming and finalization edit one stable bubble", async (t) => {
  const { preview, calls, stream } = harness(t);
  preview.start();
  await stream("Hello");
  await stream("Hello there");
  preview.update("Hello there!");
  await preview.finalize(42);
  assert.deepEqual(calls, [
    { method: "sendMessage", chat_id: 42, text: "Hello" },
    { method: "editMessageText", chat_id: 42, message_id: 1, text: "Hello there" },
    { method: "editMessageText", chat_id: 42, message_id: 1, text: "Hello there!" },
  ]);
  await preview.finalize(42);
  assert.equal(calls.length, 3);
});

test("thinking-only messages never create a placeholder", async (t) => {
  const { preview, calls, stream } = harness(t);
  preview.start();
  await stream("");
  await preview.finalize(42);
  assert.deepEqual(calls, []);
});

test("an unchanged final message does not edit or resend", async (t) => {
  const { preview, calls, stream } = harness(t);
  preview.start();
  await stream("Done");
  await stream("Done");
  await preview.finalize(42);
  assert.equal(calls.length, 1);
});

test("finalization waits for a slow streaming send, then edits its id", async (t) => {
  const { preview, calls, client, stream } = harness(t);
  const gate = deferred();
  client.call = async (method, body) => {
    calls.push({ method, ...body });
    if (method === "sendMessage") await gate.promise;
    return { message_id: 7 };
  };
  preview.start();
  await stream("Partial");
  preview.update("Complete");
  const final = preview.finalize(42);
  await nextTick();
  assert.equal(calls.length, 1);
  gate.resolve();
  await final;
  assert.deepEqual(calls, [
    { method: "sendMessage", chat_id: 42, text: "Partial" },
    { method: "editMessageText", chat_id: 42, message_id: 7, text: "Complete" },
  ]);
});

test("slow sends coalesce updates rather than queuing overlapping previews", async (t) => {
  const { preview, calls, client, stream } = harness(t);
  const gate = deferred();
  client.call = async (method, body) => {
    calls.push({ method, ...body });
    if (method === "sendMessage") await gate.promise;
    return { message_id: 7 };
  };
  preview.start();
  await stream("First");
  await stream("Second");
  await stream("Third");
  assert.equal(calls.length, 1);
  gate.resolve();
  await nextTick();
  t.mock.timers.tick(PREVIEW_THROTTLE_MS);
  await preview.waitForIdle();
  await preview.finalize(42);
  assert.deepEqual(calls.map(({ method, text }) => [method, text]), [
    ["sendMessage", "First"],
    ["editMessageText", "Third"],
  ]);
});

test("queued finalization cannot overwrite the next assistant message", async (t) => {
  const { preview, calls, stream } = harness(t);
  preview.start();
  await stream("Plan");
  preview.update("Plan complete");
  const first = preview.finalize(42);
  preview.start();
  preview.update("Result");
  const second = preview.finalize(42);
  await Promise.all([first, second]);
  t.mock.timers.tick(PREVIEW_THROTTLE_MS);
  await nextTick();
  assert.deepEqual(calls.map(({ method, text }) => [method, text]), [
    ["sendMessage", "Plan"],
    ["editMessageText", "Plan complete"],
    ["sendMessage", "Result"],
  ]);
});

test("long replies continue streaming, preserving all existing message ids", async (t) => {
  const { preview, calls, stream } = harness(t);
  preview.start();
  const prefix = "a".repeat(MAX_MESSAGE_LENGTH);
  await stream(prefix + "tail");
  preview.update(prefix + "tail complete");
  await preview.finalize(42);
  assert.deepEqual(calls.map(({ method, message_id, text }) => [method, message_id, text]), [
    ["sendMessage", undefined, prefix],
    ["sendMessage", undefined, "tail"],
    ["editMessageText", 2, "tail complete"],
  ]);
});

test("stopping cancels scheduled work but never deletes streamed content", async (t) => {
  const { preview, calls, stream } = harness(t);
  preview.start();
  await stream("Partial");
  preview.update("Pending");
  preview.schedule(42, assert.fail);
  await preview.stop();
  t.mock.timers.tick(PREVIEW_THROTTLE_MS);
  await nextTick();
  assert.deepEqual(calls.map(({ method }) => method), ["sendMessage"]);
});

test("one failed edit does not poison the operation queue", async (t) => {
  const { preview, calls, client, stream, errors } = harness(t);
  let fail = true;
  const call = client.call;
  client.call = async (method, body) => {
    if (method === "editMessageText" && fail) {
      fail = false;
      throw new Error("temporary failure");
    }
    return call(method, body);
  };
  preview.start();
  await stream("Partial");
  await stream("Complete");
  await preview.finalize(42);
  assert.equal(errors.length, 1);
  assert.deepEqual(calls.map(({ method, text }) => [method, text]), [
    ["sendMessage", "Partial"],
    ["editMessageText", "Complete"],
  ]);
});
