import { afterEach, expect, test } from "bun:test";
import * as v from "valibot";
import type { Config } from "../../src/agent-bridge/config.ts";
import { MessageIdSchema } from "../../src/agent-bridge/domain.ts";
import { TelegramClient as SharedTelegramClient } from "../../src/agent-bridge/telegram/client.ts";
import { Store } from "../../src/agent-bridge/store.ts";
import { normalizeTelegram, TelegramFrontend } from "../../src/agent-bridge/telegram/frontend.ts";
import { type TelegramRequest, type TelegramAPI, TelegramHttpClient as TelegramClient } from "../../src/agent-bridge/telegram/api.ts";
import { BotSchema, type TelegramMessage, TelegramMessageSchema } from "../../src/agent-bridge/telegram/schemas.ts";
import { TelegramError, TelegramDeliveryUnknown } from "../../src/agent-bridge/telegram/errors.ts";
import { seed, topic } from "./fixtures.ts";

const bot = { id: 99, username: "TaskBot" };
const config: Config = { database: ":memory:", ownerTelegramUserIds: ["7"] };
const stores: Store[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function message(
	id: number,
	extra: Partial<v.InferInput<typeof TelegramMessageSchema>> = {},
): TelegramMessage {
	return v.parse(TelegramMessageSchema, {
		message_id: id,
		chat: { id: -1001, type: "supergroup", is_forum: true },
		from: { id: 7 },
		is_topic_message: true,
		message_thread_id: 42,
		text: "hello",
		...extra,
	});
}
function mention(
	id: number,
	extra: Partial<v.InferInput<typeof TelegramMessageSchema>> = {},
): TelegramMessage {
	return message(id, {
		text: "@TaskBot fix it",
		entities: [{ type: "mention", offset: 0, length: 8 }],
		...extra,
	});
}
function command(
	id: number,
	text: string,
	extra: Partial<v.InferInput<typeof TelegramMessageSchema>> = {},
): TelegramMessage {
	return message(id, {
		text,
		entities: [
			{
				type: "bot_command",
				offset: 0,
				length: text.indexOf(" ") < 0 ? text.length : text.indexOf(" "),
			},
		],
		...extra,
	});
}
class FakeAPI implements TelegramAPI {
	calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	error: Error | null = null;
	onSend: (() => Promise<void>) | null = null;
	async call<S extends v.GenericSchema>({
		method,
		body,
		schema,
	}: TelegramRequest<S>): Promise<v.InferOutput<S>> {
		this.calls.push({ method, body });
		if (this.error) throw this.error;
		if (this.onSend) await this.onSend();
		return v.parse(schema, message(100, { from: { id: 99, is_bot: true } }));
	}
}
function setup(owners = ["7"]) {
	const store = new Store(":memory:");
	stores.push(store);
	const api = new FakeAPI();
	return {
		store,
		api,
		adapter: new TelegramFrontend(
			{ ...config, ownerTelegramUserIds: owners },
			store,
			api,
			bot,
			new SharedTelegramClient(() => ({ botToken: "test" })),
		),
	};
}
function normalized(raw: TelegramMessage) {
	const event = normalizeTelegram(raw, bot);
	if (!event) throw new Error("Expected a normalized message");
	return event;
}

test("mentions use entities and UTF-16 offsets, not substring guesses", () => {
	const event = normalized(
		message(10, {
			text: "😀 @taskbot fix it",
			entities: [{ type: "mention", offset: 3, length: 8 }],
		}),
	);
	expect(event.message.route.kind).toBe("start");
	expect(event.message.text).toBe("😀  fix it");
	expect(event.message.container).toEqual(topic);
	expect(
		normalized(message(11, { text: "@TaskBot no entity" })).message.route.kind,
	).toBe("ignore");
	expect(
		normalized(
			message(12, {
				text: "@OtherBot hi",
				entities: [{ type: "mention", offset: 0, length: 9 }],
			}),
		).message.route.kind,
	).toBe("ignore");
});

test("caption and named mention entities are supported", () => {
	const event = normalized(
		message(10, {
			text: undefined,
			caption: "TaskBot inspect screenshot",
			caption_entities: [
				{ type: "text_mention", offset: 0, length: 7, user: { id: 99 } },
			],
		}),
	);
	expect(event.message.route.kind).toBe("start");
	expect(event.message.text).toBe("inspect screenshot");
});

test("implicit topic-root replies are not task replies", () => {
	expect(
		normalized(
			message(10, {
				reply_to_message: message(42, { forum_topic_created: {} }),
			}),
		).message.route.kind,
	).toBe("ignore");
	expect(
		normalized(message(11, { reply_to_message: message(42) })).message.route
			.kind,
	).toBe("ignore");
	expect(
		normalized(message(12, { reply_to_message: message(10) })).message.route,
	).toEqual({ kind: "reply", parentId: v.parse(MessageIdSchema, "10") });
});

test("General uses its own container despite incidental thread IDs", () => {
	expect(
		normalized(
			message(10, { is_topic_message: undefined, message_thread_id: 999 }),
		).message.container.channelId,
	).toBe("general");
	expect(
		normalized(message(11, { message_thread_id: 1 })).message.container
			.channelId,
	).toBe("general");
});

test("plain groups are supported; private chats, bots, anonymous senders and service messages use other routes", () => {
	expect(normalized(message(10, { chat: { id: -1, type: "group" }, is_topic_message: undefined, message_thread_id: undefined })).message.container.channelId).toBe("general");
	for (const extra of [
		{ chat: { id: 7, type: "private" } },
		{ sender_chat: {} },
		{ from: { id: 8, is_bot: true } },
		{ forum_topic_created: {} },
	]) {
		expect(normalizeTelegram(message(10, extra), bot)).toBeNull();
	}
});

test("commands for another bot are ignored; unknown commands keep task routing", () => {
	expect(normalizeTelegram(command(10, "/bind@OtherBot /tmp"), bot)).toBeNull();
	expect(normalized(command(11, "/bind@TaskBot /tmp")).command).toEqual({
		kind: "bind",
		directory: "/tmp",
	});
	const raw = command(12, "/foo @TaskBot do this", {
		entities: [
			{ type: "bot_command", offset: 0, length: 4 },
			{ type: "mention", offset: 5, length: 8 },
		],
	});
	expect(normalized(raw).command).toBeNull();
	expect(normalized(raw).message.route.kind).toBe("start");
});

test("digit-containing commands remain text and explicit mentions take precedence over help", async () => {
	const { adapter, store } = setup();
	seed(store);
	for (const [index, name] of ["/foo2", "/help"].entries()) {
		await adapter.accept({
			update_id: index + 1,
			message: command(index + 10, `${name} @TaskBot do this`, {
				entities: [
					{ type: "bot_command", offset: 0, length: name.length },
					{ type: "mention", offset: name.length + 1, length: 8 },
				],
			}),
		});
	}
	await adapter.accept({
		update_id: 3,
		message: command(12, "/test2", { reply_to_message: message(10) }),
	});
	expect(store.snapshot().tasks).toHaveLength(2);
	expect(store.snapshot().inputs).toHaveLength(3);
});

test("unbound topics remain inactive and replayed updates create no duplicates", async () => {
	const { adapter, store } = setup();
	expect(
		(await adapter.accept({ update_id: 1, message: mention(10) }))?.kind,
	).toBe("ignored");
	seed(store);
	const event = { update_id: 2, message: mention(11) };
	expect((await adapter.accept(event))?.kind).toBe("routed");
	expect(await adapter.accept(event)).toBeNull();
	expect(store.snapshot().tasks).toHaveLength(1);
	expect(store.snapshot().outbox).toHaveLength(2);
	expect(store.nextReply(adapter.transportId)?.text).toContain("Use /bind");
});

test("discovery mode does not route tasks or let anyone bind directories", async () => {
	const { adapter, store } = setup([]);
	seed(store);
	expect(
		await adapter.accept({ update_id: 1, message: mention(10) }),
	).toBeNull();
	await adapter.accept({ update_id: 2, message: command(11, "/unbind") });
	expect(store.binding(topic)).not.toBeNull();
	await adapter.accept({ update_id: 3, message: command(12, "/where") });
	expect(store.snapshot().outbox).toHaveLength(2);
});

test("mapped reply chains take precedence over mentions",  async () => {
	const { adapter, store } = setup();
	seed(store);
	await adapter.accept({ update_id: 1, message: mention(10) });
	await adapter.accept({
		update_id: 2,
		message: mention(11, { reply_to_message: message(10) }),
	});
	await adapter.accept({
		update_id: 3,
		message: message(12, { reply_to_message: message(10) }),
	});
	const snapshot = store.snapshot();
	expect(snapshot.tasks).toHaveLength(1);
	expect(snapshot.inputs).toHaveLength(3);
	expect(snapshot.inputs.at(0)?.taskId).toBe(snapshot.inputs.at(2)?.taskId);
	expect(snapshot.inputs.at(1)?.taskId).toBe(snapshot.inputs.at(0)?.taskId);
});

test("successful acknowledgements keep the topic and map bot reply IDs", async () => {
	const { adapter, store, api } = setup();
	seed(store);
	await adapter.accept({ update_id: 1, message: mention(10) });
	await adapter.flushOne();
	expect(api.calls.at(0)?.body).toMatchObject({
		message_thread_id: 42,
		reply_parameters: { message_id: 10, allow_sending_without_reply: false },
	});
	await adapter.accept({
		update_id: 2,
		message: message(11, { reply_to_message: message(100) }),
	});
	expect(store.snapshot().inputs).toHaveLength(2);
});

test("reply ingestion can recover an acknowledgement before sendMessage returns", async () => {
	const { adapter, store, api } = setup();
	seed(store);
	await adapter.accept({ update_id: 1, message: mention(10) });
	const pending = store.nextReply(adapter.transportId);
	if (!pending) throw new Error("Expected an acknowledgement");
	api.onSend = async () => {
		await adapter.accept({
			update_id: 2,
			message: message(11, {
				reply_to_message: message(100, {
					from: { id: 99, is_bot: true },
					text: pending.text,
				}),
			}),
		});
	};
	await adapter.flushOne();
	expect(store.snapshot().inputs).toHaveLength(2);
});

test("published acknowledgements also recover after a missing send result, but copied text does not", async () => {
	const { adapter, store } = setup();
	seed(store);
	await adapter.accept({ update_id: 1, message: mention(10) });
	const pending = store.nextReply(adapter.transportId);
	if (!pending) throw new Error("Expected an acknowledgement");
	await adapter.accept({
		update_id: 2,
		message: message(11, {
			reply_to_message: message(100, { from: { id: 8 }, text: pending.text }),
		}),
	});
	expect(store.snapshot().inputs).toHaveLength(1);
	await adapter.accept({
		update_id: 3,
		message: message(12, {
			reply_to_message: message(101, { from: { id: 99 }, text: pending.text }),
		}),
	});
	expect(store.snapshot().inputs).toHaveLength(2);
});

test("uncertain reply recovery refuses identical text from distinct conversations", async () => {
  const { adapter, store } = setup();
  seed(store);
  const first = await adapter.accept({ update_id: 1, message: mention(10) });
  const second = await adapter.accept({ update_id: 2, message: mention(11) });
  if (first?.kind !== "routed" || second?.kind !== "routed") throw new Error("Missing conversations");
  const text = "Only the attachment owner can release this thread.";
  for (const task of [first.task, second.task, first.task]) {
    store.enqueue({ transportId: adapter.transportId, container: task.container, replyToId: task.rootId, taskId: task.id, text });
  }
  const parent = message(100, { from: { id: 99, is_bot: true }, text });
  expect((await adapter.accept({ update_id: 3, message: message(12, { reply_to_message: parent }) }))?.kind).toBe("ignored");
  expect(store.taskForMessage({ container: first.task.container, messageId: v.parse(MessageIdSchema, "100") })).toBeNull();
  expect(store.snapshot().inputs).toHaveLength(2);
  store.recoverBotReply({ transportId: adapter.transportId, container: first.task.container, messageId: v.parse(MessageIdSchema, "101"), text: store.nextReply(adapter.transportId)!.text });
  expect(store.taskForMessage({ container: first.task.container, messageId: v.parse(MessageIdSchema, "101") })?.id).toBe(first.task.id);
});

test("stale offsets expire before Telegram's idle ID reset and lower new IDs are accepted", async () => {
	const { adapter, store } = setup();
	seed(store);
	store.advance({
		transportId: adapter.transportId,
		nextOffset: 5001,
		now: Date.now() - 8 * 24 * 60 * 60 * 1000,
	});
	expect(store.offset(adapter.transportId)).toBeUndefined();
	await adapter.accept({ update_id: 100, message: mention(10) });
	expect(store.offset(adapter.transportId)).toBe(101);
	expect(store.snapshot().tasks).toHaveLength(1);
	expect(
		await adapter.accept({ update_id: 100, message: mention(10) }),
	).toBeNull();
});

test("idle reset clears obsolete update IDs, including a colliding new update ID",async()=>{
 const {adapter,store}=setup();seed(store);
 await adapter.accept({update_id:100,message:mention(10)});
 store.advance({transportId:adapter.transportId,nextOffset:101,now:Date.now()-7*24*60*60*1000});
 await adapter.accept({update_id:100,message:mention(11)});
 expect(store.snapshot().tasks).toHaveLength(2);expect(store.offset(adapter.transportId)).toBe(101);
});
test("unknown acknowledgement outcomes fail without automatic resend",async()=>{
 const {adapter,store,api}=setup();seed(store);
 await adapter.accept({update_id:1,message:mention(10)});api.error=new TelegramDeliveryUnknown();
 await adapter.flushOne();await adapter.flushOne();
 expect(api.calls).toHaveLength(1);expect(store.snapshot().outbox[0]?.state).toBe("failed");
});

test("General sends omit message_thread_id", async () => {
	const { adapter, store, api } = setup();
	seed(store);
	const id = store.binding(topic);
	if (!id) throw new Error("Expected a binding");
	store.bind({ container: { ...topic, channelId: "general" }, projectId: id });
	await adapter.accept({
		update_id: 1,
		message: mention(10, { message_thread_id: 1 }),
	});
	await adapter.flushOne();
	expect(api.calls.at(0)?.body).not.toHaveProperty("message_thread_id");
});

test("rate limits defer replies; missing anchors fail instead of sending elsewhere", async () => {
	const { adapter, store, api } = setup();
	seed(store);
	await adapter.accept({ update_id: 1, message: mention(10) });
	api.error = new TelegramError(429, 30);
	await adapter.flushOne();
	expect(store.nextReply(adapter.transportId)).toBeNull();
	const pending = store.nextReply(adapter.transportId, Date.now() + 31_000);
	if (!pending) throw new Error("Expected the deferred acknowledgement");
	store.failed({ reply: pending, error: "make available", retryAt: 0 });
	api.error = new TelegramError(400);
	await adapter.flushOne();
	expect(store.snapshot().outbox.at(0)).toMatchObject({ state: "failed" });
});

test("unsupported updates still commit their cursor", async () => {
	const { adapter, store } = setup();
	await adapter.accept({ update_id: 99 });
	expect(store.offset(adapter.transportId)).toBe(100);
	expect(store.snapshot().tasks).toHaveLength(0);
});

test("HTTP client validates response schemas and redacts token-bearing failures", async () => {
	const client = new TelegramClient("SECRET", async () => {
		throw new Error("https://api.telegram.org/botSECRET/getMe");
	});
	await expect(
		client.call({ method: "getMe", body: {}, schema: BotSchema }),
	).rejects.toThrow("redacted");
	const malformed = new TelegramClient(
		"SECRET",
		async () =>
			new Response(
				JSON.stringify({ ok: true, result: { id: "99", username: "SECRET" } }),
			),
	);
	await expect(
		malformed.call({ method: "getMe", body: {}, schema: BotSchema }),
	).rejects.toThrow("invalid result");
	const denied = new TelegramClient(
		"SECRET",
		async () =>
			new Response(
				JSON.stringify({ ok: false, error_code: 403, description: "SECRET" }),
				{ status: 403 },
			),
	);
	await expect(
		denied.call({ method: "getMe", body: {}, schema: BotSchema }),
	).rejects.toThrow("Telegram API error 403");
	expect(v.safeParse(TelegramMessageSchema, { message_id: "10" }).success).toBe(
		false,
	);
});
