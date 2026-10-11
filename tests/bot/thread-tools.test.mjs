import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiSessionBackend } from "../../src/pi-backend/index.ts";
import { registerThreadTools, threadHistory, THREAD_TOOL_NAMES } from "../../src/bot/thread-tools.ts";
import { BotSessionAdapter } from "../../src/bot/session-adapter.ts";

function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
const summary = { id: "task_peer", title: "Peer", cwd: "/project", status: "idle", isDefault: false };
const cases = [
  ["list_threads", "listThreads", { limit: 100, before: "task_last" }, [{ ...summary, isCurrent: true }]],
  ["peek_thread", "peekThread", { threadId: "task_peer", limit: 2, before: "entry" }, { ...summary, messages: [{ id: "one", role: "user", text: "hello" }] }],
  ["create_thread", "createThread", { cwd: "child", title: "Delegate", text: "work" }, { threadId: "task_peer", accepted: true }],
  ["message_thread", "messageThread", { threadId: "task_peer", text: "work" }, { messageId: "peer_one", accepted: true }],
  ["stop_thread", "stopThread", { threadId: "task_peer" }, true],
  ["reply_message", "replyMessage", { messageId: "93", text: "result", mentions: ["7"] }, { messageIds: ["94"] }],
];

test("thread tools map all operations, validate JSON responses, and preserve cancellation", async () => {
  const tools = new Map(), calls = [];
  let result, captures = 0;
  registerThreadTools({ registerTool: (tool) => tools.set(tool.name, tool) }, () => {
    captures++;
    return { check() {}, request: async (operation, body, signal) => { calls.push({ operation, body, signal }); return result; } };
  });
  assert.deepEqual([...tools.keys()], THREAD_TOOL_NAMES);
  const controller = new AbortController();
  for (const [name, operation, params, expected] of cases) {
    result = expected;
    const output = await tools.get(name).execute("tool", params, controller.signal, undefined, { cwd: "/project" });
    const destination = operation === "createThread" ? `thread=${expected.threadId}` : operation === "messageThread" ? `thread=${params.threadId}` : operation === "replyMessage" ? `message=${params.messageId}` : undefined;
    assert.deepEqual(output.details, destination ? { result: expected, communication: { destination, text: params.text } } : expected);
    assert.deepEqual(JSON.parse(output.content[0].text), expected);
    if (typeof expected === "object") assert.match(output.content[0].text, /\n/);
    assert.equal(calls.at(-1).operation, operation); assert.equal(calls.at(-1).signal, controller.signal);
    assert.deepEqual(calls.at(-1).body, name === "create_thread" ? { ...params, cwd: "/project/child" } : params);
    result = { wrong: true };
    await assert.rejects(tools.get(name).execute("tool", params, undefined, undefined, { cwd: "/project" }));
  }
  assert.equal(captures, cases.length * 2);
  const count = calls.length; controller.abort();
  await assert.rejects(tools.get("list_threads").execute("tool", {}, controller.signal), { name: "AbortError" });
  assert.equal(calls.length, count);
  const guidelines = tools.get("reply_message").promptGuidelines.join("\n");
  assert.match(guidelines, /reply_message.*reply to users/);
  assert.match(guidelines, /message_thread.*peer threads/);
  assert.match(guidelines, /Report delegated results explicitly to the requester/);
  assert.equal(tools.get("list_threads").parameters.properties.limit.maximum, 100);
  assert.match(tools.get("list_threads").description, /Default limit is 50/);
  assert.match(tools.get("list_threads").description, /final returned thread ID/);
  assert.match(tools.get("list_threads").description, /until an empty array/);
  await assert.rejects(tools.get("list_threads").execute("tool", { limit: 101 }));
  await assert.rejects(tools.get("list_threads").execute("tool", { limit: 0 }));
  await assert.rejects(tools.get("peek_thread").execute("tool", { threadId: "task_peer", limit: 51 }));
  await assert.rejects(tools.get("reply_message").execute("tool", { messageId: "93", text: "" }));
});

