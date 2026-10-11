import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { DiscordAdapter } from "../../src/agent-bridge/discord/adapter.ts";
import { type DiscordAPI, DiscordAPIError, type DiscordCreateMessage, DiscordDeliveryUnknown, DiscordREST } from "../../src/agent-bridge/discord/api.ts";
import { DiscordFrontend } from "../../src/agent-bridge/discord/frontend.ts";
import { DiscordGateway, DISCORD_MESSAGE_INTENTS } from "../../src/agent-bridge/discord/gateway.ts";
import { DiscordPermissions, normalizeDiscord } from "../../src/agent-bridge/discord/normalize.ts";
import { type DiscordChannel, DiscordMessageSchema } from "../../src/agent-bridge/discord/schemas.ts";
import { DiscordSession } from "../../src/agent-bridge/discord/session.ts";
import { chunkDiscordText, DiscordTransport } from "../../src/agent-bridge/discord/transport.ts";
import { MessageIdSchema as IncomingId, TaskSchema } from "../../src/agent-bridge/domain.ts";
import type { AgentPort } from "../../src/agent-bridge/frontend.ts";
import type { PreparedPrompt } from "../../src/agent-bridge/protocol.ts";
import { Router } from "../../src/agent-bridge/router.ts";
import { Store } from "../../src/agent-bridge/store.ts";

const signal = new AbortController().signal;
const channel: DiscordChannel = { id: "200", guild_id: "100", type: 0 };
const raw = { id: "300", channel_id: "200", guild_id: "100", author: { id: "400", username: "human" }, content: "hello", type: 0 };
const context = { channel, botId: "500" };
const task = v.parse(TaskSchema, { id: "task_discord", projectId: "project", container: { platform: "discord", spaceId: "100", channelId: "200" }, rootId: "300", title: "Worker", createdAt: "2026-01-01" });
const body: DiscordCreateMessage = { content: "hello", nonce: "nonce", enforce_nonce: true, allowed_mentions: { parse: [], users: [], replied_user: false } };
function apiResponse(id = "600") { return { ...raw, id, author: { id: "500", username: "bot", bot: true } }; }
function fetcher(run: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return run as typeof fetch;
}
function publishing() {
  const calls: { channelId: string; body: DiscordCreateMessage; file?: { data: Blob; name: string } }[] = [];
  const mapped: string[] = [];
  let live = true;
  const api: DiscordAPI = {
    async createMessage(channelId, body, _signal, file) { calls.push({ channelId, body, file }); return { id: String(600 + calls.length), channel_id: channelId }; },
    async typing() {},
  };
  const transport = new DiscordTransport(api, {
    resolve: (_task, id) => ({ channelId: "200", messageId: id ?? "300" }),
    current: () => live,
    sent: (_task, _channelId, id) => mapped.push(id),
    knownUser: (_task, id) => id === "400",
  });
  return { api, transport, calls, mapped, revoke: () => { live = false; } };
}

