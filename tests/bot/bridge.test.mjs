import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { beforeEach, afterEach, test } from "node:test";
import * as v from "valibot";
import { AgentOutputSchema } from "../../src/agent-bridge/protocol.ts";
import { BotSessionAdapter } from "../../src/bot/session-adapter.ts";
import { preparePrompt } from "../../src/bot/messages.ts";
import { captureBridgeTranscription } from "../../src/agent-bridge/client.ts";

const INTENT = Symbol.for("pi-tools.agent-bridge.attachment-intent");
const PROVIDER = Symbol.for("pi-tools.agent-bridge.transcription-provider");
let root, priorSocket;
beforeEach(async () => {
  Reflect.deleteProperty(globalThis, INTENT); Reflect.deleteProperty(globalThis, PROVIDER);
  root = await mkdtemp(join(tmpdir(), "bot-extension-")); priorSocket = process.env.AGENT_BRIDGE_SOCKET;
  process.env.AGENT_BRIDGE_SOCKET = join(root, "fake-socket");
});
afterEach(async () => { if (priorSocket === undefined) delete process.env.AGENT_BRIDGE_SOCKET; else process.env.AGENT_BRIDGE_SOCKET = priorSocket; await rm(root, { recursive: true, force: true }); });
const prompt = (text, id = "p1") => ({ id, content: [{ type: "text", text: `[telegram] ${text}` }] });
const assistant = (text, stopReason = "stop", extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason, ...extra });
const model = { provider: "fake", id: "next", name: "Next", api: "fake", reasoning: false, input: ["text"], contextWindow: 10000 };
const auth = { auth: { apiKey: "fake-key" } };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(predicate) { for (let i = 0; i < 100; i++) { await nextTick(); if (predicate()) return; } assert.fail("condition did not settle"); }
const clocks = new WeakSet();
function harness(t, { prepare, rejectAttach = false, pendingAttach = false } = {}) {
  if (!clocks.has(t)) { t.mock.timers.enable({ apis: ["setTimeout"] }); clocks.add(t); }
  const handlers = new Map(), commands = new Map(), tools = new Map();
  const submissions = [], notifications = [], clients = [], statuses = [];
  let idle = true, thinking = "off", currentModel = model;
  const ctx = {
    cwd: process.cwd(), isIdle: () => idle, abort: () => { idle = true; }, waitForIdle: async () => {}, hasPendingMessages: () => false,
    compact: ({ onComplete }) => onComplete({}), scopedModels: [],
    modelRegistry: { getAvailable: () => [model], isUsingOAuth: () => false, hasConfiguredAuth: () => false, getProviderAuth: async () => auth },
    get model() { return currentModel; }, getContextUsage: () => undefined,
    sessionManager: { getSessionId: () => "session", getSessionFile: () => "/fake/session.jsonl", getEntries: () => [] },
    ui: { theme: { fg: (color, text) => `<${color}>${text}</${color}>` }, setStatus: (key, text) => statuses.push({ key, text }), notify: (message) => notifications.push(message) },
  };
  const pi = {
    on: (name, fn) => handlers.set(name, fn), registerCommand: (name, value) => commands.set(name, value),
    registerTool: (tool) => tools.set(tool.name, tool), getAllTools: () => [...tools.values()],
    sendMessage: (message, options) => submissions.push({ message, content: message.content, options }),
    getThinkingLevel: () => thinking, setThinkingLevel: (level) => { thinking = level; },
    setModel: async (value) => { currentModel = value; return true; },
    exec: () => assert.fail("adapter must not execute local transcription"),
  };
  const createClient = options => {
    const client = {
      options, isAttached: false, outputs: [], attachments: [], transcriptions: [],
      attachGate: pendingAttach ? deferred() : undefined,
      attach: async (sessionId, userId, routeId, cwd, token, sessionFile, registration) => {
        client.attachArgs = { sessionId, userId, routeId, cwd, token, sessionFile, registration };
        if (client.attachGate) await client.attachGate.promise;
        if (rejectAttach) { options.onDisconnect(new Error("rejected")); throw new Error("rejected"); }
        client.isAttached = true;
        const frame = { type: "attached", userId: userId ?? "42", routeId: routeId ?? "task_terminal-1", frontend: { id: "fake:frontend", label: "fake_bot" } };
        options.onAttached(frame); return frame;
      },
      disconnect: async detachOptions => {
        client.disconnectOptions = detachOptions; client.disconnectCalls = (client.disconnectCalls ?? 0) + 1;
        client.isAttached = false; client.attachGate?.reject(new Error("closed before registration"));
        if (client.closeGate) await client.closeGate.promise;
        options.onDisconnect(new Error("closed"));
      },
      output: event => client.outputs.push(JSON.parse(JSON.stringify(v.parse(AgentOutputSchema, event)))),
      sendAttachment: async (body, signal) => { signal?.throwIfAborted(); client.attachments.push({ body, signal }); },
      transcribeAudio: async (path, model, language, signal) => { signal?.throwIfAborted(); client.transcriptions.push({ path, model, language, signal }); return client.transcript ?? "daemon transcript"; },
      request: () => assert.fail("this fixture uses only portable helpers"),
    };
    clients.push(client); return client;
  };
  const adapter = new BotSessionAdapter(pi, createClient, prepare); adapter.register();
  const emit = async (name, event = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  const command = (args = "") => commands.get("bot").handler(args, ctx);
  const start = async () => { await emit("session_start", { reason: "startup" }); await command(); };
  const h = { adapter, pi, ctx, handlers, commands, tools, clients, submissions, notifications, statuses, emit, command, start,
    get client() { return clients.at(-1); }, receive: value => clients.at(-1).options.onPrompt(value),
    backend: (operation, body = {}) => clients.at(-1).options.onAgentRequest({ type: "agent-request", id: "r1", operation, body }),
    acknowledge: (index = 0) => { const message = submissions[index].message; assert.equal(message?.customType, "agent-bridge"); assert.equal(message?.display, true); assert.deepEqual(submissions[index].options, { triggerTurn: true, deliverAs: "steer" }); return emit("message_start", { message: { role: "custom", ...message } }); },
    tick: async (ms = 50) => { t.mock.timers.tick(ms); await nextTick(); },
    texts: () => submissions.map(({ content }) => content.filter(block => block.type === "text").map(block => block.text).join("")),
    setIdle: value => { idle = value; }, setCurrentModel: value => { currentModel = value; },
  };
  t.after(async () => { for (const client of clients) client.closeGate?.resolve(); idle = true; await emit("session_shutdown", { reason: "quit" }); });
  return h;
}

test("only /bot remains; space selectors disambiguate registration instead of choosing existing threads", async t => {
  const h = harness(t); assert.deepEqual([...h.commands.keys()], ["bot"]);
  await h.emit("session_start"); assert.equal(h.clients.length, 0);
  for (const args of ["task_old 77", "77", "telegram/dm:x/channel extra extra"]) await h.command(args);
  assert.equal(h.clients.length, 0);
  await h.command("discord/dm%3A123/123 77");
  assert.equal(h.client.attachArgs.routeId, undefined);
  assert.deepEqual(h.client.attachArgs.registration, { space: "discord/dm%3A123/123" });
  assert.equal(h.client.attachArgs.userId, "77");
  await h.command(); assert.match(h.notifications.at(-1), /task_terminal-1/); assert.equal(h.clients.length, 1);
});
test("saved terminal sessions register automatically when a daemon socket is present", async t => {
  await writeFile(process.env.AGENT_BRIDGE_SOCKET, "fixture"); const h = harness(t);
  await h.emit("session_start"); assert.equal(h.client.attachArgs.sessionFile, "/fake/session.jsonl");
  assert.equal(h.client.attachArgs.routeId, undefined); assert.ok(h.tools.has("list_threads")); assert.deepEqual(h.notifications, []);
});
test("unsaved sessions never register or gain thread tools", async t => {
  await writeFile(process.env.AGENT_BRIDGE_SOCKET, "fixture"); const h = harness(t); h.ctx.sessionManager.getSessionFile = () => undefined;
  await h.emit("session_start"); await h.command(); assert.equal(h.clients.length, 0); assert.match(h.notifications.at(-1), /saved Pi session/);
});
test("footer retains themed registration, inbox, replying and failure styling", async t => {
  const h = harness(t); await h.emit("session_start"); assert.match(h.statuses.at(-1).text, /<muted>disconnected/);
  await h.command(); assert.match(h.statuses.at(-1).text, /<success>connected/);
  h.setIdle(false); h.receive(prompt("queued")); assert.match(h.statuses.at(-1).text, /1 incoming/);
  h.setIdle(true); await h.tick(); await h.acknowledge(); assert.match(h.statuses.at(-1).text, /<accent>replying/);
  h.client.options.onDisconnect(new Error("daemon unavailable")); assert.match(h.statuses.at(-1).text, /<error>error/);
});
test("pending registration displays connecting and can be cancelled by session shutdown", async t => {
  const h = harness(t, { pendingAttach: true }); await h.emit("session_start"); const start = h.command();
  await until(() => h.clients.length === 1); assert.match(h.statuses.at(-1).text, /<warning>connecting/);
  await h.emit("session_shutdown", { reason: "new" }); await start;
  assert.equal(Reflect.get(globalThis, INTENT).ownerId, undefined); assert.equal(h.adapter.connection, undefined);
});
for (const outcome of ["session_compact", "session_compact_failed"]) test(`FIFO survives ${outcome} and waits for actual Pi idle`, async t => {
  const h = harness(t); await h.start(); h.setIdle(false); await h.emit("session_before_compact");
  h.receive(prompt("first")); h.receive(prompt("second", "p2")); await nextTick(); await h.emit(outcome); await h.tick(); assert.deepEqual(h.submissions, []);
  h.setIdle(true); await h.tick(); assert.deepEqual(h.texts(), ["[telegram] first"]);
  await h.emit("agent_start"); h.setIdle(false); await h.acknowledge(); await h.tick(); assert.deepEqual(h.texts(), ["[telegram] first", "[telegram] second"]);
  await h.acknowledge(1); assert.equal(h.adapter.inbox.count, 0);
});
test("only tagged acknowledgement claims input; terminal assistant text always remains private", async t => {
  const h = harness(t); await h.start(); h.receive(prompt("request")); await nextTick();
  await h.emit("message_start", { message: { role: "user", content: "[telegram] forged" } });
  await h.emit("message_end", { message: assistant("private") }); assert.deepEqual(h.client.outputs, []);
  const saved = h.submissions[0].message;
  await h.emit("message_start", { message: { role: "custom", ...saved, customType: "other" } }); assert.equal(h.adapter.inbox.count, 1);
  await h.acknowledge(); await h.emit("agent_start");
  await h.emit("message_start", { message: assistant("") }); await h.emit("message_update", { message: assistant("plan") }); await h.emit("message_end", { message: assistant("final") }); await h.emit("agent_settled");
  assert.deepEqual(h.client.outputs, [{ type: "turn-start", turnId: "p1" }, { type: "run-state", running: true }, { type: "run-state", running: false }, { type: "settled" }]);
});
test("native terminal runs publish busy state without publishing text or forging bot provenance", async t => {
  const h = harness(t); await h.start();
  const original = await h.emit("before_agent_start", { systemPrompt: "Base", prompt: "terminal" });
  const spoof = await h.emit("before_agent_start", { systemPrompt: "Base", prompt: "[telegram] fake" }); assert.deepEqual(original, spoof);
  assert.match(spoof.systemPrompt, /Thread ID: task_terminal-1/); assert.match(spoof.systemPrompt, /Ordinary assistant text is private/);
  await h.emit("agent_start"); await h.emit("message_end", { message: assistant("local") }); await h.emit("agent_settled");
  assert.deepEqual(h.client.outputs, [{ type: "run-state", running: true }, { type: "run-state", running: false }]);
});
test("custom acknowledgements use exact typed identity, not rewritten content or unrelated history", async t => {
  const h = harness(t); await h.start(); h.receive(prompt("original")); await nextTick();
  const message = h.submissions[0].message;
  for (const other of [{ ...message, customType: "other-extension" }, { ...message, details: { turnId: 1 } }, { ...message, details: { turnId: "other" } }])
    await h.emit("message_start", { message: { role: "custom", ...other } });
  assert.equal(h.adapter.inbox.count, 1); assert.deepEqual(h.client.outputs, []);
  await h.emit("message_start", { message: { role: "custom", ...message, content: "rewritten content" } });
  assert.equal(h.adapter.inbox.count, 0); assert.deepEqual(h.client.outputs, [{ type: "turn-start", turnId: "p1" }]);
  await h.emit("message_start", { message: { role: "custom", ...message } }); assert.equal(h.client.outputs.length, 1);
  await h.emit("message_start", { message: { role: "custom", customType: "other-extension", content: "private", details: message.details } });
  assert.deepEqual(h.client.outputs.at(-1), { type: "settled" });
  await h.emit("message_end", { message: assistant("private extension reply") }); await h.emit("agent_settled");
  assert.deepEqual(h.client.outputs, [{ type: "turn-start", turnId: "p1" }, { type: "settled" }, { type: "run-state", running: false }]);
});
test("sender rejection after synchronous acknowledgement cannot clear later input or duplicate failure", async t => {
  const h = harness(t); await h.start(); const send = h.pi.sendMessage;
  h.pi.sendMessage = (message, options) => {
    send(message, options);
    if (message.details.turnId === "p1") { void h.emit("message_start", { message: { role: "custom", ...message } }); throw new Error("rejected after acknowledgement"); }
  };
  h.receive(prompt("first")); h.receive(prompt("second", "p2")); await nextTick(); await h.tick();
  assert.equal(h.adapter.inbox.count, 1); assert.equal(h.client.outputs.some(event => event.type === "delivery-error"), false);
  await h.acknowledge(1); assert.equal(h.adapter.inbox.count, 0);
});
test("earlier settled or matching custom history cannot acknowledge authentication still in flight", async t => {
  const h = harness(t); await h.start(); const gate = deferred(); h.ctx.modelRegistry.getProviderAuth = () => gate.promise;
  h.receive(prompt("first")); await nextTick();
  await h.emit("message_start", { message: { role: "custom", customType: "agent-bridge", content: "old", details: { turnId: "p1" } } });
  await h.emit("agent_settled"); assert.equal(h.adapter.inbox.count, 1); assert.deepEqual(h.submissions, []);
  assert.deepEqual(h.client.outputs, [{ type: "run-state", running: false }]);
  gate.resolve(auth); await nextTick(); await h.acknowledge(); assert.equal(h.adapter.inbox.count, 0);
});
test("auth rejection releases FIFO once and never silently resends", async t => {
  const h = harness(t); await h.start(); let calls = 0;
  h.ctx.modelRegistry.getProviderAuth = async () => { if (++calls === 1) throw new Error("auth failure"); return auth; };
  h.receive(prompt("bad", "bad")); h.receive(prompt("next", "next")); await nextTick(); await h.tick();
  assert.deepEqual(h.texts(), ["[telegram] next"]); assert.deepEqual(h.client.outputs, [{ type: "delivery-error", turnId: "bad", error: "auth failure" }]);
  await h.tick(1000); assert.equal(calls, 2); await h.acknowledge(); assert.equal(h.adapter.inbox.count, 0);
});
for (const preflight of ["no model", "no auth"]) test(`${preflight} fails before SDK emission without wedging later input`, async t => {
  const h = harness(t); await h.start(); if (preflight === "no model") h.setCurrentModel(undefined); else h.ctx.modelRegistry.getProviderAuth = async () => undefined;
  h.receive(prompt("bad", "bad")); await nextTick(); assert.deepEqual(h.submissions, []); assert.equal(h.adapter.inbox.count, 0);
  assert.equal(h.client.outputs[0].type, "delivery-error"); assert.match(h.client.outputs[0].error, preflight === "no model" ? /No model selected/ : /No API key found/);
  h.setCurrentModel(model); h.ctx.modelRegistry.getProviderAuth = async () => auth; h.receive(prompt("next", "next")); await nextTick(); await h.acknowledge();
  assert.deepEqual(h.texts(), ["[telegram] next"]);
});
test("configured and header-only auth preserve SDK authentication gates", async t => {
  const h = harness(t); await h.start(); h.ctx.modelRegistry.hasConfiguredAuth = () => true;
  h.ctx.modelRegistry.getProviderAuth = () => assert.fail("configured authentication needs no lookup");
  h.receive(prompt("configured")); await nextTick(); await h.acknowledge();
  h.ctx.modelRegistry.hasConfiguredAuth = () => false; h.ctx.modelRegistry.getProviderAuth = async () => ({ auth: { headers: { Authorization: "fake" } } });
  h.receive(prompt("headers", "p2")); await nextTick(); await h.acknowledge(1); assert.equal(h.adapter.inbox.count, 0);
});
for (const phase of ["preparation", "authentication"]) test(`stop cancels ${phase} and fences late completion`, async t => {
  const gate = deferred(); let signal;
  const h = harness(t, phase === "preparation" ? { prepare: (value, cancellation) => { if (value.id !== "p1") return Promise.resolve(value); signal = cancellation; return gate.promise; } } : {});
  await h.start(); if (phase === "authentication") h.ctx.modelRegistry.getProviderAuth = () => gate.promise;
  h.receive(prompt("cancel")); await nextTick(); assert.equal(await h.backend("abort"), true); if (signal) assert.equal(signal.aborted, true);
  h.ctx.modelRegistry.getProviderAuth = async () => auth; gate.resolve(phase === "preparation" ? prompt("cancel") : auth); await nextTick(); await h.tick();
  assert.deepEqual(h.submissions, []); assert.deepEqual(h.client.outputs, [{ type: "delivery-error", turnId: "p1", error: "Bot input cancelled" }]);
  h.receive(prompt("fresh", "fresh")); await nextTick(); await h.acknowledge(); assert.deepEqual(h.texts(), ["[telegram] fresh"]);
});
test("rejected preparation and SDK submission release their independent FIFO positions", async t => {
  const h = harness(t, { prepare: async value => { if (value.id === "bad") throw new Error("image unavailable"); return value; } }); await h.start();
  const send = h.pi.sendMessage; h.pi.sendMessage = (message, options) => { if (message.details.turnId === "reject") throw new Error("Pi unavailable"); return send(message, options); };
  h.receive(prompt("bad", "bad")); h.receive(prompt("reject", "reject")); h.receive(prompt("next", "next")); await nextTick(); await h.tick();
  assert.deepEqual(h.texts(), ["[telegram] next"]); assert.deepEqual(h.client.outputs.map(event => [event.turnId, event.error]), [["bad", "image unavailable"], ["reject", "Pi unavailable"]]);
});
test("settled rejects unacknowledged SDK input once, releasing the next message", async t => {
  const h = harness(t); await h.start(); h.receive(prompt("first")); h.receive(prompt("second", "p2")); await nextTick();
  await h.emit("agent_settled"); await h.tick(); assert.deepEqual(h.texts(), ["[telegram] first", "[telegram] second"]);
  assert.equal(h.client.outputs.filter(event => event.type === "delivery-error").length, 1); await h.tick(1000); assert.equal(h.submissions.length, 2);
});
test("session controls validate model/thinking, serialize mutations, and cannot reset saved identity", async t => {
  const h = harness(t); await h.start(); const snapshot = await h.backend("snapshot"); assert.deepEqual(snapshot.supportedThinking, ["off"]);
  await assert.rejects(h.backend("setThinking", { level: "invalid" })); assert.equal(await h.backend("setModel", { provider: "fake", id: "missing" }), false);
  assert.equal(await h.backend("newSession"), false); assert.equal(await h.backend("abort"), false); assert.equal(await h.backend("compact"), true);
  const gate = deferred(); h.pi.setModel = async () => { await gate.promise; return true; }; const selection = h.backend("setModel", { provider: "fake", id: "next" });
  h.receive(prompt("wait")); await nextTick(); await h.tick(); assert.deepEqual(h.submissions, []); assert.equal(await h.backend("compact"), false); await assert.rejects(h.backend("setThinking", { level: "high" }), /busy/);
  gate.resolve(); assert.equal(await selection, true); await h.tick(); assert.deepEqual(h.texts(), ["[telegram] wait"]);
});
for (const reason of ["new", "resume", "fork"]) test(`${reason} does not inherit the previous saved thread or owner selection`, async t => {
  const old = harness(t); await old.emit("session_start"); await old.command("telegram/-100/general 77"); await old.emit("session_shutdown", { reason });
  const fresh = harness(t); fresh.ctx.sessionManager.getSessionId = () => "replacement"; await fresh.emit("session_start", { reason });
  assert.equal(fresh.clients.length, 0); assert.equal(Reflect.get(globalThis, INTENT).ownerId, undefined);
});
test("reload restores only an exact saved identity; changed IDs cannot inherit a writer", async t => {
  const old = harness(t); await old.start(); await old.emit("session_shutdown", { reason: "reload" });
  const fresh = harness(t); await fresh.emit("session_start", { reason: "reload" }); assert.equal(fresh.client.attachArgs.routeId, "task_terminal-1");
  await fresh.emit("session_shutdown", { reason: "reload" }); const changed = harness(t); changed.ctx.sessionManager.getSessionId = () => "other"; await changed.emit("session_start", { reason: "reload" }); assert.equal(changed.clients.length, 0);
});
for (const outcome of ["resolve", "reject"]) test(`auth ${outcome} after reload cannot submit through stale runtime`, async t => {
  const old = harness(t); await old.start(); const gate = deferred(); old.ctx.modelRegistry.getProviderAuth = () => gate.promise;
  old.receive(prompt("stale")); await nextTick(); await old.emit("session_shutdown", { reason: "reload" });
  const fresh = harness(t); await fresh.emit("session_start", { reason: "reload" }); fresh.receive(prompt("fresh", "fresh")); await nextTick();
  if (outcome === "resolve") gate.resolve(auth); else gate.reject(new Error("stale auth")); await nextTick();
  assert.deepEqual(old.submissions, []); assert.deepEqual(old.client.outputs, []); assert.deepEqual(fresh.texts(), ["[telegram] fresh"]);
});
test("handoff gates new registration and tool publication until the writer lease is confirmed", async t => {
  const old = harness(t); await old.start(); old.client.closeGate = deferred(); const closing = old.emit("session_shutdown", { reason: "reload" });
  const fresh = harness(t); const starting = fresh.emit("session_start", { reason: "reload" }); await nextTick(); assert.equal(fresh.clients.length, 0); assert.equal(fresh.tools.has("transcribe_audio"), false);
  old.client.closeGate.resolve(); await closing; await starting; assert.deepEqual(old.client.disconnectOptions, { quiesced: true }); assert.ok(fresh.tools.has("list_threads"));
});
for (const operation of ["setModel", "compact"]) test(`writer handoff waits for in-flight ${operation}`, async t => {
  const old = harness(t); await old.start(); const gate = deferred(); let bound = "old"; const writes = [];
  if (operation === "setModel") old.pi.setModel = async () => { await gate.promise; writes.push(bound); return true; };
  else old.ctx.compact = ({ onComplete }) => { void gate.promise.then(() => { writes.push(bound); onComplete({}); }); };
  const rejected = assert.rejects(old.backend(operation, operation === "setModel" ? { provider: "fake", id: "next" } : {}), /attachment changed/);
  const closing = old.emit("session_shutdown", { reason: "reload" }).then(() => { bound = "new"; }); const fresh = harness(t); const starting = fresh.emit("session_start", { reason: "reload" });
  await nextTick(); assert.equal(fresh.clients.length, 0); gate.resolve(); await closing; await starting; await rejected; assert.deepEqual(writes, ["old"]);
});
for (const source of ["shutdown", "unexpected"]) test(`${source} clears native queues and waits for abort/idle before closing`, async t => {
  const h = harness(t), aborted = deferred(), settled = deferred(); await h.start(); let aborts = 0; const queue = [];
  h.ctx.abort = () => { aborts++; queue.length = 0; return aborted.promise; }; h.ctx.waitForIdle = () => settled.promise; h.ctx.hasPendingMessages = () => queue.length > 0;
  // Record the command-context waiter for this registration.
  h.adapter.attachmentWaitForIdle = () => h.ctx.waitForIdle();
  h.setIdle(false); queue.push("steering"); const client = h.client;
  let closing;
  if (source === "shutdown") closing = h.emit("session_shutdown", { reason: "reload" });
  else { client.isAttached = false; client.options.onDisconnect(new Error("EOF")); closing = h.adapter.disconnectingPromise; }
  assert.equal(aborts, 1); assert.equal(queue.length, 0); assert.equal(client.disconnectCalls ?? 0, 0); aborted.resolve(); await nextTick(); assert.equal(client.disconnectCalls ?? 0, 0);
  h.setIdle(true); settled.resolve(); await closing; assert.deepEqual(client.disconnectOptions, source === "unexpected" ? undefined : { quiesced: true });
});
test("automatic reload registration without a command waiter observes native idle asynchronously", async t => {
  const old = harness(t); await old.start(); await old.emit("session_shutdown", { reason: "reload" });
  const h = harness(t); await h.emit("session_start", { reason: "reload" }); h.adapter.attachmentWaitForIdle = undefined;
  h.setIdle(false); let aborts = 0; h.ctx.abort = () => { aborts++; }; const client = h.client;
  const closing = h.emit("session_shutdown", { reason: "reload" }); await nextTick();
  assert.equal(aborts, 1); assert.equal(client.disconnectCalls ?? 0, 0);
  h.setIdle(true); await h.tick(10); await closing;
  assert.equal(client.disconnectCalls, 1); assert.deepEqual(client.disconnectOptions, { quiesced: true });
});
test("reverse abort cannot acknowledge before native queue clearing and full settlement", async t => {
  const h = harness(t), settled = deferred(); await h.start(); let queued = true;
  h.ctx.hasPendingMessages = () => queued; h.ctx.abort = () => { queued = false; }; h.adapter.attachmentWaitForIdle = () => settled.promise;
  h.setIdle(false); let acknowledged = false; const abort = h.backend("abort").then(value => { acknowledged = true; return value; });
  await nextTick(); assert.equal(queued, false); assert.equal(acknowledged, false); h.setIdle(true); settled.resolve(); assert.equal(await abort, true); assert.equal(h.client.isAttached, true);
});
test("failed queue clearing leaves writer lease unconfirmed and prevents reconnect", async t => {
  const h = harness(t); await h.start(); h.ctx.hasPendingMessages = () => true; const client = h.client;
  await assert.rejects(h.emit("session_shutdown", { reason: "reload" }), /queued messages after abort/); assert.equal(client.disconnectCalls ?? 0, 0);
  await assert.rejects(h.command(), /queued messages after abort/);
  h.ctx.hasPendingMessages = () => false; h.adapter.disconnectingPromise = undefined; await client.disconnect();
});
test("unexpected loss is unconfirmed; exact registration then clean exit confirms ownership handoff", async t => {
  const h = harness(t); await h.start(); const lost = h.client; lost.isAttached = false; lost.options.onDisconnect(new Error("EOF")); await h.adapter.disconnectingPromise;
  assert.equal(lost.disconnectOptions, undefined); await h.command(); assert.equal(h.client.attachArgs.sessionId, lost.attachArgs.sessionId);
  await h.emit("session_shutdown", { reason: "quit" }); assert.deepEqual(h.client.disconnectOptions, { quiesced: true });
});
test("captured providers and tools cannot cross saved-thread handoffs", async t => {
  const old = harness(t); await old.start(); const provider = captureBridgeTranscription(); const client = old.client;
  await old.emit("session_shutdown", { reason: "reload" }); const fresh = harness(t); await fresh.emit("session_start", { reason: "reload" });
  await assert.rejects(provider({ path: "/must-not-read" }), /attachment changed/); await assert.rejects(client.options.onAgentRequest({ operation: "abort", body: {} }), /attachment changed/);
  client.options.onPrompt(prompt("stale")); await nextTick(); assert.deepEqual(old.submissions, []); assert.equal(await captureBridgeTranscription()({ path: "/fake/audio" }), "daemon transcript");
});
test("image conversion preserves block order and honors cancellation", async () => {
  const path = join(root, "image.png"); await writeFile(path, Buffer.from([1, 2, 3]));
  const value = { id: "image", content: [{ type: "text", text: "before" }, { type: "image-file", path, mimeType: "image/png" }, { type: "text", text: "after" }] };
  assert.deepEqual((await preparePrompt(value)).content, [{ type: "text", text: "before" }, { type: "image", data: "AQID", mimeType: "image/png" }, { type: "text", text: "after" }]);
  const controller = new AbortController(); controller.abort(); await assert.rejects(preparePrompt(value, controller.signal), { name: "AbortError" });
});
test("attachment and transcription tools preserve paths, daemon defaults, cancellation and bounded output", async t => {
  const h = harness(t); await h.start(); h.ctx.cwd = root; const path = join(root, "voice.ogg"); await writeFile(path, "fake");
  const controller = new AbortController(); const attach = h.tools.get("bot_attach"), transcribe = h.tools.get("transcribe_audio");
  assert.deepEqual((await attach.execute("tool", { paths: ["voice.ogg"] }, controller.signal, undefined, h.ctx)).details.paths, [path]);
  assert.deepEqual(h.client.attachments[0], { body: { path, fileName: "voice.ogg" }, signal: controller.signal });
  assert.equal((await transcribe.execute("tool", { path: "@voice.ogg" }, controller.signal, undefined, h.ctx)).content[0].text, "daemon transcript");
  assert.deepEqual(h.client.transcriptions[0], { path, model: undefined, language: undefined, signal: controller.signal });
  h.client.transcript = "line\n".repeat(2100); const long = await transcribe.execute("tool", { path }, undefined, undefined, h.ctx); assert.equal(await readFile(long.details.fullOutputPath, "utf8"), h.client.transcript); await rm(join(long.details.fullOutputPath, ".."), { recursive: true, force: true });
  controller.abort(); await assert.rejects(transcribe.execute("tool", { path }, controller.signal, undefined, h.ctx), { name: "AbortError" });
});
test("existing standalone transcription remains untouched and bridge provider exists only while registered", async t => {
  const h = harness(t); const original = { name: "transcribe_audio", execute: () => {} }; h.tools.set(original.name, original);
  await h.emit("session_start"); assert.equal(h.tools.get("transcribe_audio"), original); assert.equal(captureBridgeTranscription(), undefined);
  await h.command(); assert.equal(await captureBridgeTranscription()({ path: "/fake/audio" }), "daemon transcript");
  await h.emit("session_shutdown", { reason: "quit" }); assert.equal(captureBridgeTranscription(), undefined);
});
test("portable Pi package stays separated from daemon transport/service code", async () => {
  for (const file of ["session-adapter", "controls", "delivery", "inbox", "messages", "status", "tools", "index"]) {
    const source = await readFile(new URL(`../../src/bot/${file}.ts`, import.meta.url), "utf8"); assert.doesNotMatch(source, /from ["'][^"']*(?:telegram\/|server\.ts|store\.ts)["']/);
    assert.doesNotMatch(source, /fetch\(|getUpdates|botToken|callback_query/);
    for (const match of source.matchAll(/from ["']([^"']*agent-bridge[^"']*)["']/g)) assert.match(match[1], /agent-bridge\/(?:client|protocol)\.ts$/);
  }
});