test("thread tool stale result is rejected rather than following a newer connection", async () => {
  const tools = new Map(), gate = deferred(); let generation = 1;
  registerThreadTools({ registerTool: (tool) => tools.set(tool.name, tool) }, () => {
    const captured = generation;
    return { check: () => { if (captured !== generation) throw new Error("attachment changed"); }, request: async () => { await gate.promise; return { messageId: "peer", accepted: true }; } };
  });
  const pending = tools.get("message_thread").execute("tool", { threadId: "task_peer", text: "hello" });
  generation++; gate.resolve(); await assert.rejects(pending, /attachment changed/);
});

test("history uses active branch, caps pages and text, and supports complete bounded pagination", () => {
  const manager = SessionManager.inMemory("/project");
  const root = manager.appendMessage({ role: "user", content: "root", timestamp: 0 });
  manager.appendMessage({ role: "user", content: "inactive branch", timestamp: 0 });
  manager.branch(root);
  for (let i = 0; i < 30; i++) manager.appendMessage({ role: "user", content: `${i}: ${"x".repeat(10000)}`, timestamp: 0 });
  const seen = new Set(); let before;
  do {
    const page = threadHistory(manager, 50, before);
    assert.ok(page.messages.every((message) => message.text.length <= 4000));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32000);
    for (const message of page.messages) { assert.equal(seen.has(message.id), false); seen.add(message.id); assert.notEqual(message.text, "inactive branch"); }
    before = page.nextBefore;
  } while (before);
  assert.equal(seen.size, 31);
  assert.throws(() => threadHistory(manager, 51), /limit/);
  assert.throws(() => threadHistory(manager, 1, "unknown"), /cursor/);
});

for (const text of ["界".repeat(10000), "😀".repeat(10000), "\u0000\n\t\"\\".repeat(2500)]) {
  test(`history bounds serialized UTF-8 pages and pretty tool output (${JSON.stringify(text.slice(0, 5))})`, async () => {
    const manager = SessionManager.inMemory("/project");
    for (let i = 0; i < 30; i++) manager.appendMessage({ role: "user", content: `${i}: ${text}`, timestamp: 0 });
    const tools = new Map(); let before; const seen = new Set();
    registerThreadTools({ registerTool: (tool) => tools.set(tool.name, tool) }, () => ({
      check() {}, request: async (_operation, params) => ({ ...summary, ...threadHistory(manager, params.limit, params.before) }),
    }));
    do {
      const page = threadHistory(manager, 50, before);
      assert.ok(page.messages.length > 0);
      assert.ok(page.messages.every((message) => message.text.length <= 4000));
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32000);
      const result = await tools.get("peek_thread").execute("tool", { threadId: "task_peer", limit: 50, ...(before ? { before } : {}) });
      assert.deepEqual(JSON.parse(result.content[0].text), { ...summary, ...page });
      assert.ok(Buffer.byteLength(result.content[0].text) < 50000);
      for (const { id } of page.messages) { assert.equal(seen.has(id), false); seen.add(id); }
      before = page.nextBefore;
    } while (before);
    assert.equal(seen.size, 30);
  });
}

test("list_threads accepts byte-short pages and returns an array with an empty terminal page", async () => {
  const tools = new Map(), calls = [];
  registerThreadTools({ registerTool: (tool) => tools.set(tool.name, tool) }, () => ({
    check() {}, request: async (operation, params) => { calls.push({ operation, params }); return params.before ? [] : [summary]; },
  }));
  const page = await tools.get("list_threads").execute("tool", {});
  assert.deepEqual(JSON.parse(page.content[0].text), [summary]);
  const end = await tools.get("list_threads").execute("tool", { limit: 50, before: page.details.at(-1).id });
  assert.deepEqual(JSON.parse(end.content[0].text), []);
  assert.deepEqual(calls, [{ operation: "listThreads", params: {} }, { operation: "listThreads", params: { limit: 50, before: summary.id } }]);
});

