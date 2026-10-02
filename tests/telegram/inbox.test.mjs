import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramInbox } from "../../src/telegram/inbox.ts";

const turn = (text, id = 1) => ({ chatId: 42, replyToMessageId: id, content: [{ type: "text", text: `[telegram] ${text}` }] });
const message = (input) => ({ role: "user", content: input.content });

function harness(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = {};
  const submitted = [];
  const failed = [];
  const options = {
    ready: () => true,
    submit: (input) => submitted.push(input),
    changed: () => {},
    failed: (input, _ctx, error) => failed.push([input, error]),
  };
  const inbox = new TelegramInbox(options);
  t.after(() => inbox.stop());
  return { inbox, ctx, submitted, failed, options };
}

test("disconnect pauses without discarding pending input; reconnect resumes FIFO", (t) => {
  const h = harness(t);
  const first = turn("first");
  const second = turn("second", 2);
  h.inbox.pause();
  h.inbox.enqueue(first, h.ctx);
  h.inbox.enqueue(second, h.ctx);
  t.mock.timers.tick(1000);
  assert.deepEqual(h.submitted, []);
  assert.equal(h.inbox.count, 2);
  h.inbox.resume(h.ctx);
  t.mock.timers.tick(50);
  assert.deepEqual(h.submitted, [first]);
  h.inbox.take(message(first), h.ctx);
  t.mock.timers.tick(50);
  assert.deepEqual(h.submitted, [first, second]);
});

test("late acknowledgements while disconnected cannot schedule another submission", (t) => {
  const h = harness(t);
  const first = turn("first");
  const second = turn("second", 2);
  h.inbox.enqueue(first, h.ctx);
  h.inbox.enqueue(second, h.ctx);
  h.inbox.pause();
  h.inbox.take(message(first), h.ctx);
  t.mock.timers.tick(1000);
  assert.deepEqual(h.submitted, [first]);
  assert.equal(h.inbox.count, 1);
});

test("explicit synchronous rejection reports failure without blocking the next item", (t) => {
  const h = harness(t);
  const first = turn("first");
  const second = turn("second", 2);
  h.options.submit = (input) => {
    if (input === first) throw new Error("unavailable");
    h.submitted.push(input);
  };
  h.inbox.enqueue(first, h.ctx);
  h.inbox.enqueue(second, h.ctx);
  assert.equal(h.failed.length, 1);
  assert.equal(h.failed[0][0], first);
  assert.deepEqual(h.submitted, [second]);
});

test("void submission is retained and never automatically retried before acknowledgement", (t) => {
  const h = harness(t);
  const first = turn("first");
  h.inbox.enqueue(first, h.ctx);
  h.inbox.schedule(h.ctx);
  t.mock.timers.tick(10000);
  assert.equal(h.inbox.count, 1);
  assert.deepEqual(h.submitted, [first]);
});
