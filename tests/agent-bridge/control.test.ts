import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/agent-bridge/config.ts";
import { Control, parseCommand, projectDirectory } from "../../src/agent-bridge/control.ts";
import { Store } from "../../src/agent-bridge/store.ts";
import { topic } from "./fixtures.ts";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true });
});
function setup() {
	const store = new Store(":memory:");
	stores.push(store);
	const directory = mkdtempSync(join(tmpdir(), "agent-bridge-project-"));
	directories.push(directory);
	return { store, control: new Control(store), directory };
}

test("an owner can register an existing directory and bind only this topic", () => {
	const { store, control, directory } = setup();
	expect(
		control.execute({
			container: topic,
			owner: true,
			command: { kind: "bind", directory },
		}),
	).toContain("Bound");
	expect(store.snapshot().projects).toHaveLength(1);
	expect(store.binding(topic)).not.toBeNull();
	expect(store.binding({ ...topic, channelId: "99" })).toBeNull();
});

test("members cannot change bindings or inspect arbitrary local directories", () => {
	const { store, control } = setup();
	expect(
		control.execute({
			container: topic,
			owner: false,
			command: { kind: "bind", directory: "/secret" },
		}),
	).toContain("Only configured bot owners");
	expect(store.snapshot().projects).toHaveLength(0);
	expect(
		control.execute({
			container: topic,
			owner: false,
			command: { kind: "unbind" },
		}),
	).toContain("Only");
});

test("the same canonical directory is one project across topics", () => {
	const { store, control, directory } = setup();
	control.execute({
		container: topic,
		owner: true,
		command: { kind: "bind", directory },
	});
	control.execute({
		container: { ...topic, channelId: "99" },
		owner: true,
		command: { kind: "bind", directory: `${directory}/.` },
	});
	expect(store.snapshot().projects).toHaveLength(1);
	expect(store.binding(topic)).toBe(
		store.binding({ ...topic, channelId: "99" }),
	);
});

test("rebind requires unbind and does not leave unused project records", () => {
	const { store, control, directory } = setup();
	control.execute({
		container: topic,
		owner: true,
		command: { kind: "bind", directory },
	});
	const other = mkdtempSync(join(tmpdir(), "agent-bridge-other-"));
	directories.push(other);
	expect(
		control.execute({
			container: topic,
			owner: true,
			command: { kind: "bind", directory: other },
		}),
	).toContain("/unbind first");
	expect(store.snapshot().projects).toHaveLength(1);
	control.execute({
		container: topic,
		owner: true,
		command: { kind: "unbind" },
	});
	expect(store.binding(topic)).toBeNull();
	control.execute({
		container: topic,
		owner: true,
		command: { kind: "bind", directory: other },
	});
	expect(store.snapshot().projects).toHaveLength(2);
});

test("directory checks do not run shell syntax or accept relative paths", () => {
	const { directory } = setup();
	expect(projectDirectory(`"${directory}"`)).toBe(directory);
	expect(() => projectDirectory("relative")).toThrow("absolute");
	expect(() => projectDirectory("$(touch /tmp/should-not-exist)")).toThrow(
		"absolute",
	);
	expect(() => projectDirectory("/missing-agent-bridge-directory")).toThrow(
		"not exist",
	);
});

test("project controls parse explicit conversation creation and attachment release", () => {
	expect(parseCommand("bind", "~/dev/project")).toEqual({
		kind: "bind",
		directory: "~/dev/project",
	});
	expect(parseCommand("release", "")).toEqual({ kind: "release" });
	expect(parseCommand("new", "fresh request")).toEqual({ kind: "new", request: "fresh request" });
	for (const name of ["grant", "revoke", "projects", "run"])
		expect(parseCommand(name, "")).toBeNull();
});

test("environment config has no project catalog and supports safe discovery mode", () => {
	expect(loadConfig({ XDG_DATA_HOME: "/tmp/data" })).toEqual({
		database: "/tmp/data/agent-bridge/bridge.sqlite",
		ownerTelegramUserIds: [],
	});
	expect(
		loadConfig({ AGENT_BRIDGE_OWNER_IDS: "7, 8,7" }).ownerTelegramUserIds,
	).toEqual(["7", "8"]);
	for (const id of ["-7", "0", "9007199254740992", "not-an-owner"]) {
		expect(() => loadConfig({ AGENT_BRIDGE_OWNER_IDS: id })).toThrow("positive");
	}
});