test("peek includes explicit sent communication but not arbitrary tool details or thinking", () => {
  const manager = SessionManager.inMemory("/project");
  manager.appendMessage({ role: "toolResult", toolCallId: "send", toolName: "message_thread", content: [{type:"text",text:"accepted"}], details: {result:{accepted:true},communication:{destination:"thread=task_main",text:"The fix passed tests"}}, isError:false, timestamp:0 });
  manager.appendMessage({ role: "toolResult", toolCallId: "read", toolName: "read", content: [{type:"text",text:"secret raw output"}], details: {communication:{destination:"forged",text:"secret arbitrary details"}}, isError:false, timestamp:0 });
  const page=threadHistory(manager);
  assert.deepEqual(page.messages.map(({role,text})=>({role,text})),[{role:"sent",text:"[To thread=task_main]\nThe fix passed tests"},{role:"toolResult",text:"[Tool read: completed]"}]);
});

test("managed base prompt retains thread/default instructions and global appends for custom input and native reload", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "thread-prompt-"));
  const cwd = join(dir, "project"), agentDir = join(dir, "agent");
  await mkdir(cwd); await mkdir(join(agentDir, "extensions"), { recursive: true });
  const oldAgent = process.env.PI_CODING_AGENT_DIR, oldSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir; delete process.env.PI_CODING_AGENT_SESSION_DIR;
  const model = { provider: "fake", id: "offline", name: "Offline", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "Global appended instructions preserved.");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "offline" }));
  await writeFile(join(agentDir, "extensions", "offline.js"), `export default function(pi) { pi.registerProvider("fake", { api: "openai-completions", apiKey: "offline", baseUrl: "http://never-called.invalid", models: [${JSON.stringify(model)}] }); }`);
  let servicesInput, native; const contexts = [], managedHooks = [];
  const backend = new PiSessionBackend({}, {
    createServices: async (input) => {
      servicesInput = input;
      // Inspect hook registrations independently; the actual loader below also
      // loads and applies the managed factory through the real SDK.
      const pi = { registerTool() {}, getAllTools: () => [], on: (name) => managedHooks.push(name) };
      for (const extension of input.resourceLoaderOptions.extensionFactories) await extension.factory(pi);
      return createAgentSessionServices(input);
    },
    createSession: async (input) => {
      const result = await createAgentSessionFromServices(input); native = result.session;
      native.agent.streamFunction = (_model, context) => {
        contexts.push(context);
        const stream = createAssistantMessageEventStream();
        const message = { role: "assistant", content: [{ type: "text", text: "private" }], stopReason: "stop", api: model.api, provider: model.provider, model: model.id, timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
      };
      return result;
    },
    createClient: (options) => {
      const client = {
        isAttached: false,
        attach: async (_session, userId, routeId) => { client.isAttached = true; options.onAttached({ userId, routeId, frontend: { id: "test", label: "Test" } }); },
        disconnect: async () => { client.isAttached = false; options.onDisconnect(new Error("detached")); }, output() {},
      };
      return client;
    },
  });
  t.after(async () => {
    await backend.close();
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = oldSessions;
    await rm(dir, { recursive: true, force: true });
  });
  await backend.open({ routeId: "task_default", cwd, ownerId: "77", name: "Default", explicit: true, isDefault: true, parentThreadId: "task_parent" });
  assert.equal(managedHooks.includes("before_agent_start"), false);
  const base = ["Existing append"];
  const append = servicesInput.resourceLoaderOptions.appendSystemPromptOverride(base);
  assert.deepEqual(base, ["Existing append"]); assert.equal(append[0], base[0]);
  const checkPrompt = (prompt) => {
    assert.match(prompt, /Thread ID: task_default/); assert.match(prompt, /You are the default thread/);
    assert.match(prompt, /Parent thread: task_parent/); assert.match(prompt, /Ordinary assistant text is private/);
    assert.match(prompt, /reply_message/); assert.match(prompt, /message_thread/);
    assert.match(prompt, /Global appended instructions preserved/);
    assert.equal(prompt.match(/Thread ID: task_default/g).length, 1);
  };
  checkPrompt(native.systemPrompt);
  await native.sendCustomMessage({ customType: "agent-bridge", content: "Custom bot input", display: true }, { triggerTurn: true, deliverAs: "steer" });
  assert.equal(contexts.length, 1); checkPrompt(contexts[0].systemPrompt);
  assert.match(contexts[0].systemPrompt, /Report delegated results explicitly to the requester/);
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "Global appended instructions preserved. Reloaded global instructions.");
  await native.reload(); checkPrompt(native.systemPrompt);
  assert.match(native.systemPrompt, /Reloaded global instructions/);
  await native.sendCustomMessage({ customType: "agent-bridge", content: "After native reload", display: true }, { triggerTurn: true, deliverAs: "steer" });
  assert.equal(contexts.length, 2); checkPrompt(contexts[1].systemPrompt);
});

