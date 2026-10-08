import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { TelegramSession } from "../../../src/agent-bridge/telegram/session.ts";
import { MAX_MESSAGE_LENGTH, PREVIEW_THROTTLE_MS } from "../../../src/agent-bridge/telegram/constants.ts";

function fixture(t, topic = false) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const prompts = [], calls = [], uploads = [];
  const agent = {
    current: () => true,
    prompt: (prompt) => prompts.push(prompt),
    snapshot: async () => ({ idle: true, models: [], thinking: "off", supportedThinking: ["off"], status: "ready" }),
    abort: async () => false,
  };
  const transport = {
    call: async (method, body) => { calls.push({ method, ...body }); return { message_id: calls.length + 100 }; },
    sendAttachment: async (chatId, body, signal, destination) => { uploads.push({ chatId, body, destination }); },
  };
  const chatId = topic ? -1001 : 7;
  const session = new TelegramSession(7, agent, transport, assert.fail,
    topic ? { chatId, threadId: 42, current: () => true } : undefined);
  t.after(() => session.close());
  const receive = async (messageId, text = "request") => {
    session.receive({ update_id: messageId, message: {
      message_id: messageId, chat: { id: chatId, type: topic ? "supergroup" : "private" }, from: { id: 7 }, text,
      ...(topic ? { is_topic_message: true, message_thread_id: 42 } : {}),
    } });
    await tick(); await tick();
    return prompts.at(-1);
  };
  const start = (prompt) => {
    session.output({ type: "turn-start", turnId: prompt.id });
    session.output({ type: "text-start" });
  };
  const finish = (text) => {
    session.output({ type: "text-end", text });
    session.output({ type: "settled" });
  };
  return { session, transport, prompts, calls, uploads, receive, start, finish };
}

for (const topic of [false, true]) {
  test(`${topic ? "topic" : "DM"} answers and files reply to each current input, not the conversation root`, async (t) => {
    const h = fixture(t, topic);
    h.start(await h.receive(10)); h.finish("first answer"); await tick();
    const second = await h.receive(20);
    h.start(second);
    await h.session.sendAttachment({ path: "/tmp/report.txt", fileName: "report.txt" }, new AbortController().signal);
    h.finish("second answer"); await tick();
    const answers = h.calls.filter((call) => call.method === "sendMessage");
    assert.deepEqual(answers.map((call) => call.reply_parameters), [
      { message_id: 10, allow_sending_without_reply: false },
      { message_id: 20, allow_sending_without_reply: false },
    ]);
    assert.equal(h.uploads[0].destination.replyToMessageId, 20);
    assert.ok(answers.every((call) => call.chat_id === (topic ? -1001 : 7)));
    if (topic) assert.ok(answers.every((call) => call.message_thread_id === 42));
    await h.session.sendAttachment({ path: "/tmp/terminal.txt", fileName: "terminal.txt" }, new AbortController().signal);
    assert.equal(h.uploads[1].destination.replyToMessageId, undefined, "terminal sends must not reuse an old turn");
  });
}

test("queued streaming bubbles capture their original turn while a later input is acknowledged", async (t) => {
  const h = fixture(t, true);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const call = h.transport.call;
  h.transport.call = async (method, body) => {
    const result = await call(method, body);
    if (body.text === "partial") await gate;
    return result;
  };
  const original = h.session; // A queued finalize must not consult the later active route.
  h.start(await h.receive(10));
  original.output({ type: "text-update", text: "partial" });
  t.mock.timers.tick(PREVIEW_THROTTLE_MS); await tick();
  h.finish("a".repeat(MAX_MESSAGE_LENGTH) + "first tail");
  h.start(await h.receive(20));
  h.finish("second answer");
  assert.equal(h.calls.filter((call) => call.method === "sendMessage").length, 1);
  release();
  for (let i = 0; i < 10; i++) await tick();
  const creations = h.calls.filter((call) => call.method === "sendMessage");
  assert.deepEqual(creations.map((call) => call.reply_parameters.message_id), [10, 10, 20]);
});

test("an in-flight upload keeps its captured reply target when another turn starts", async (t) => {
  const h = fixture(t, true);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.transport.sendAttachment = async (chatId, body, signal, destination) => {
    await gate;
    h.uploads.push({ chatId, body, destination });
  };
  h.start(await h.receive(10));
  const pending = h.session.sendAttachment({ path: "/tmp/report.txt", fileName: "report.txt" }, new AbortController().signal);
  h.start(await h.receive(20));
  release(); await pending;
  assert.equal(h.uploads[0].destination.replyToMessageId, 10);
  assert.equal(h.uploads[0].destination.threadId, 42);
});

test("model and thinking menus reply to their command message", async (t) => {
  const h = fixture(t, true);
  await h.receive(30, "/thinking");
  await tick();
  assert.deepEqual(h.calls.find((call) => call.reply_markup)?.reply_parameters,
    { message_id: 30, allow_sending_without_reply: false });
});
