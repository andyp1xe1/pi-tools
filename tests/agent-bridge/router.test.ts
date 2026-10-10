import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { type Container, MessageIdSchema } from "../../src/agent-bridge/domain.ts";
import { Router } from "../../src/agent-bridge/router.ts";
import { Store } from "../../src/agent-bridge/store.ts";
import { input, one, routed, seed, topic, two } from "./fixtures.ts";

const stores: Store[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function setup() {
	const store = new Store(":memory:");
	stores.push(store);
	seed(store);
	return { store, router: new Router(store) };
}

test("mention starts a thread only outside mapped reply chains",  () => {
	const { router, store } = setup();
	const a = routed(router.route(input("10", { start: true })));
	const b = routed(router.route(input("11", { start: true, parent: "10" })));
	expect(a.task.rootId).toBe(v.parse(MessageIdSchema, "10"));
	expect(b.task.rootId).toBe(v.parse(MessageIdSchema, "10"));
	expect(b.task.id).toBe(a.task.id);
	const c = routed(router.route(input("12", { start: true, parent: "untracked" })));
	expect(c.task.id).not.toBe(a.task.id);
	expect(store.snapshot().inputs).toHaveLength(3);
});

test("reply chains continue their own task, never the last active task", () => {
	const { router } = setup();
	const a = routed(router.route(input("10", { start: true })));
	const b = routed(router.route(input("11", { start: true })));
	expect(routed(router.route(input("12", { parent: "10" }))).task.id).toBe(
		a.task.id,
	);
	expect(routed(router.route(input("13", { parent: "12" }))).task.id).toBe(
		a.task.id,
	);
	expect(routed(router.route(input("14", { parent: "11" }))).task.id).toBe(
		b.task.id,
	);
	expect(router.route(input("15"))).toEqual({
		kind: "ignored",
		reason: "chatter",
	});
});

test("bot reply IDs also belong to the task", () => {
	const { router, store } = setup();
	const a = routed(router.route(input("10", { start: true })));
	store.mapMessage({
		container: topic,
		messageId: v.parse(MessageIdSchema, "20"),
		taskId: a.task.id,
	});
	expect(routed(router.route(input("21", { parent: "20" }))).task.id).toBe(
		a.task.id,
	);
});

test("unbound topics, untracked replies and ordinary chatter are ignored", () => {
	const { router, store } = setup();
	expect(router.route(input("10"))).toEqual({
		kind: "ignored",
		reason: "chatter",
	});
	expect(router.route(input("11", { parent: "42" }))).toEqual({
		kind: "ignored",
		reason: "chatter",
	});
	expect(
		router.route(input("12", { start: true }, { ...topic, channelId: "99" })),
	).toEqual({ kind: "ignored", reason: "unbound" });
	expect(store.snapshot().tasks).toHaveLength(0);
});

test("duplicate message admission is idempotent", () => {
	const { router, store } = setup();
	const message = input("10", { start: true });
	const a = routed(router.route(message));
	expect(router.route(message)).toEqual({ kind: "duplicate", task: a.task });
	expect(store.snapshot().inputs).toHaveLength(1);
});

test("message IDs cannot cross topic or community boundaries", () => {
	const { router, store } = setup();
	router.route(input("10", { start: true }));
	for (const container of [
		{ ...topic, channelId: "99" },
		{ ...topic, spaceId: "-1002" },
	]) {
		store.bind({ container, projectId: one.id });
		expect(router.route(input("11", { parent: "10" }, container))).toEqual({
			kind: "ignored",
			reason: "chatter",
		});
	}
});

test("unbind pauses routing and a different directory never inherits old tasks", () => {
	const { router, store } = setup();
	router.route(input("10", { start: true }));
	store.unbind(topic);
	expect(router.route(input("11", { parent: "10" })).kind).toBe("ignored");
	store.bind({ container: topic, projectId: two.id });
	expect(router.route(input("12", { parent: "10" }))).toEqual({
		kind: "ignored",
		reason: "project-changed",
	});
	expect(
		routed(router.route(input("13", { start: true }))).task.projectId,
	).toBe(two.id);
});

test("Discord native threads use the same routing core", () => {
	const { router, store } = setup();
	const channel: Container = {
		platform: "discord",
		spaceId: "guild",
		channelId: "parent",
	};
	store.bind({ container: channel, projectId: one.id });
	const a = routed(
		router.route(input("mention", { start: true, thread: "thread" }, channel)),
	);
	expect(
		routed(router.route(input("reply", { thread: "thread" }, channel))).task.id,
	).toBe(a.task.id);
	expect(
		router.route(input("other", { thread: "unknown" }, channel)).kind,
	).toBe("ignored");
});

test("an outer transaction rolls back task, input and polling cursor together", () => {
	const { router, store } = setup();
	expect(() =>
		store.atomic(() => {
			router.route(input("10", { start: true }));
			store.advance({ transportId: "bot", nextOffset: 11 });
			throw new Error("crash");
		}),
	).toThrow("crash");
	expect(store.snapshot().inputs).toHaveLength(0);
	expect(store.snapshot().tasks).toHaveLength(0);
	expect(store.offset("bot")).toBeUndefined();
	expect(store.processed({ transportId: "bot", updateId: 10 })).toBe(false);
});

test("projects, tasks and bot message routes survive reopening SQLite", () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-bridge-"));
	let store = new Store(join(directory, "test.sqlite"));
	try {
		seed(store);
		const a = routed(new Router(store).route(input("10", { start: true })));
		store.mapMessage({
			container: topic,
			messageId: v.parse(MessageIdSchema, "20"),
			taskId: a.task.id,
		});
		store.close();
		store = new Store(join(directory, "test.sqlite"));
		expect(
			routed(new Router(store).route(input("21", { parent: "20" }))).task.id,
		).toBe(a.task.id);
	} finally {
		store.close();
		rmSync(directory, { recursive: true });
	}
});

test("database files are private even under an existing readable parent", () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-bridge-"));
	chmodSync(directory, 0o755);
	const path = join(directory, "db.sqlite");
	writeFileSync(path, "", { mode: 0o644 });
	const store = new Store(path);
	try {
		seed(store);
		for (const suffix of ["", "-wal", "-shm"])
			expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
		expect(statSync(directory).mode & 0o777).toBe(0o755);
	} finally {
		store.close();
		rmSync(directory, { recursive: true });
	}
});

test("a writable ancestor cannot bypass a private immediate database parent", () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-bridge-"));
	try {
		const parent = join(directory, "private");
		mkdirSync(parent, { mode: 0o700 });
		chmodSync(directory, 0o777);
		expect(() => new Store(join(parent, "db.sqlite"))).toThrow("ancestor");
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("database symlinks are refused without modifying their targets", () => {
	const directory = mkdtempSync(join(tmpdir(), "agent-bridge-"));
	try {
		const target = join(directory, "target");
		writeFileSync(target, "keep", { mode: 0o644 });
		symlinkSync(target, join(directory, "db.sqlite"));
		expect(() => new Store(join(directory, "db.sqlite"))).toThrow();
		expect(readFileSync(target, "utf8")).toBe("keep");
		expect(statSync(target).mode & 0o777).toBe(0o644);
	} finally {
		rmSync(directory, { recursive: true });
	}
});