test("ordinary channel input and bot mentions select Main, not a worker", () => {
  expect(normalizeDiscord(raw, context)?.message.route).toEqual({ kind: "default" });
  const input = normalizeDiscord({ ...raw, content: "<@500> do this <@!500>" }, context)!;
  expect(input.message.text).toBe("do this");
  expect(input.message.route.kind).toBe("default");
});
test("snowflakes are strings, including IDs larger than safe integers", () => {
  const id = "18446744073709551615";
  expect(v.parse(DiscordMessageSchema, { ...raw, id }).id).toBe(id);
  expect(() => v.parse(DiscordMessageSchema, { ...raw, id: Number(id) })).toThrow();
});
test("a DM is an ordinary bindable channel space with no owner route", () => {
  const message = normalizeDiscord({ ...raw, guild_id: undefined }, { ...context, channel: { id: "200", type: 1 } })!.message;
  expect(message.container).toEqual({ platform: "discord", spaceId: "dm:200", channelId: "200" });
  expect(message.route.kind).toBe("default");
});
test("replies are exact explicit targets; mentions do not create or retarget", () => {
  const input = normalizeDiscord({ ...raw, type: 19, content: "<@500> follow up", message_reference: { message_id: "301", channel_id: "200", guild_id: "100" } }, context)!;
  expect(input.message.route).toEqual({ kind: "reply", parentId: v.parse(IncomingId, "301") });
  for (const reference of [{ channel_id: "201", message_id: "301" }, { channel_id: "200", message_id: "301", guild_id: "101" }, { channel_id: "200", message_id: "301", type: 1 }, {}])
    expect(() => normalizeDiscord({ ...raw, type: 19, message_reference: reference }, context)).toThrow();
});
test("forwards do not impersonate reply provenance", () => {
  expect(normalizeDiscord({ ...raw, message_reference: { type: 1, message_id: "301", channel_id: "201" } }, context)?.message.route).toEqual({ kind: "default" });
});
test("bot, webhook, system and empty inputs are not admitted", () => {
  for (const patch of [{ author: { ...raw.author, bot: true } }, { author: { ...raw.author, id: "500" } }, { webhook_id: "700" }, { type: 18 }, { content: "" }])
    expect(normalizeDiscord({ ...raw, ...patch }, context)).toBeNull();
});
test("wire/channel metadata mismatches and unsupported channel types fail closed", () => {
  expect(() => normalizeDiscord(raw, { ...context, channel: { ...channel, id: "201" } })).toThrow();
  expect(() => normalizeDiscord(raw, { ...context, channel: { ...channel, type: 15 } })).toThrow();
});
test("native threads require a trusted existing shared-thread alias", () => {
  const threaded = { ...context, channel: { ...channel, type: 11, parent_id: "201" } };
  expect(() => normalizeDiscord(raw, threaded)).toThrow("Unknown Discord native thread");
  const result = normalizeDiscord(raw, { ...threaded, nativeThreadRootId: "301" })!.message;
  expect(result.container.channelId).toBe("201");
  expect(result.route).toEqual({ kind: "thread", threadId: v.parse(IncomingId, "301") });
});
test("command syntax is adapter-local; semantics and permissions remain shared", () => {
  expect(normalizeDiscord({ ...raw, content: "/BiNd /srv/project" }, context)?.command).toEqual({ name: "bind", argument: "/srv/project" });
  const permissions = new DiscordPermissions(["400"]);
  expect(permissions.canBind("400")).toBe(true);
  expect(permissions.canBind("401")).toBe(false);
  expect(permissions.canControl("400", "401")).toBe(false);
  expect(permissions.canControl("400", "400")).toBe(true);
  expect(new DiscordPermissions([]).canBind("400")).toBe(false);
});
test("adapter ignores edits, rejects unknown explicit targets, and uses the shared Router", async () => {
  const store = new Store(":memory:");
  try {
    store.saveProject({ id: task.projectId, name: "project", directory: "/srv/project" });
    store.bind({ container: task.container, projectId: task.projectId });
    const router = new Router(store);
    const routed: string[] = [];
    const adapter = new DiscordAdapter("500", ["400"], {
      async accept(input) { const result = router.route(input.message); if (result.kind === "routed") routed.push(result.task.id); },
      knownTarget(container, route) {
        const mapped = route.kind === "reply" ? store.taskForMessage({ container, messageId: v.parse(IncomingId, route.parentId) }) : null;
        return !!mapped && mapped.projectId === store.binding(container);
      },
      nativeThreadRoot: () => undefined,
    }, async () => channel);
    expect(await adapter.dispatch("MESSAGE_UPDATE", {}, signal)).toBe("ignored");
    expect(await adapter.dispatch("MESSAGE_CREATE", raw, signal)).toBe("accepted");
    expect(await adapter.dispatch("MESSAGE_CREATE", { ...raw, id: "302", type: 19, message_reference: { message_id: "301", channel_id: "200" } }, signal)).toBe("unknown-target");
    expect(await adapter.dispatch("MESSAGE_CREATE", { ...raw, id: "303", type: 19, message_reference: { message_id: "300", channel_id: "200" } }, signal)).toBe("accepted");
    expect(routed[0]).toBe(routed[1]);
    expect(store.snapshot().tasks).toHaveLength(1);
  } finally { store.close(); }
});
test("REST uses Bot authorization, official v10 URL and validated snowflake paths", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const api = new DiscordREST("test-token", fetcher(async (url, init) => { calls.push({ url, init }); return Response.json(apiResponse()); }));
  await api.createMessage("200", body, signal);
  expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/200/messages");
  expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bot test-token");
  expect(calls[0]!.init!.redirect).toBe("error");
  expect(await api.createMessage("../users/@me", body, signal).catch((error) => error)).toBeInstanceOf(Error);
  expect(calls).toHaveLength(1);
});
test("REST retries only a definitive rate-limit rejection, respecting retry_after", async () => {
  let calls = 0;
  const api = new DiscordREST("test-token", fetcher(() => ++calls === 1 ? Response.json({ retry_after: 0, global: true }, { status: 429 }) : Response.json(apiResponse())));
  expect((await api.createMessage("200", body, signal)).id).toBe("600");
  expect(calls).toBe(2);
});
test("REST bounds repeated rate-limit responses", async () => {
  let calls = 0;
  const api = new DiscordREST("test-token", fetcher(() => { calls++; return Response.json({ retry_after: 0 }, { status: 429 }); }));
  await expect(api.createMessage("200", body, signal)).rejects.toBeInstanceOf(DiscordAPIError);
  expect(calls).toBe(3);
});
test("REST never retries uncertain network, server, malformed success or wrong-channel sends", async () => {
  for (const outcome of [() => { throw new Error("connection lost"); }, () => Response.json({}, { status: 502 }), () => new Response("bad gateway", { status: 502 }), () => new Response("not json"), () => Response.json({ ...apiResponse(), channel_id: "201" })]) {
    let calls = 0;
    const api = new DiscordREST("test-token", fetcher(() => { calls++; return outcome(); }));
    await expect(api.createMessage("200", body, signal)).rejects.toBeInstanceOf(DiscordDeliveryUnknown);
    expect(calls).toBe(1);
  }
});
test("REST rejects authorization errors without logging tokens or server body", async () => {
  const api = new DiscordREST("test-token", fetcher(() => Response.json({ code: 50013, message: "test-token" }, { status: 403 })));
  try { await api.createMessage("200", body, signal); throw new Error("expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(DiscordAPIError); expect(String(error)).not.toContain("test-token"); }
});
test("REST stops using a bot credential after a definitive 401", async () => {
  let calls = 0;
  const api = new DiscordREST("test-token", fetcher(() => { calls++; return Response.json({ code: 0 }, { status: 401 }); }));
  await expect(api.createMessage("200", body, signal)).rejects.toBeInstanceOf(DiscordAPIError);
  await expect(api.typing("200", signal)).rejects.toBeInstanceOf(DiscordAPIError);
  expect(calls).toBe(1);
});
test("REST honors exhausted-route deadlines and waiting remains abortable", async () => {
  let calls = 0;
  const api = new DiscordREST("test-token", fetcher(() => { calls++; return Response.json(apiResponse(), { headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "5" } }); }));
  await api.createMessage("200", body, signal);
  const abort = new AbortController();
  const waiting = api.createMessage("200", body, abort.signal);
  setTimeout(() => abort.abort(), 5);
  await expect(waiting).rejects.toThrow();
  expect(calls).toBe(1);
});

test("REST handles typing no-content and abort before network", async () => {
  let calls = 0;
  const api = new DiscordREST("test-token", fetcher(() => { calls++; return new Response(null, { status: 204 }); }));
  await api.typing("200", signal);
  const abort = new AbortController(); abort.abort();
  await expect(api.typing("200", abort.signal)).rejects.toThrow();
  expect(calls).toBe(1);
});
test("reply chunks retain exact anchors and disable unintended mentions", async () => {
  const { transport, calls, mapped } = publishing();
  await transport.reply(task, "300", `${"x".repeat(1999)}😀 @everyone <@401>`, [], signal);
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.body.content).join("")).toBe(`${"x".repeat(1999)}😀 @everyone <@401>`);
  for (const call of calls) {
    expect(call.body.content!.length).toBeLessThanOrEqual(2000);
    expect(call.body.message_reference).toEqual({ type: 0, channel_id: "200", message_id: "300", fail_if_not_exists: true });
    expect(call.body.allowed_mentions).toEqual({ parse: [], users: [], replied_user: false });
    expect(call.body.nonce.length).toBeLessThanOrEqual(25);
    expect(call.body.enforce_nonce).toBe(true);
  }
  expect(mapped).toEqual(["601", "602"]);
  expect(chunkDiscordText("x".repeat(2000))).toHaveLength(1);
});
test("explicit mention IDs are known, bounded and visible; automatic pings stay off", async () => {
  const { transport, calls } = publishing();
  await transport.reply(task, "300", "hello", ["400", "400"], signal);
  expect(calls[0]!.body.content).toBe("<@400>\nhello");
  expect(calls[0]!.body.allowed_mentions.users).toEqual(["400"]);
  await expect(transport.reply(task, "300", "hello", ["401"], signal)).rejects.toThrow("known users");
  expect(calls).toHaveLength(1);
});
test("partial multi-message sends map acknowledged IDs even when later delivery fails", async () => {
  const { transport, api, mapped } = publishing();
  let calls = 0;
  api.createMessage = async () => { if (++calls === 2) throw new DiscordDeliveryUnknown(); return { id: "601", channel_id: "200" }; };
  await expect(transport.reply(task, "300", "x".repeat(3000), [], signal)).rejects.toThrow();
  expect(mapped).toEqual(["601"]);
});
test("shared runtime sent callback maps each successful reply chunk", async () => {
  const { transport, mapped } = publishing();
  const sent: string[] = [];
  await transport.reply(task, "300", "x".repeat(3000), [], signal, (id) => sent.push(id));
  expect(sent).toEqual(["601", "602"]);
  expect(mapped).toEqual([]);
});
test("revoked scopes fail closed and anchors create a replyable platform message", async () => {
  const { transport, calls, revoke } = publishing();
  expect(await transport.publishAnchor(task, signal)).toBe("601");
  expect(calls[0]!.body.content).toBe("Worker");
  revoke();
  await expect(transport.reply(task, "300", "late text", [], signal)).rejects.toThrow("no longer current");
  expect(calls).toHaveLength(1);
});
test("native wire resolution cannot silently discard an explicit message anchor", async () => {
  const { api } = publishing();
  const transport = new DiscordTransport(api, { resolve: () => ({ channelId: "201" }), current: () => true, sent() {}, knownUser: () => true });
  await expect(transport.reply(task, "300", "hello", [], signal)).rejects.toThrow("explicit message target");
});
test("attachments are bounded, multipart-ready and anchored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discord-bridge-"));
  try {
    const path = join(directory, "file.txt"); await writeFile(path, "hello");
    const { transport, calls, mapped } = publishing();
    await transport.sendAttachment(task, { path, fileName: "file.txt" }, signal);
    expect(calls[0]!.file!.name).toBe("file.txt");
    expect(await calls[0]!.file!.data.text()).toBe("hello");
    expect(calls[0]!.body.attachments).toEqual([{ id: 0, filename: "file.txt" }]);
    expect(calls[0]!.body.message_reference!.message_id).toBe("300");
    expect(mapped).toEqual(["601"]);
    await expect(transport.sendAttachment(task, { path, fileName: "../file.txt" }, signal)).rejects.toThrow();
    await expect(new DiscordTransport(transport.api, { resolve: () => ({ channelId: "200", messageId: "300" }), current: () => true, sent() {}, knownUser: () => true }, 1).sendAttachment(task, { path, fileName: "file.txt" }, signal)).rejects.toThrow("upload limit");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("attachments fail closed until a saved thread has an acknowledged platform anchor", async () => {
  const { api } = publishing();
  const transport = new DiscordTransport(api, { resolve: () => ({ channelId: "200" }), current: () => true, sent() {}, knownUser: () => true });
  await expect(transport.sendAttachment(task, { path: "/unused", fileName: "file.txt" }, signal)).rejects.toThrow("reply anchor");
});

test("DiscordSession uses the shared AgentPort and never publishes ordinary assistant output", async () => {
  const prompts: PreparedPrompt[] = [];
  let current = true;
  const agent: AgentPort = {
    current: () => current,
    async snapshot() { return { idle: true, models: [], thinking: "off", supportedThinking: ["off"], status: "idle" }; },
    async setModel() { return true; }, async setThinking(level) { return level; }, async abort() { return true; }, async compact() { return true; }, async newSession() { return true; },
    prompt(prompt) { prompts.push(prompt); },
  };
  const { transport, calls } = publishing();
  const session = new DiscordSession(agent, task, transport, () => true);
  session.receivePrepared([{ type: "text", text: "[discord user=400 message=300]\nhello" }]);
  expect(session.isRunning).toBe(true);
  session.output({ type: "turn-start", turnId: prompts[0]!.id });
  session.output({ type: "text-end", text: "private saved answer" });
  session.output({ type: "settled" });
  expect(session.isRunning).toBe(false);
  expect(calls).toHaveLength(0);
  current = false;
  expect(() => session.receivePrepared([])).toThrow();
  await session.close();
  expect(session.isLive).toBe(false);
});

test("Discord BridgeFrontend delegates binding, Main admission, replies and /new to shared services", async () => {
  const store = new Store(":memory:");
  const published: DiscordCreateMessage[] = [];
  let outputs = 800;
  const api = new DiscordREST("test-token", fetcher((url, init) => {
    if (url.endsWith("/channels/200")) return Response.json(channel);
    published.push(JSON.parse(String(init?.body)) as DiscordCreateMessage);
    return Response.json(apiResponse(String(++outputs)));
  }));
  const frontend = new DiscordFrontend({ store, api, bot: { id: "500", username: "bot" }, ownerIds: ["400"],
    backend: { async open() { throw new Error("This offline test does not start SDK sessions"); }, async closeRoute() {}, async close() {} },
  });
  const delivered: { taskId: string; text: string }[] = [];
  frontend.runtime.enqueueInput = async (task, deliver) => {
    deliver({ isLive: true, isRunning: false, output() {}, async sendAttachment() {}, async close() {},
      receivePrepared(content) { delivered.push({ taskId: task.id, text: content.filter((part) => part.type === "text").map((part) => part.text).join("\n") }); },
    });
  };
  try {
    // The shared command service rejects nonowners before any project registration.
    await frontend.receive("MESSAGE_CREATE", { ...raw, id: "701", content: `/bind ${tmpdir()}`, author: { id: "401", username: "stranger" } });
    expect(store.binding(task.container)).toBeNull();
    await frontend.receive("MESSAGE_CREATE", { ...raw, id: "702", content: `/bind ${tmpdir()}` });
    expect(store.binding(task.container)).not.toBeNull();
    await frontend.receive("MESSAGE_CREATE", { ...raw, id: "703", content: "Main request" });
    await frontend.receive("MESSAGE_CREATE", { ...raw, id: "704", content: "/new worker request" });
    await frontend.receive("MESSAGE_CREATE", { ...raw, id: "705", content: "Another Main request" });
    await frontend.receive("MESSAGE_CREATE", { ...raw, id: "706", type: 19, content: "worker followup", message_reference: { message_id: "704", channel_id: "200" } });
    expect(delivered[0]!.taskId).toBe(delivered[2]!.taskId);
    expect(delivered[1]!.taskId).toBe(delivered[3]!.taskId);
    expect(delivered[0]!.taskId).not.toBe(delivered[1]!.taskId);
    expect(delivered[0]!.text).toContain('[discord from="human" user=400 message=703]');
    expect(delivered[3]!.text).toContain("message=706 reply=704");
    expect(await frontend.receive("MESSAGE_CREATE", { ...raw, id: "707", type: 19, message_reference: { message_id: "999", channel_id: "200" } })).toBe("unknown-target");
    expect(delivered).toHaveLength(4);
    expect(store.snapshot().tasks).toHaveLength(2);
    expect(published).toHaveLength(2); // Only explicit command replies, never generic assistant text.
    expect(frontend.identity.id).toBe("discord:500");
    expect(frontend.mode).toBe("routing");
  } finally { await frontend.close(); store.close(); }
});

test("Discord BridgeFrontend binds DMs as ordinary spaces and retains history on unbind", async () => {
  const store = new Store(":memory:");
  const dmChannel = { id: "200", type: 1 };
  const api = new DiscordREST("test-token", fetcher((url) => url.endsWith("/channels/200") ? Response.json(dmChannel) : Response.json({ ...apiResponse(), guild_id: undefined })));
  const frontend = new DiscordFrontend({ store, api, bot: { id: "500", username: "bot" }, ownerIds: ["400"],
    backend: { async open() { throw new Error("No SDK startup in this test"); }, async closeRoute() {}, async close() {} },
  });
  frontend.runtime.enqueueInput = async () => {};
  try {
    await frontend.receive("MESSAGE_CREATE", { ...raw, guild_id: undefined, id: "701", content: `/bind ${tmpdir()}` });
    const dm = { platform: "discord" as const, spaceId: "dm:200", channelId: "200" };
    expect(store.binding(dm)).not.toBeNull();
    await frontend.receive("MESSAGE_CREATE", { ...raw, guild_id: undefined, id: "702" });
    expect(store.tasksFor(dm)).toHaveLength(1);
    await frontend.receive("MESSAGE_CREATE", { ...raw, guild_id: undefined, id: "703", content: "/unbind" });
    expect(store.binding(dm)).toBeNull();
    expect(store.tasksFor(dm)).toHaveLength(1);
  } finally { await frontend.close(); store.close(); }
});

test("Gateway identifies with required intents and jittered heartbeats", () => {
  const gateway = new DiscordGateway("test-token", () => 0.5);
  gateway.opened();
  const actions = gateway.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  expect(actions[0]).toEqual({ type: "heartbeat-timer", delayMs: 500 });
  expect(actions[1]).toMatchObject({ type: "send", payload: { op: 2, d: { intents: DISCORD_MESSAGE_INTENTS } } });
  expect(gateway.heartbeat()[0]).toEqual({ type: "send", payload: { op: 1, d: null } });
  expect(gateway.heartbeat()).toEqual([{ type: "reconnect", delayMs: 0, resume: false }]);
});
test("server-requested heartbeats do not cause an imminent periodic tick to reconnect prematurely", () => {
  const gateway = new DiscordGateway("test-token");
  gateway.opened();
  gateway.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  expect(gateway.receive({ op: 1, d: null })[0]).toMatchObject({ type: "send", payload: { op: 1 } });
  expect(gateway.heartbeat()[0]).toMatchObject({ type: "send", payload: { op: 1 } });
  expect(gateway.heartbeat()[0]).toMatchObject({ type: "reconnect" });
});

test("Gateway heartbeats use sequence and reconnect resumes the exact Gateway session", () => {
  const gateway = new DiscordGateway("test-token", () => 0.5);
  gateway.opened(); gateway.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  gateway.receive({ op: 0, s: 7, t: "READY", d: { session_id: "session", resume_gateway_url: "wss://gateway-us-east1.discord.gg" } });
  expect(gateway.receive({ op: 1, d: null })[0]).toEqual({ type: "send", payload: { op: 1, d: 7 } });
  gateway.receive({ op: 11, d: null });
  expect(gateway.disconnected(1006)[0]).toMatchObject({ resume: true });
  gateway.opened();
  const actions = gateway.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  expect(actions[1]).toMatchObject({ type: "send", payload: { op: 6, d: { session_id: "session", seq: 7 } } });
  expect(gateway.url("wss://gateway.discord.gg")).toBe("wss://gateway-us-east1.discord.gg/?v=10&encoding=json");
});
test("Gateway fatal configuration errors stop; invalid sequences discard session; unsafe URLs fail", () => {
  const gateway = new DiscordGateway("test-token");
  expect(gateway.disconnected(4014)[0]!.type).toBe("fatal");
  expect(gateway.disconnected(4007)[0]).toMatchObject({ resume: false });
  expect(() => gateway.url("wss://discord.gg.evil.example")).toThrow();
  gateway.opened(); gateway.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  expect(() => gateway.receive({ op: 0, s: 1, t: "READY", d: { session_id: "session", resume_gateway_url: "wss://evil.example" } })).toThrow();
  expect(gateway.receive({ op: 9, d: false })[0]).toMatchObject({ resume: false });
});
