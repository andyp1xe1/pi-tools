import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { createAgentSessionFromServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiSessionBackend } from "../../src/pi-backend/index.ts";

const prompt = (id, text = id) => ({ id, content: [{ type: "text", text: `[telegram] ${text}` }] });
const model = { provider: "fake", id: "first", name: "First", reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 1000, api: "openai-completions" };
const nextModel = { ...model, id: "second", name: "Second" };
const assistant = (text, stopReason = "stop", errorMessage) => ({ role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 2000; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 1)); }
  assert.fail("condition did not settle");
}

async function harness(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-backend-"));
  const cwd = join(dir, "project"), agentDir = join(dir, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ sessionDir: ".pi/saved" }));
  await writeFile(join(agentDir, "trust.json"), JSON.stringify({ [cwd]: true }));
  const oldAgent = process.env.PI_CODING_AGENT_DIR, oldSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  const clients = [], sessions = [], serviceCalls = [], order = [];
  const factories = {
    createServices: async (input) => {
      serviceCalls.push(input);
      const handlers = new Map(), tools = new Map();
      const pi = {
        registerTool: (tool) => { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool); },
        on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
        exec: () => assert.fail("must not execute local Whisper"),
      };
      for (const extension of input.resourceLoaderOptions.extensionFactories) await extension.factory(pi);
      const services = { ...input, handlers, tools, pi };
      if (options.servicesGate) await options.servicesGate.promise;
      return services;
    },
    createSession: async ({ services, sessionManager }) => {
      const listeners = new Set();
      let idle = true, streaming = false, compacting = false;
      const session = {
        sessionId: sessionManager.getSessionId(), sessionFile: sessionManager.getSessionFile(), sessionManager,
        agent: { toolExecution: "sequential" }, thinkingLevel: "off", model, submissions: [], aborts: 0, disposed: false,
        get isIdle() { return idle; }, get isStreaming() { return streaming; }, get isCompacting() { return compacting; },
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        emit: (event) => { for (const listener of listeners) listener(event); },
        setState: (state) => { idle = state.idle ?? idle; streaming = state.streaming ?? streaming; compacting = state.compacting ?? compacting; },
        bindExtensions: async (bindings) => {
          session.bindings = bindings; order.push(`start:${session.sessionId}`);
          await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
          if (options.bindGate) await options.bindGate.promise;
          if (options.bindError) throw new Error("bind failed");
        },
        sendCustomMessage: async (message, sendOptions) => {
          session.submissions.push({ message, options: sendOptions });
          if (options.sendError) throw new Error("send failed");
          if (options.autoAcknowledge) session.acknowledge(session.submissions.length - 1);
          if (session.runGate) await session.runGate.promise;
        },
        acknowledge: (index = 0) => session.emit({ type: "message_start", message: { role: "custom", ...session.submissions[index].message } }),
        abort: async () => { session.aborts++; session.runGate?.resolve(); session.setState({ idle: true, streaming: false, compacting: false }); },
        clearQueue: () => { session.cleared = true; },
        compact: async () => { session.compactions = (session.compactions ?? 0) + 1; if (session.compactGate) await session.compactGate.promise; },
        setModel: async (value) => { if (session.modelGate) await session.modelGate.promise; session.model = value; },
        setThinkingLevel: (level) => { session.thinkingLevel = level === "max" ? "high" : level; },
        setSessionName: (name) => sessionManager.appendSessionInfo(name),
        dispose: () => { session.disposed = true; order.push(`dispose:${session.sessionId}`); },
        services,
      };
      const ctx = {
        cwd, sessionManager, scopedModels: [], get model() { return session.model; },
        modelRegistry: { getAvailable: () => [model, nextModel], hasConfiguredAuth: () => session.auth !== false, getProviderAuth: async () => { if (session.authGate) await session.authGate.promise; return session.auth === false ? undefined : {}; }, isUsingOAuth: () => false },
        getContextUsage: () => undefined, isIdle: () => session.isIdle,
      };
      session.extensionRunner = {
        createContext: () => ctx,
        emit: async (event) => {
          if (event.type === "session_shutdown") {
            order.push(`shutdown:${session.sessionId}`);
            if (session.shutdownGate) await session.shutdownGate.promise;
            if (session.shutdownError) throw new Error("shutdown failed");
          }
          for (const handler of services.handlers.get(event.type) ?? []) await handler(event, ctx);
        },
      };
      sessions.push(session);
      if (options.sessionGate) await options.sessionGate.promise;
      return { session };
    },
    createClient: (input) => {
      const client = {
        options: input, isAttached: false, outputs: [], attachments: [], transcriptions: [],
        attach: async (sessionId, ownerId, routeId, targetCwd) => {
          client.identity = { sessionId, ownerId, routeId, cwd: targetCwd };
          if (options.attachGate) await options.attachGate.promise;
          if (client.disconnected) throw new Error("closed before attach");
          if (options.attachError) { input.onDisconnect(new Error("attach failed")); throw new Error("attach failed"); }
          client.isAttached = true;
          input.onAttached({ userId: options.wrongOwner ? "wrong" : ownerId, routeId, frontend: { id: "fake", label: "Fake" } });
        },
        disconnect: async () => {
          client.isAttached = false; client.disconnected = true;
          options.attachGate?.reject(new Error("closed before attach"));
          input.onDisconnect(new Error("detached"));
        },
        output: (event) => client.outputs.push(event),
        sendAttachment: async (body, signal) => { signal?.throwIfAborted(); client.attachments.push(body); },
        transcribeAudio: async (path, model, language, signal) => {
          signal?.throwIfAborted(); client.transcriptions.push({ path, model, language, signal });
          if (client.transcriptionGate) await client.transcriptionGate.promise;
          if (client.transcriptionError) throw new Error("daemon unavailable");
          return client.identity.routeId;
        },
      };
      clients.push(client); return client;
    },
    ...(options.prepare ? { prepare: options.prepare } : {}),
  };
  const backend = new PiSessionBackend({ socketPath: join(dir, "bridge.sock") }, factories);
  const target = (routeId = "task_one", extra = {}) => ({ routeId, ownerId: "42", cwd, name: routeId, ...extra });
  const request = (operation, body = {}, index = 0) => clients[index].options.onAgentRequest({ type: "agent-request", id: "r", operation, body });
  t.after(async () => {
    options.servicesGate?.resolve(); options.sessionGate?.resolve(); options.bindGate?.resolve(); options.attachGate?.resolve();
    for (const session of sessions) { session.shutdownGate?.resolve(); session.modelGate?.resolve(); session.compactGate?.resolve(); session.authGate?.resolve(); }
    await backend.close().catch(() => {});
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = oldSessions;
    await rm(dir, { recursive: true, force: true });
  });
  return { backend, factories, target, clients, sessions, serviceCalls, order, dir, cwd, agentDir, request, receive: (value, index = 0) => clients[index].options.onPrompt(value) };
}

