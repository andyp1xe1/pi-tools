import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { BotInbox } from "../../src/bot/inbox.ts";

const turn = (text, id = 1) => ({ id: String(id), content: [{ type: "text", text: `[telegram] ${text}` }] });
const message = (input) => ({ role: "custom", customType: "agent-bridge", content: input.content, details: { turnId: input.id }, display: true });

function harness(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = {};
  const submitted = [];
  const failed = [];
  const options = {
    ready: () => true,
    submit: (input, _ctx, lease) => lease.emit(() => { submitted.push(input); }),
    changed: () => {},
    failed: (input, _ctx, error) => failed.push([input, error]),
  };
  const inbox = new BotInbox(options);
  t.after(() => inbox.stop());
  return { inbox, ctx, submitted, failed, options };
}

test("pause retains pending input; resume preserves FIFO", (t) => {
  const h = harness(t);
  const first = turn("first");
  const second = turn("second", 2);
  h.inbox.pause();
  h.inbox.reserve(h.ctx).complete(first);
  h.inbox.reserve(h.ctx).complete(second);
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
  h.inbox.reserve(h.ctx).complete(first);
  h.inbox.reserve(h.ctx).complete(second);
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
  h.options.submit = (input, _ctx, lease) => {
    if (input === first) throw new Error("unavailable");
    lease.emit(() => { h.submitted.push(input); });
  };
  h.inbox.reserve(h.ctx).complete(first);
  h.inbox.reserve(h.ctx).complete(second);
  assert.equal(h.failed.length, 1);
  assert.equal(h.failed[0][0], first);
  assert.deepEqual(h.submitted, [second]);
});

test("reservations preserve FIFO when asynchronous preparation finishes in reverse order", (t) => {
  const h = harness(t);
  const first = h.inbox.reserve(h.ctx);
  const second = h.inbox.reserve(h.ctx);
  second.complete(turn("second", 2));
  h.inbox.reserve(h.ctx).complete(turn("third", 3));
  t.mock.timers.tick(1000);
  assert.equal(h.inbox.count, 3);
  assert.deepEqual(h.submitted, []);
  first.complete(turn("first"));
  assert.deepEqual(h.submitted.map((input) => input.id), ["1"]);
  h.inbox.take(message(h.submitted[0]), h.ctx);
  t.mock.timers.tick(50);
  assert.deepEqual(h.submitted.map((input) => input.id), ["1", "2"]);
});

test("cancelled or stopped reservations cannot revive input or block later turns", (t) => {
  const h = harness(t);
  const failed = h.inbox.reserve(h.ctx);
  h.inbox.reserve(h.ctx).complete(turn("next"));
  failed.cancel();
  failed.complete(turn("late"));
  assert.deepEqual(h.submitted.map((input) => input.content[0].text), ["[telegram] next"]);
  const stale = h.inbox.reserve(h.ctx);
  h.inbox.stop();
  stale.complete(turn("stale"));
  stale.cancel();
  h.inbox.resume(h.ctx);
  t.mock.timers.tick(1000);
  assert.equal(h.inbox.count, 0);
  assert.equal(h.submitted.length, 1);
});

test("only validated customType and opaque turn ID acknowledge, never identical user text", (t) => {
  const h = harness(t); const first = turn("same"); h.inbox.reserve(h.ctx).complete(first);
  for (const candidate of [
    { role: "user", content: first.content },
    { ...message(first), customType: "other-extension" },
    { ...message(first), details: undefined },
    { ...message(first), details: { turnId: 1 } },
    { ...message(first), details: { turnId: "" } },
    { ...message(first), details: { turnId: "other" } },
  ]) assert.equal(h.inbox.take(candidate, h.ctx), undefined);
  assert.equal(h.inbox.count, 1);
  assert.equal(h.inbox.take({ ...message(first), content: "rewritten display text" }, h.ctx), first);
});

test("async pre-ack rejection reports once, drops the failed item, and admits the next without retry", async (t) => {
  const h = harness(t); const first = turn("first"), second = turn("second", 2);
  let reject;
  h.options.submit = (input, ctx, lease) => {
    assert.equal(ctx, h.ctx);
    if (input === first) return new Promise((_resolve, no) => { reject = no; });
    lease.emit(() => { h.submitted.push(input); });
  };
  h.inbox.reserve(h.ctx).complete(first); h.inbox.reserve(h.ctx).complete(second);
  reject(new Error("auth failed")); await nextTick();
  assert.equal(h.failed.length, 1); assert.equal(h.failed[0][0], first);
  t.mock.timers.tick(50);
  assert.deepEqual(h.submitted, [second]);
  t.mock.timers.tick(1000); assert.deepEqual(h.submitted, [second]);
});

for (const transition of ["acknowledged", "stopped"]) {
  test(`late async rejection after ${transition} cannot remove a new submission with the same turn object`, async (t) => {
    const h = harness(t); const first = turn("same"); let reject;
    h.options.submit = (_input, _ctx, lease) => {
      lease.emit(() => {});
      return new Promise((_resolve, no) => { reject = no; });
    };
    h.inbox.reserve(h.ctx).complete(first); const oldReject = reject;
    if (transition === "acknowledged") h.inbox.take(message(first), h.ctx);
    else { h.inbox.stop(); h.inbox.resume(h.ctx); }
    h.inbox.reserve(h.ctx).complete(first);
    oldReject(new Error("stale failure")); await nextTick();
    assert.equal(h.failed.length, 0); assert.equal(h.inbox.count, 1);
    assert.equal(h.inbox.take(message(first), h.ctx), first);
  });
}

test("settled rejects only emitted input and stale submission leases cannot emit", (t) => {
  const h = harness(t); const first = turn("first"), second = turn("second", 2); let lease;
  h.options.submit = (_input, _ctx, value) => { lease = value; };
  h.inbox.reserve(h.ctx).complete(first); h.inbox.reserve(h.ctx).complete(second);
  const oldLease = lease;
  h.inbox.rejectUnacknowledged(h.ctx);
  assert.equal(h.inbox.count, 2); assert.equal(h.failed.length, 0);
  assert.equal(h.inbox.take(message(first), h.ctx), undefined);
  lease.emit(() => {}); h.inbox.rejectUnacknowledged(h.ctx);
  assert.equal(h.inbox.count, 1); assert.equal(h.failed.length, 1);
  t.mock.timers.tick(50); assert.equal(lease.isCurrent(), true); assert.equal(oldLease.isCurrent(), false);
  oldLease.emit(() => assert.fail("stale lease emitted"));
  lease.emit(() => {}); assert.equal(h.inbox.take(message(second), h.ctx), second);
});

test("void submission is retained and never automatically retried before acknowledgement", (t) => {
  const h = harness(t);
  const first = turn("first");
  h.inbox.reserve(h.ctx).complete(first);
  h.inbox.schedule(h.ctx);
  t.mock.timers.tick(10000);
  assert.equal(h.inbox.count, 1);
  assert.deepEqual(h.submitted, [first]);
});
