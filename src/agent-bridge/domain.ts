import * as v from "valibot";

export const ProjectIdSchema = v.pipe(v.string(), v.nonEmpty(), v.brand("ProjectId"));
export const TaskIdSchema = v.pipe(v.string(), v.nonEmpty(), v.brand("TaskId"));
export const MessageIdSchema = v.pipe(v.string(), v.nonEmpty(), v.brand("MessageId"));
export const UserIdSchema = v.pipe(v.string(), v.nonEmpty(), v.brand("UserId"));
export type ProjectId = v.InferOutput<typeof ProjectIdSchema>;
export type TaskId = v.InferOutput<typeof TaskIdSchema>;
export type MessageId = v.InferOutput<typeof MessageIdSchema>;
export type UserId = v.InferOutput<typeof UserIdSchema>;

/** Telegram: chat and forum topic. Discord: guild and parent channel. */
export const ContainerSchema = v.object({
  platform: v.picklist(["telegram", "discord"]),
  spaceId: v.pipe(v.string(), v.nonEmpty()),
  channelId: v.pipe(v.string(), v.nonEmpty()),
});
export type Container = v.InferOutput<typeof ContainerSchema>;

export const ProjectSchema = v.object({
  id: ProjectIdSchema,
  name: v.pipe(v.string(), v.nonEmpty()),
  directory: v.pipe(v.string(), v.nonEmpty()),
});
export type Project = v.InferOutput<typeof ProjectSchema>;
export type Binding = Container & { projectId: ProjectId };

export const MessageRouteSchema = v.variant("kind", [
  v.object({ kind: v.literal("start"), rootId: MessageIdSchema, parentId: v.optional(MessageIdSchema) }),
  v.object({ kind: v.literal("reply"), parentId: MessageIdSchema }),
  v.object({ kind: v.literal("thread"), threadId: MessageIdSchema }),
  v.object({ kind: v.literal("ignore") }),
]);
export const IncomingMessageSchema = v.object({
  id: MessageIdSchema,
  container: ContainerSchema,
  authorId: UserIdSchema,
  text: v.string(),
  route: MessageRouteSchema,
});
export type IncomingMessage = v.InferOutput<typeof IncomingMessageSchema>;

export const TaskSchema = v.object({
  id: TaskIdSchema,
  projectId: ProjectIdSchema,
  container: ContainerSchema,
  rootId: MessageIdSchema,
  title: v.string(),
  createdAt: v.string(),
});
export type Task = v.InferOutput<typeof TaskSchema>;
export const TaskInputSchema = v.object({
  sequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
  taskId: TaskIdSchema,
  messageId: MessageIdSchema,
  authorId: UserIdSchema,
  text: v.string(),
  createdAt: v.string(),
});
export type TaskInput = v.InferOutput<typeof TaskInputSchema>;

export type RouteResult =
  | { kind: "ignored"; reason: "unbound" | "chatter" | "project-changed" }
  | { kind: "duplicate"; task: Task }
  | { kind: "routed"; task: Task; input: TaskInput; created: boolean };

export function containerKey(container: Container): string {
  return JSON.stringify([container.platform, container.spaceId, container.channelId]);
}
export function parseContainerKey(key: string): Container {
  const value: unknown = JSON.parse(key);
  const [platform, spaceId, channelId] = v.parse(
    v.tuple([ContainerSchema.entries.platform, ContainerSchema.entries.spaceId, ContainerSchema.entries.channelId]),
    value,
  );
  return { platform, spaceId, channelId };
}