test("single-flight route creation, parallel independent saved sessions, and native private header reservation", async (t) => {
  const gate = deferred();
  const h = await harness(t, { attachGate: gate });
  const first = h.backend.open(h.target());
  assert.equal(h.backend.open(h.target()), first);
  const other = h.backend.open(h.target("task_two"));
  await until(() => h.clients.length === 2);
  let resolved = false; void first.then(() => { resolved = true; });
  await nextTick(); assert.equal(resolved, false);
  gate.resolve();
  const [one, two] = await Promise.all([first, other]);
  assert.notEqual(one.sessionId, two.sessionId);
  assert.notEqual(one.sessionFile, two.sessionFile);
  for (const mapping of [one, two]) {
    assert.equal((await stat(mapping.sessionFile)).mode & 0o777, 0o600);
    const header = JSON.parse((await readFile(mapping.sessionFile, "utf8")).split("\n")[0]);
    assert.deepEqual(header, SessionManager.open(mapping.sessionFile).getHeader());
    assert.equal(header.id, mapping.sessionId); assert.equal(header.cwd, h.cwd); assert.equal(header.type, "session");
    assert.ok(mapping.sessionFile.startsWith(join(h.cwd, ".pi", "saved")));
  }
  assert.ok(h.sessions.every((session) => session.agent.toolExecution === "parallel"));
  assert.equal(h.clients[0].identity.ownerId, "42"); assert.equal(h.clients[0].identity.cwd, h.cwd);
  const closing = h.backend.close();
  assert.equal(h.backend.close(), closing);
  await closing;
  assert.ok(h.sessions.every((session) => session.disposed));
  assert.equal(h.order.filter((event) => event.startsWith("shutdown:")).length, 2);
  await assert.rejects(h.backend.open(h.target()), /closed/);
});

