import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../../src/agent-bridge/router.ts";
import { Store } from "../../src/agent-bridge/store.ts";
import { projectSpaceKey } from "../../src/bot/commands.ts";
import { BotRuntime, type ThreadSession, type ThreadTransport } from "../../src/bot/runtime.ts";
import { input, routed, unavailableBackend } from "./fixtures.ts";

const dm = { platform: "telegram" as const, spaceId: "7", channelId: "general" };
function fixture(publish: ThreadTransport["publishAnchor"] = async () => "999") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bridge-registration-")));
  const path = join(root, "bridge.sqlite");
  const store = new Store(path);
  const project = store.registerProject(root);
  store.bind({ container: dm, projectId: project.id });
  const options = { store, backend: unavailableBackend, ownerIds: ["7"], platform: "telegram" as const,
    identity: { id: "telegram", label: "Telegram" },
    session: (_frontend: unknown): _frontend is ThreadSession => false,
    transport: { publishAnchor: publish, reply: async () => [] },
  };
  return { root, path, store, project, runtime: new BotRuntime(options), options,
    request: { type: "attach" as const, sessionId: "terminal", sessionFile: join(root, "terminal.jsonl"), cwd: root },
    cleanup() { store.close(); rmSync(root, { recursive: true }); },
  };
}

test("automatic terminal registration creates a scoped sibling, never replaces Main, and restores exact identity", () => {
  const h = fixture();
  try {
    const main = routed(new Router(h.store).route({ ...input("1", {}, dm), route: { kind: "default" } })).task;
    const identity = h.runtime.authorize(h.request);
    const terminal = h.store.task(identity.routeId as typeof main.id);
    expect(terminal?.container).toEqual(dm);
    expect(terminal?.rootId.startsWith("terminal_")).toBe(true);
    expect(h.store.defaultTask(dm)?.id).toBe(main.id);
    expect(identity.routeId).not.toBe(main.id);
    h.runtime.bind(h.request, identity);
    expect(h.store.visibleWriter(terminal!.id)).toBe("terminal");
    h.runtime.disconnected(identity, false);
    expect(h.store.visibleWriter(terminal!.id)).toBe("terminal");
    h.runtime.disconnected(identity, true);
    expect(h.store.visibleWriter(terminal!.id)).toBeUndefined();
    expect(h.runtime.authorize(h.request)).toEqual(identity);
    expect(() => h.runtime.authorize({ ...h.request, sessionId: "changed-header" })).toThrow("different saved session");
    expect(h.store.snapshot().tasks).toHaveLength(2);
  } finally { h.cleanup(); }
});

test("ambiguous cwd requires an explicit space and saved identities cannot silently move spaces", () => {
  const h = fixture();
  try {
    const topic = { platform: "telegram" as const, spaceId: "-100", channelId: "42" };
    h.store.bind({ container: topic, projectId: h.project.id });
    expect(() => h.runtime.authorize(h.request)).toThrow("Several project spaces");
    expect(h.store.snapshot().tasks).toHaveLength(0);
    const alias = join(h.root, "cwd-alias"); symlinkSync(h.root, alias);
    const identity = h.runtime.authorize({ ...h.request, cwd: alias, space: projectSpaceKey(topic) });
    expect(h.store.task(identity.routeId as Parameters<Store["task"]>[0])?.container).toEqual(topic);
    expect(() => h.runtime.authorize({ ...h.request, space: projectSpaceKey(dm) })).toThrow("another project space");
    expect(h.store.snapshot().tasks).toHaveLength(1);
    expect(h.runtime.authorize({ ...h.request, space: projectSpaceKey(topic) })).toEqual(identity);
  } finally { h.cleanup(); }
});

test("terminal anchor claims prevent reconnect/reopen retries after an uncertain send", async () => {
  let sends = 0;
  const uncertain = Object.assign(new Error("outcome unknown"), { unknownOutcome: true });
  const h = fixture(async () => { sends++; throw uncertain; });
  let reopened: Store | undefined;
  try {
    const identity = h.runtime.authorize(h.request);
    await expect(h.runtime.publishTerminalAnchor(identity, new AbortController().signal)).rejects.toBe(uncertain);
    await h.runtime.publishTerminalAnchor(identity, new AbortController().signal);
    expect(sends).toBe(1);
    h.store.close();
    reopened = new Store(h.path);
    const runtime = new BotRuntime({ ...h.options, store: reopened });
    await runtime.publishTerminalAnchor(identity, new AbortController().signal);
    expect(sends).toBe(1);
    expect(reopened.task(identity.routeId as Parameters<Store["task"]>[0])?.rootId.startsWith("terminal_")).toBe(true);
  } finally { reopened?.close(); h.cleanup(); }
});
