import { expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../../src/agent-bridge/router.ts";
import { Store } from "../../src/agent-bridge/store.ts";
import { input, routed, seed } from "./fixtures.ts";

const IDLE_EPOCH_MS = 6 * 24 * 60 * 60 * 1000;

test("Store still rejects linked or nonregular database and sidecar destinations", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-files-"));
  try {
    const target = join(root, "untouched");
    writeFileSync(target, "do not change", { mode: 0o644 });
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      for (const kind of ["symlink", "hardlink", "directory"]) {
        const directory = join(root, `${suffix || "database"}-${kind}`);
        mkdirSync(directory, { mode: 0o700 });
        const database = join(directory, "bridge.sqlite");
        const destination = database + suffix;
        if (kind === "symlink") symlinkSync(target, destination);
        else if (kind === "hardlink") linkSync(target, destination);
        else mkdirSync(destination);
        expect(() => new Store(database)).toThrow();
        expect(readFileSync(target, "utf8")).toBe("do not change");
        expect(statSync(target).mode & 0o777).toBe(0o644);
        rmSync(directory, { recursive: true });
      }
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("Store privately opens database files while memory databases bypass path preparation", () => {
  const memory = new Store(":memory:");
  expect(memory.db.filename).toBe(":memory:");
  memory.close();
  const root = mkdtempSync(join(tmpdir(), "bridge-modes-"));
  const path = join(root, "bridge.sqlite");
  try {
    writeFileSync(path, "");
    chmodSync(path, 0o666);
    const store = new Store(path);
    try {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        if (existsSync(path + suffix)) expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

function createThreads(store: Store) {
  seed(store);
  const router = new Router(store);
  return ["10", "11"].map((id) => routed(router.route(input(id, { start: true }))).task);
}

test("threads have independent durable sessions, not a single session per owner", () => {
  const store = new Store(":memory:");
  try {
    const [first, second] = createThreads(store);
    if (!first || !second) throw new Error("Missing thread fixtures");
    expect(store.task(first.id)).toEqual(first);
    expect(store.taskAttachment(first.id)).toBeNull();
    const sessionFile = "/sessions/saved.jsonl";
    store.attachTask({ taskId: first.id, sessionId: "session-a", ownerId: "7", sessionFile });
    store.attachTask({ taskId: second.id, sessionId: "session-b", ownerId: "7", sessionFile });
    store.attachTask({ taskId: first.id, sessionId: "session-a", ownerId: "7", sessionFile });
    expect(store.snapshot().attachments).toHaveLength(2);
    expect(store.taskAttachment(first.id)).toEqual({ taskId: first.id, sessionId: "session-a", ownerId: "7", sessionFile });
    expect(() => store.attachTask({ taskId: first.id, sessionId: "different", ownerId: "7", sessionFile })).toThrow("another session");
    expect(() => store.attachTask({ taskId: first.id, sessionId: "session-a", ownerId: "8", sessionFile })).toThrow("another session");
    store.detachTask(second.id);
    expect(() => store.attachTask({ taskId: second.id, sessionId: "session-a", ownerId: "7", sessionFile })).toThrow("another thread");
    store.detachTask(first.id);
    store.attachTask({ taskId: first.id, sessionId: "replacement", ownerId: "7", sessionFile });
    expect(store.taskAttachment(first.id)?.sessionId).toBe("replacement");
  } finally {
    store.close();
  }
});

test("session associations survive reopening without changing thread history", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-association-"));
  const path = join(root, "bridge.sqlite");
  let store = new Store(path);
  try {
    const [first] = createThreads(store);
    if (!first) throw new Error("Missing thread fixture");
    const sessionFile = join(root, "native.jsonl");
    store.attachTask({ taskId: first.id, sessionId: "saved-session", ownerId: "7", sessionFile });
    expect(() => store.attachTask({ taskId: first.id, sessionId: "saved-session", ownerId: "7", sessionFile: join(root, "wrong.jsonl") })).toThrow("different saved session file");
    store.close();
    store = new Store(path);
    expect(store.taskAttachment(first.id)).toEqual({ taskId: first.id, sessionId: "saved-session", ownerId: "7", sessionFile });
    expect(store.snapshot().inputs).toHaveLength(2);
  } finally {
    store.close();
    rmSync(root, { recursive: true });
  }
});

test("a pre-send claim survives reopening and cannot be claimed or automatically sent again", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-send-claim-"));
  const path = join(root, "bridge.sqlite");
  let store = new Store(path);
  try {
    const [task] = createThreads(store);
    if (!task) throw new Error("Missing thread fixture");
    store.enqueue({ transportId: "bot", container: task.container, replyToId: task.rootId, taskId: task.id, text: "Ready" });
    const reply = store.nextReply("bot");
    if (!reply) throw new Error("Missing reply fixture");
    store.beginSend(reply);
    expect(() => store.beginSend(reply)).toThrow("no longer pending");
    store.close();
    store = new Store(path);
    expect(store.nextReply("bot", Date.now() + 60_000)).toBeNull();
    expect(store.snapshot().outbox[0]).toMatchObject({ state: "failed", attempts: 0 });
    expect(store.statistics("bot")).toMatchObject({ pendingReplies: 0, failedReplies: 1 });
  } finally {
    store.close();
    rmSync(root, { recursive: true });
  }
});

test("ordered polling deduplicates replay without an update ledger", () => {
  const store = new Store(":memory:");
  try {
    expect(store.processed({ transportId: "bot", updateId: 10 }, 1000)).toBe(false);
    for (let nextOffset = 11; nextOffset <= 1010; nextOffset++) {
      store.advance({ transportId: "bot", nextOffset, now: 1000 });
    }
    expect(store.processed({ transportId: "bot", updateId: 10 }, 1000)).toBe(true);
    expect(store.processed({ transportId: "bot", updateId: 1009 }, 1000)).toBe(true);
    expect(store.processed({ transportId: "bot", updateId: 1010 }, 1000)).toBe(false);
    expect(store.processed({ transportId: "other", updateId: 10 }, 1000)).toBe(false);
    expect(store.db.query("SELECT count(*) AS count FROM transport_cursors").get()).toEqual({ count: 1 });
    expect(store.db.query("SELECT name FROM sqlite_master WHERE name='processed_updates'").get()).toBeNull();
  } finally {
    store.close();
  }
});

test("the polling watermark cannot regress within an active epoch", () => {
  const store = new Store(":memory:");
  try {
    store.advance({ transportId: "bot", nextOffset: 101, now: 1000 });
    store.advance({ transportId: "bot", nextOffset: 51, now: 2000 });
    expect(store.offset("bot", 2000)).toBe(101);
    expect(store.processed({ transportId: "bot", updateId: 100 }, 2000)).toBe(true);
  } finally {
    store.close();
  }
});

test("an idle epoch reset admits lower and colliding new Telegram update IDs", () => {
  const store = new Store(":memory:");
  try {
    store.advance({ transportId: "bot", nextOffset: 5001, now: 1000 });
    const now = 1000 + IDLE_EPOCH_MS;
    expect(store.processed({ transportId: "bot", updateId: 100 }, now)).toBe(false);
    store.advance({ transportId: "bot", nextOffset: 101, now });
    expect(store.offset("bot", now)).toBe(101);
    expect(store.processed({ transportId: "bot", updateId: 100 }, now)).toBe(true);
  } finally {
    store.close();
  }
});