test("exact file reopen rejects ID-only, missing and corrupt mappings without replacing history", async (t) => {
  const h = await harness(t);
  const first = await h.backend.open(h.target());
  await assert.rejects(h.backend.open(h.target("task_one", { sessionId: first.sessionId })), /exact saved session file/);
  h.clients[0].isAttached = false; h.clients[0].options.onDisconnect(new Error("lost"));
  await until(() => h.sessions[0].disposed);
  const reopened = await h.backend.open(h.target("task_reopened", first));
  assert.deepEqual(reopened, first);
  assert.deepEqual(h.sessions[1].submissions, []);
  await assert.rejects(h.backend.open(h.target("task_id_only", { sessionId: first.sessionId })), /exact saved session file/);
  const missing = join(h.dir, "absent.jsonl");
  await assert.rejects(h.backend.open(h.target("task_missing", { sessionId: "mapped", sessionFile: missing })), /ENOENT/);
  await assert.rejects(stat(missing), { code: "ENOENT" });
  await assert.rejects(h.backend.open(h.target("task_unknown", { sessionId: "nonexistent" })), /exact saved session file/);
  for (const data of ["", "garbage", '{}\n']) {
    const path = join(h.dir, "bad.jsonl"); await writeFile(path, data);
    await assert.rejects(h.backend.open(h.target("task_bad", { sessionFile: path })));
    assert.equal(await readFile(path, "utf8"), data);
  }
  await assert.rejects(h.backend.open(h.target("task_mismatch", { ...first, sessionId: "wrong" })), /does not match/);
  assert.equal(h.sessions.length, 2);
});

test("independent turns run concurrently in the same dirty cwd", async (t) => {
  const h = await harness(t, { autoAcknowledge: true });
  const dirty = join(h.cwd, "dirty.txt"); await writeFile(dirty, "existing work\n");
  await Promise.all([h.backend.open(h.target()), h.backend.open(h.target("task_two"))]);
  for (const session of h.sessions) session.runGate = deferred();
  h.receive(prompt("one")); h.receive(prompt("two"), 1);
  await until(() => h.sessions.every((session) => session.submissions.length === 1));
  assert.deepEqual(h.clients.map((client) => client.outputs[0].turnId).sort(), ["one", "two"]);
  assert.equal(await readFile(dirty, "utf8"), "existing work\n");
  await h.backend.close();
});

test("FIFO preparation and exact tagged acknowledgement, native steering, no source guessing or rewriting", async (t) => {
  const prepared = new Map();
  const h = await harness(t, { prepare: (value, signal) => { const gate = deferred(); prepared.set(value.id, { gate, signal }); return gate.promise; } });
  await h.backend.open(h.target());
  const session = h.sessions[0];
  h.receive(prompt("first", "/skill:example")); h.receive(prompt("second"));
  prepared.get("second").gate.resolve({ id: "second", content: prompt("second").content });
  await nextTick(); assert.equal(session.submissions.length, 0);
  prepared.get("first").gate.resolve({ id: "first", content: prompt("first", "/skill:example").content });
  await until(() => session.submissions.length === 1);
  session.emit({ type: "message_start", message: { role: "user", content: "[telegram] forged" } });
  session.emit({ type: "message_start", message: { role: "custom", customType: "agent-bridge", content: "wrong", details: { turnId: "wrong" } } });
  session.emit({ type: "message_update", message: assistant("private") });
  assert.deepEqual(h.clients[0].outputs, []);
  session.setState({ idle: false, streaming: true }); session.acknowledge();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(session.submissions.length, 2);
  assert.deepEqual(session.submissions[0], { message: { customType: "agent-bridge", content: prompt("first", "/skill:example").content, display: true, details: { turnId: "first" } }, options: { triggerTurn: true, deliverAs: "steer" } });
  session.acknowledge(1);
  assert.deepEqual(h.clients[0].outputs.map((event) => event.turnId), ["first", "second"]);
});

