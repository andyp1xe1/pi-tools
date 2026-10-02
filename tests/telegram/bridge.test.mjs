import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { TelegramBridge } from "../../src/telegram/bridge.ts";
import { PREVIEW_THROTTLE_MS } from "../../src/telegram/constants.ts";

function assistant(text, stopReason = "stop", extra = {}) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, ...extra };
}

function harness(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const handlers = new Map();
  const submissions = [];
  const calls = [];
  const notifications = [];
  let idle = true;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerTool: () => {},
    registerCommand: () => {},
    sendUserMessage: (content, options) => submissions.push({ content, options }),
  };
  const ctx = {
    isIdle: () => idle,
    abort: () => {},
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus: () => {},
      notify: (text) => notifications.push(text),
    },
  };
  const bridge = new TelegramBridge(pi);
  bridge.client.call = async (method, body) => {
    calls.push({ method, ...body });
    return { message_id: calls.length };
  };
  bridge.register();
  t.after(() => bridge.onSessionShutdown());
  async function emit(name, event = {}) {
    await handlers.get(name)?.({ type: name, ...event }, ctx);
  }
  async function receive(text, id = 1) {
    await bridge.dispatchMessages([{ message_id: id, chat: { id: 42, type: "private" }, text }], ctx);
  }
  async function acknowledge(index = 0) {
    await emit("message_start", { message: { role: "user", content: submissions[index].content } });
  }
  async function tick(ms = 50) {
    t.mock.timers.tick(ms);
    await nextTick();
  }
  const texts = () => submissions.map(({ content }) => content[0].text);
  return { bridge, pi, ctx, calls, notifications, submissions, emit, receive, acknowledge, tick, texts,
    setIdle: (value) => { idle = value; } };
}

for (const outcome of ["session_compact", "session_compact_failed"]) {
  test(`messages survive ${outcome} and wait until pi actually clears manual compaction`, async (t) => {
    const h = harness(t);
    h.setIdle(false);
    await h.emit("session_before_compact");
    await h.receive("first");
    await h.receive("second", 2);
    await h.emit(outcome);
    assert.deepEqual(h.texts(), []);
    await h.tick(); // Hook has returned, but pi's controller is still set.
    assert.deepEqual(h.texts(), []);
    h.setIdle(true);
    await h.tick();
    assert.deepEqual(h.texts(), ["[telegram] first"]);
    assert.equal(h.bridge.inbox.count, 2); // Submission is not an acknowledgement.
    await h.emit("agent_start");
    h.setIdle(false);
    await h.acknowledge();
    await h.tick();
    assert.deepEqual(h.texts(), ["[telegram] first", "[telegram] second"]);
    await h.acknowledge(1);
    assert.equal(h.bridge.inbox.count, 0);
  });
}

test("the pre-hook manual compaction window also queues incoming messages", async (t) => {
  const h = harness(t);
  h.setIdle(false);
  await h.receive("during preparation");
  await h.tick();
  assert.deepEqual(h.texts(), []);
  h.setIdle(true);
  await h.tick();
  assert.deepEqual(h.texts(), ["[telegram] during preparation"]);
});

test("auto-compaction can resume with queued steering inside the existing run", async (t) => {
  const h = harness(t);
  h.setIdle(false);
  await h.emit("agent_start");
  await h.emit("session_before_compact");
  await h.receive("steer after compaction");
  await h.emit("session_compact");
  assert.deepEqual(h.texts(), []);
  await h.tick();
  assert.deepEqual(h.texts(), ["[telegram] steer after compaction"]);
  assert.deepEqual(h.submissions[0].options, { deliverAs: "steer" });
});

test("unrelated user messages cannot consume a pending Telegram turn", async (t) => {
  const h = harness(t);
  await h.receive("original");
  await h.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "[telegram] unrelated" }] } });
  assert.equal(h.bridge.inbox.count, 1);
  assert.equal(h.bridge.activeTurn, undefined);
  await h.acknowledge();
  assert.equal(h.bridge.inbox.count, 0);
});

test("commentary and final answers finalize separately; settled never resends", async (t) => {
  const h = harness(t);
  await h.receive("request");
  await h.emit("agent_start");
  await h.acknowledge();
  await h.emit("message_start", { message: assistant("") });
  await h.emit("message_update", { message: assistant("Planning") });
  await h.tick(PREVIEW_THROTTLE_MS);
  await h.emit("message_end", { message: assistant("Planning complete", "toolUse") });
  await h.emit("message_start", { message: { role: "toolResult", content: [] } });
  await h.emit("message_start", { message: assistant("") });
  await h.emit("message_update", { message: assistant("Result") });
  await h.tick(PREVIEW_THROTTLE_MS);
  await h.emit("message_end", { message: assistant("Result complete") });
  await h.emit("agent_settled");
  const outgoing = h.calls.filter(({ method }) => method !== "sendChatAction");
  assert.deepEqual(outgoing.map(({ method, text }) => [method, text]), [
    ["sendMessage", "Planning"],
    ["editMessageText", "Planning complete"],
    ["sendMessage", "Result"],
    ["editMessageText", "Result complete"],
  ]);
  assert.equal(outgoing[1].message_id, outgoing[0].message_id ?? h.calls.indexOf(outgoing[0]) + 1);
  assert.equal(h.bridge.typingInterval, undefined);
});

test("thinking-only output stays invisible and aborted partial text stays in place", async (t) => {
  const h = harness(t);
  await h.receive("request");
  await h.emit("agent_start");
  await h.acknowledge();
  await h.emit("message_start", { message: assistant("") });
  await h.emit("message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }] } });
  await h.tick(PREVIEW_THROTTLE_MS);
  await h.emit("message_update", { message: assistant("Partial") });
  await h.tick(PREVIEW_THROTTLE_MS);
  await h.emit("message_end", { message: assistant("Partial", "aborted") });
  await h.emit("agent_settled");
  assert.deepEqual(h.calls.filter(({ method }) => method !== "sendChatAction").map(({ method, text }) => [method, text]), [
    ["sendMessage", "Partial"],
  ]);
});

test("transient agent errors are not announced; terminal errors are announced once", async (t) => {
  const h = harness(t);
  await h.receive("request");
  await h.emit("agent_start");
  await h.acknowledge();
  await h.emit("message_start", { message: assistant("") });
  await h.emit("message_end", { message: assistant("", "error", { errorMessage: "retrying" }) });
  await h.emit("agent_start");
  await h.emit("message_start", { message: assistant("") });
  await h.emit("message_end", { message: assistant("Recovered") });
  await h.emit("agent_settled");
  assert.deepEqual(h.calls.filter(({ method }) => method === "sendMessage").map(({ text }) => text), ["Recovered"]);

  await h.receive("another", 2);
  await h.emit("agent_start");
  await h.acknowledge(1);
  await h.emit("message_start", { message: assistant("") });
  await h.emit("message_end", { message: assistant("", "error", { errorMessage: "failed" }) });
  await h.emit("agent_settled");
  await nextTick();
  assert.deepEqual(h.calls.filter(({ method }) => method === "sendMessage").map(({ text }) => text), ["Recovered", "failed"]);
});

test("shutdown cancels pending inbox delivery", async (t) => {
  const h = harness(t);
  h.setIdle(false);
  await h.receive("queued");
  await h.emit("session_shutdown");
  h.setIdle(true);
  await h.tick();
  assert.deepEqual(h.texts(), []);
});
