import * as v from "valibot";
import {
	type Container,
	type IncomingMessage,
	IncomingMessageSchema,
	ProjectSchema,
	type RouteResult,
} from "../../src/agent-bridge/domain.ts";
import type { Store } from "../../src/agent-bridge/store.ts";

export const topic: Container = {
	platform: "telegram",
	spaceId: "-1001",
	channelId: "42",
};
export const one = v.parse(ProjectSchema, {
	id: "one",
	name: "One",
	directory: "/workspace/one",
});
export const two = v.parse(ProjectSchema, {
	id: "two",
	name: "Two",
	directory: "/workspace/two",
});
export function seed(store: Store): void {
	store.saveProject(one);
	store.saveProject(two);
	store.bind({ container: topic, projectId: one.id });
}
export function input(
	id: string,
	route: { start?: boolean; parent?: string; thread?: string } = {},
	container = topic,
): IncomingMessage {
	return v.parse(IncomingMessageSchema, {
		id,
		container,
		authorId: "7",
		text: "Fix the bug",
		route: route.start
			? { kind: "start", rootId: route.thread ?? id, parentId: route.parent }
			: route.thread
				? { kind: "thread", threadId: route.thread }
				: route.parent
					? { kind: "reply", parentId: route.parent }
					: { kind: "ignore" },
	});
}
export function routed(result: RouteResult) {
	if (result.kind !== "routed")
		throw new Error(`Expected routed, got ${result.kind}`);
	return result;
}