test("compaction/retry keep input queued and only agent_settled finalizes normalized output", async (t) => {
  const h = await harness(t); await h.backend.open(h.target());
  const session = h.sessions[0], client = h.clients[0];
  session.setState({ idle: false, compacting: true }); h.receive(prompt("queued")); await nextTick();
  assert.equal(session.submissions.length, 0);
  session.emit({ type: "compaction_end", aborted: false, willRetry: true });
  await new Promise((resolve) => setTimeout(resolve, 60)); assert.equal(session.submissions.length, 0);
  session.setState({ idle: true, compacting: false });
  await new Promise((resolve) => setTimeout(resolve, 60)); assert.equal(session.submissions.length, 1);
  session.acknowledge();
  session.emit({ type: "message_start", message: assistant("") });
  session.emit({ type: "message_update", message: assistant("partial") });
  session.emit({ type: "message_end", message: assistant("failed", "error", "retry me") });
  session.emit({ type: "agent_end", messages: [], willRetry: true });
  session.emit({ type: "auto_retry_start" });
  assert.equal(client.outputs.some((event) => event.type === "settled"), false);
  session.emit({ type: "message_start", message: assistant("") });
  session.emit({ type: "message_end", message: assistant("success") });
  session.emit({ type: "agent_settled" });
  assert.deepEqual(client.outputs.at(-1), { type: "settled", error: undefined });
  assert.deepEqual(client.outputs.find((event) => event.type === "text-update"), { type: "text-update", text: "partial" });
});

test("preparation, missing auth, send rejection and unacknowledged input produce explicit delivery errors", async (t) => {
  const h = await harness(t); await h.backend.open(h.target());
  const session = h.sessions[0], client = h.clients[0];
  h.receive({ id: "image", content: [{ type: "image-file", path: join(h.dir, "missing.png"), mimeType: "image/png" }] });
  await until(() => client.outputs.length === 1); assert.equal(client.outputs[0].turnId, "image");
  session.auth = false; h.receive(prompt("auth"));
  await until(() => client.outputs.length === 2); assert.match(client.outputs[1].error, /API key/);
  session.auth = true; h.receive(prompt("noack")); await until(() => session.submissions.length === 1);
  session.emit({ type: "agent_settled" }); assert.match(client.outputs.at(-1).error, /without acknowledging/);
  assert.equal(client.outputs.at(-1).turnId, "noack");
  const saved = session.sendCustomMessage;
  session.sendCustomMessage = async () => { throw new Error("send failed"); };
  h.receive(prompt("reject")); await until(() => client.outputs.at(-1).turnId === "reject");
  assert.match(client.outputs.at(-1).error, /send failed/); session.sendCustomMessage = saved;
});

test("native snapshot/model/thinking/compact/abort RPC and managed newSession refusal", async (t) => {
  const h = await harness(t); await h.backend.open(h.target());
  const session = h.sessions[0];
  assert.equal((await h.request("snapshot")).idle, true);
  assert.equal(await h.request("newSession"), false);
  assert.equal(await h.request("abort"), false);
  assert.equal(await h.request("setModel", { provider: "fake", id: "missing" }), false);
  assert.equal(await h.request("setModel", { provider: "fake", id: "second" }), true);
  assert.equal(session.model.id, "second");
  assert.equal(await h.request("setThinking", { level: "max" }), "high");
  assert.equal(await h.request("compact"), true); assert.equal(session.compactions, 1);
  session.setState({ idle: false, streaming: true });
  assert.equal((await h.request("snapshot")).idle, false);
  assert.equal(await h.request("setModel", { provider: "fake", id: "first" }), false);
  assert.equal(await h.request("compact"), false);
  await assert.rejects(h.request("setThinking", { level: "high" }), /busy/);
  assert.equal(await h.request("abort"), true); assert.ok(session.aborts); assert.ok(session.cleared);
});

test("abort cancels in-flight preparation and late completion cannot publish", async (t) => {
  const gate = deferred(); let signal;
  const h = await harness(t, { prepare: (_value, received) => { signal = received; return gate.promise; } });
  await h.backend.open(h.target()); h.receive(prompt("cancelled"));
  assert.equal(await h.request("abort"), true); assert.equal(signal.aborted, true);
  gate.resolve({ id: "cancelled", content: prompt("cancelled").content }); await nextTick();
  assert.equal(h.sessions[0].submissions.length, 0);
  assert.deepEqual(h.clients[0].outputs, [{ type: "delivery-error", turnId: "cancelled", error: "Bot input cancelled" }]);
});