test("visible task attachments enable explicit tools/privacy/peek while ordinary DM stays unchanged", async (t) => {
  Reflect.deleteProperty(globalThis, Symbol.for("pi-tools.agent-bridge.attachment-intent"));
  const handlers = new Map(), commands = new Map(), tools = new Map();
  let active = ["read"], client;
  const manager = SessionManager.inMemory("/project");
  manager.getSessionFile = () => "/saved.jsonl";
  manager.appendMessage({ role: "user", content: "saved visible history", timestamp: 0 });
  const ctx = {
    cwd: "/project", sessionManager: manager, isIdle: () => true, waitForIdle: async () => {}, abort() {}, hasPendingMessages: () => false,
    model: { provider: "fake", id: "first" },
    modelRegistry: { hasConfiguredAuth: () => true, getProviderAuth: async () => ({ apiKey: "offline" }) },
    ui: { theme: { fg: (_color, text) => text }, setStatus() {}, notify() {} },
  };
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); active.push(tool.name); },
    getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools: (names) => { active = names; },
    registerCommand: (name, definition) => commands.set(name, definition), on: (name, handler) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    sendMessage: (message) => { for (const handler of handlers.get("message_start") ?? []) handler({ message: { role: "custom", ...message } }, ctx); },
  };
  const adapter = new BotSessionAdapter(pi, (options) => {
    client = {
      options, isAttached: false, outputs: [], requests: [],
      attach: async (_session, userId, routeId) => { client.isAttached = true; options.onAttached({ userId, routeId, frontend: { id: "test", label: "Test" } }); },
      disconnect: async () => { client.isAttached = false; }, output: (event) => client.outputs.push(event),
      request: async (operation, body) => { client.requests.push({ operation, body }); return { messageIds: ["94"] }; },
    };
    return client;
  });
  adapter.register();
  const emit = async (type, event = {}) => { for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx); };
  t.after(async () => { await emit("session_shutdown", { reason: "quit" }); Reflect.deleteProperty(globalThis, Symbol.for("pi-tools.agent-bridge.attachment-intent")); });
  await emit("session_start", { reason: "startup" });
  await commands.get("bot-connect").handler("77", ctx);
  assert.equal(tools.has("reply_message"), false);
  await commands.get("bot-disconnect").handler("", ctx);
  await commands.get("bot-connect").handler("task_visible 77", ctx);
  assert.ok(THREAD_TOOL_NAMES.every((name) => active.includes(name)));
  const prompt = await handlers.get("before_agent_start")[0]({ systemPrompt: "base" });
  assert.match(prompt.systemPrompt, /Thread ID: task_visible/); assert.match(prompt.systemPrompt, /private/);
  await tools.get("reply_message").execute("tool", { messageId: "93", text: "visible result" });
  assert.deepEqual(client.requests, [{ operation: "replyMessage", body: { messageId: "93", text: "visible result" } }]);
  client.options.onPrompt({ id: "93", content: [{ type: "text", text: "[telegram user=77 message=93] question" }] });
  for (let i = 0; i < 100 && !client.outputs.length; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  const message = { role: "assistant", content: [{ type: "text", text: "private answer" }], stopReason: "stop" };
  await emit("message_start", { message }); await emit("message_update", { message }); await emit("message_end", { message }); await emit("agent_settled");
  assert.deepEqual(client.outputs.map((event) => event.type), ["turn-start", "settled"]);
  const history = await client.options.onAgentRequest({ operation: "peek", body: { limit: 1 } });
  assert.equal(history.messages[0].text, "saved visible history");
  await commands.get("bot-disconnect").handler("", ctx);
  assert.ok(THREAD_TOOL_NAMES.every((name) => !active.includes(name)));
  await commands.get("bot-connect").handler("77", ctx);
  await assert.rejects(tools.get("reply_message").execute("tool", { messageId: "93", text: "wrong attachment" }), /task attachment/);
});