test("stop fences native authentication still in flight while Pi is idle", async (t) => {
  const h = await harness(t); await h.backend.open(h.target());
  const session = h.sessions[0], client = h.clients[0];
  session.auth = false; session.authGate = deferred();
  h.receive(prompt("cancelled")); await nextTick();
  assert.equal(await h.request("abort"), true);
  session.auth = true; session.authGate.resolve(); await nextTick();
  assert.deepEqual(session.submissions, []);
  assert.deepEqual(client.outputs, [{ type: "delivery-error", turnId: "cancelled", error: "Bot input cancelled" }]);
  h.receive(prompt("fresh")); await until(() => session.submissions.length === 1);
  assert.equal(session.submissions[0].message.details.turnId, "fresh");
});

test("shared controls hold native input and reject overlapping mutations", async (t) => {
  const h = await harness(t); await h.backend.open(h.target());
  const session = h.sessions[0]; session.modelGate = deferred();
  const selection = h.request("setModel", { provider: "fake", id: "second" });
  h.receive(prompt("wait for model")); await nextTick();
  assert.deepEqual(session.submissions, []);
  assert.equal(await h.request("compact"), false);
  assert.equal(await h.request("setModel", { provider: "fake", id: "first" }), false);
  await assert.rejects(h.request("setThinking", { level: "high" }), /busy/);
  session.modelGate.resolve(); assert.equal(await selection, true);
  await until(() => session.submissions.length === 1);
  assert.equal(session.model.id, "second");
});

for (const phase of ["services", "session", "bind", "attach"]) {
  test(`close during ${phase} startup waits for cleanup and never publishes a mapping`, async (t) => {
    const gate = deferred(); const h = await harness(t, { [`${phase}Gate`]: gate });
    const opening = h.backend.open(h.target()); const rejected = assert.rejects(opening, /closed/);
    await until(() => phase === "services" ? h.serviceCalls.length : phase === "attach" ? h.clients.length : h.sessions.length);
    let closed = false; const closing = h.backend.close().then(() => { closed = true; });
    await nextTick();
    if (phase !== "attach") { assert.equal(closed, false); gate.resolve(); }
    await rejected; await closing;
    assert.ok(h.sessions.every((session) => session.disposed));
    assert.ok(h.clients.every((client) => !client.isAttached));
    assert.deepEqual(h.clients.flatMap((client) => client.outputs), []);
  });
}

for (const failure of ["bindError", "attachError", "wrongOwner"]) {
  test(`${failure} removes failed single-flight state so retry succeeds`, async (t) => {
    const config = { [failure]: true }; const h = await harness(t, config);
    await assert.rejects(h.backend.open(h.target()));
    assert.ok(h.sessions[0].disposed); config[failure] = false;
    const opened = await h.backend.open(h.target()); assert.ok(opened.sessionFile);
    assert.equal(h.sessions.length, 2);
  });
}

test("disconnect fences output and awaits native shutdown hooks before disposing/cache eviction", async (t) => {
  const h = await harness(t); const mapping = await h.backend.open(h.target());
  const session = h.sessions[0]; session.shutdownGate = deferred();
  h.clients[0].isAttached = false; h.clients[0].options.onDisconnect(new Error("daemon lost"));
  await until(() => h.order.includes(`shutdown:${session.sessionId}`));
  assert.equal(session.disposed, false);
  await assert.rejects(h.backend.open(h.target()), /closing/);
  session.emit({ type: "agent_settled" }); assert.deepEqual(h.clients[0].outputs, []);
  session.shutdownGate.resolve(); await until(() => session.disposed);
  assert.ok(h.order.indexOf(`shutdown:${session.sessionId}`) < h.order.indexOf(`dispose:${session.sessionId}`));
  assert.deepEqual(await h.backend.open(h.target("task_one", mapping)), mapping);
});

test("tools capture session-local senders/transcription, cancellation and daemon failure never fall back", async (t) => {
  const h = await harness(t); await Promise.all([h.backend.open(h.target()), h.backend.open(h.target("task_two"))]);
  h.sessions.sort((a, b) => a.sessionManager.getSessionName().localeCompare(b.sessionManager.getSessionName()));
  h.clients.sort((a, b) => a.identity.routeId.localeCompare(b.identity.routeId));
  const file = join(h.cwd, "audio.ogg"); await writeFile(file, "fake audio, never decoded");
  const execute = (index, name, args, signal) => h.sessions[index].services.tools.get(name).execute("tool", args, signal, undefined, { cwd: h.cwd });
  assert.deepEqual(h.sessions.map((session) => [...session.services.tools.keys()]), [["bot_attach", "transcribe_audio"], ["bot_attach", "transcribe_audio"]]);
  const transcripts = await Promise.all([execute(0, "transcribe_audio", { path: "@audio.ogg" }), execute(1, "transcribe_audio", { path: "audio.ogg" })]);
  assert.deepEqual(transcripts.map((result) => result.content[0].text), ["task_one", "task_two"]);
  await execute(1, "bot_attach", { paths: ["audio.ogg"] });
  assert.equal(h.clients[0].attachments.length, 0); assert.equal(h.clients[1].attachments.length, 1);
  h.clients[0].transcriptionError = true;
  await assert.rejects(execute(0, "transcribe_audio", { path: file }), /daemon unavailable/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(execute(1, "transcribe_audio", { path: file }, cancelled.signal), { name: "AbortError" });
  const validating = execute(0, "transcribe_audio", { path: file });
  h.clients[0].isAttached = false; h.clients[0].options.onDisconnect(new Error("lost"));
  await assert.rejects(validating, /not attached/);
  assert.equal((await execute(1, "transcribe_audio", { path: file })).content[0].text, "task_two");
});

test("discovery filters our visible-session entrypoints before factories, retaining unrelated resources", async (t) => {
  const h = await harness(t);
  const extensions = join(h.agentDir, "extensions");
  const packageRoot = join(h.dir, "pi-tools");
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-tools" }));
  const manual = join(packageRoot, "extensions", "bot.ts");
  await writeFile(manual, 'throw new Error("manual attachment factory ran")');
  await symlink(manual, join(extensions, "manual-link.ts"));
  await writeFile(join(extensions, "telegram.ts"), "export default function () {}");
  await writeFile(join(extensions, "bot.ts"), "export default function () {}");
  await writeFile(join(extensions, "normal.ts"), "export default function () {}");
  await h.backend.open(h.target());
  const resources = h.serviceCalls[0].resourceLoaderOptions;
  assert.deepEqual(resources.additionalExtensionPaths, ["bot.ts", "normal.ts", "telegram.ts"].map((name) => join(extensions, name)));
  for (const key of ["noSkills", "noPromptTemplates", "noContextFiles", "noThemes"]) assert.equal(resources[key], undefined);
});

test("noninteractive startup respects saved project trust and never implicitly approves local resources", async (t) => {
  const h = await harness(t);
  const projectExtension = join(h.cwd, ".pi", "extensions", "project.ts");
  await mkdir(join(h.cwd, ".pi", "extensions"));
  await writeFile(projectExtension, "export default function () {}");
  const globalExtension = join(h.agentDir, "extensions", "global.ts");
  await writeFile(globalExtension, "export default function () {}");
  await rm(join(h.agentDir, "trust.json"));
  const untrusted = await h.backend.open(h.target("task_untrusted"));
  assert.equal(h.serviceCalls[0].settingsManager.isProjectTrusted(), false);
  assert.deepEqual(h.serviceCalls[0].resourceLoaderOptions.additionalExtensionPaths, [globalExtension]);
  assert.equal(h.serviceCalls[0].settingsManager.getSessionDir(), undefined);
  assert.ok(!untrusted.sessionFile.startsWith(join(h.cwd, ".pi", "saved")));
  await writeFile(join(h.agentDir, "trust.json"), JSON.stringify({ [h.dir]: true }));
  await h.backend.open(h.target("task_trusted"));
  assert.equal(h.serviceCalls[1].settingsManager.isProjectTrusted(), true);
  assert.ok(h.serviceCalls[1].resourceLoaderOptions.additionalExtensionPaths.includes(projectExtension));
  await writeFile(join(h.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
  await writeFile(join(h.agentDir, "trust.json"), JSON.stringify({ [h.cwd]: false }));
  await h.backend.open(h.target("task_denied"));
  assert.equal(h.serviceCalls[2].settingsManager.isProjectTrusted(), false);
  await rm(join(h.agentDir, "trust.json"));
  await h.backend.open(h.target("task_opted_in"));
  assert.equal(h.serviceCalls[3].settingsManager.isProjectTrusted(), true);
});

test("real SDK resources/startup/shutdown and BridgeClient socket attach with a deterministic offline provider", async (t) => {
  const h = await harness(t);
  // Production services/session/client; only the in-memory provider stream is fake.
  const socketPath = join(h.dir, "native.sock");
  const frames = [], sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const end = buffer.indexOf("\n"); if (end < 0) break;
        const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); frames.push(frame);
        if (frame.type === "attach") socket.write(`${JSON.stringify({ type: "attached", userId: frame.userId, routeId: frame.routeId, frontend: { id: "offline", label: "Offline" } })}\n`);
        if (frame.type === "detach") socket.end('{"type":"detached"}\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const marker = join(h.dir, "lifecycle.txt");
  await writeFile(join(h.agentDir, "extensions", "lifecycle.js"), `import { appendFileSync } from "node:fs"; export default function(pi) { pi.on("session_start", () => appendFileSync(${JSON.stringify(marker)}, "start\\n")); pi.on("session_shutdown", async () => { await Promise.resolve(); appendFileSync(${JSON.stringify(marker)}, "shutdown\\n"); }); }`);
  await writeFile(join(h.agentDir, "package.json"), JSON.stringify({ name: "pi-tools" }));
  await writeFile(join(h.agentDir, "extensions", "bot.ts"), 'throw new Error("manual attachment must not load")');
  await writeFile(join(h.agentDir, "extensions", "offline-provider.js"), `export default function(pi) { pi.registerProvider("fake", { baseUrl: "http://must-never-be-called.invalid", apiKey: "offline-only", api: "openai-completions", models: [${JSON.stringify(model)}] }); }`);
  await writeFile(join(h.cwd, "AGENTS.md"), "# Native context preserved\n");
  const native = [], backend = new PiSessionBackend({ socketPath }, {
    createSession: async (options) => {
      const result = await createAgentSessionFromServices(options);
      result.session.agent.streamFunction = (_model, context) => {
        assert.ok(context.messages.some((message) => message.role === "user" && message.content[0]?.text === "[telegram] native prompt"));
        const stream = createAssistantMessageEventStream();
        const message = { ...assistant("offline native response"), api: model.api, provider: "fake", model: model.id, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "offline native response", partial: message });
        stream.push({ type: "done", reason: "stop", message }); stream.end();
        return stream;
      };
      native.push(result.session); return result;
    },
  });
  t.after(async () => { await backend.close(); for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  const mapping = await backend.open(h.target());
  assert.equal(frames[0].sessionId, mapping.sessionId);
  assert.equal(frames[0].cwd, h.cwd);
  assert.equal(native[0].agent.toolExecution, "parallel");
  assert.ok(native[0].systemPrompt.includes("Native context preserved"));
  assert.equal(native[0].getAllTools().filter((tool) => tool.name === "transcribe_audio").length, 1);
  const ordinary = { ...native[0].getToolDefinition("transcribe_audio") };
  assert.ok(ordinary.execute);
  assert.equal(Reflect.has(globalThis, Symbol.for("pi-tools.agent-bridge.attachment-intent")), false);
  assert.equal(Reflect.has(globalThis, Symbol.for("pi-tools.agent-bridge.transcription-provider")), false);
  assert.equal(native[0].extensionRunner.createContext().hasUI, false);
  assert.equal(await native[0].extensionRunner.createContext().ui.confirm("grant?", "never"), false);
  assert.equal(await readFile(marker, "utf8"), "start\n");
  [...sockets][0].write(`${JSON.stringify({ type: "prompt", prompt: prompt("native", "native prompt") })}\n`);
  await until(() => frames.some((frame) => frame.type === "output" && frame.event.type === "settled"));
  const output = frames.filter((frame) => frame.type === "output").map((frame) => frame.event);
  assert.deepEqual(output[0], { type: "turn-start", turnId: "native" });
  assert.deepEqual(output.find((event) => event.type === "text-end"), { type: "text-end", text: "offline native response" });
  const entries = SessionManager.open(mapping.sessionFile).getEntries();
  const tagged = entries.find((entry) => entry.type === "custom_message");
  assert.equal(tagged.customType, "agent-bridge");
  assert.equal(tagged.details.turnId, "native");
  assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, 1);
  assert.equal((await stat(mapping.sessionFile)).mode & 0o777, 0o600);
  await backend.close();
  assert.equal(await readFile(marker, "utf8"), "start\nshutdown\n");
  assert.equal(SessionManager.open(mapping.sessionFile).getSessionId(), mapping.sessionId);
});
