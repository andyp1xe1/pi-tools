import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as v from "valibot";

const identifier = v.pipe(v.string(), v.nonEmpty(), v.maxLength(128));
const text = v.pipe(v.string(), v.nonEmpty());
export const LocalPathSchema = v.pipe(text, v.check(isAbsolute, "An absolute local file path is required."));
// Owner identity is opaque to IPC; transports validate its meaning.
const userId = identifier;
const integer = v.pipe(v.number(), v.integer(), v.minValue(0));
export const ThinkingLevelSchema = v.picklist(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = v.InferOutput<typeof ThinkingLevelSchema>;
const ModelSchema = v.object({ provider: text, id: text, name: v.string() });
export const AgentSnapshotSchema = v.object({
  idle: v.boolean(),
  model: v.optional(ModelSchema),
  models: v.array(ModelSchema),
  thinking: ThinkingLevelSchema,
  supportedThinking: v.array(ThinkingLevelSchema),
  status: v.string(),
});
export type AgentSnapshot = v.InferOutput<typeof AgentSnapshotSchema>;
export const PreparedPromptSchema = v.object({
  id: identifier,
  content: v.array(
    v.variant("type", [
      v.object({ type: v.literal("text"), text: v.string() }),
      v.object({ type: v.literal("image-file"), path: LocalPathSchema, mimeType: text }),
    ]),
  ),
});
export type PreparedPrompt = v.InferOutput<typeof PreparedPromptSchema>;
export const AgentOutputSchema = v.variant("type", [
  v.object({ type: v.literal("turn-start"), turnId: identifier }),
  v.object({ type: v.literal("text-start") }),
  v.object({ type: v.literal("text-update"), text: v.string() }),
  v.object({ type: v.literal("text-end"), text: v.string(), error: v.optional(v.string()) }),
  v.object({ type: v.literal("settled"), error: v.optional(v.string()) }),
  v.object({ type: v.literal("delivery-error"), turnId: identifier, error: v.string() }),
]);
export type AgentOutput = v.InferOutput<typeof AgentOutputSchema>;
export const OperationBodies = {
  sendAttachment: v.strictObject({ path: LocalPathSchema, fileName: text }),
  transcribeAudio: v.strictObject({ path: LocalPathSchema, model: v.optional(text), language: v.optional(text) }),
};
export const OperationResults = {
  sendAttachment: v.boolean(),
  transcribeAudio: v.union([v.string(), v.object({ transcriptPath: LocalPathSchema })]),
};
export const OperationSchema = v.picklist(["sendAttachment", "transcribeAudio"]);
export type Operation = v.InferOutput<typeof OperationSchema>;
export const AgentOperationBodies = {
  snapshot: v.object({}),
  setModel: v.object({ provider: text, id: text }),
  setThinking: v.object({ level: ThinkingLevelSchema }),
  abort: v.object({}),
  compact: v.object({}),
  newSession: v.object({}),
};
export const AgentOperationResults = {
  snapshot: AgentSnapshotSchema,
  setModel: v.boolean(),
  setThinking: ThinkingLevelSchema,
  abort: v.boolean(),
  compact: v.boolean(),
  newSession: v.boolean(),
};
export const AgentOperationSchema = v.picklist([
  "snapshot",
  "setModel",
  "setThinking",
  "abort",
  "compact",
  "newSession",
]);
export type AgentOperation = v.InferOutput<typeof AgentOperationSchema>;
const AgentRequestSchema = v.object({
  type: v.literal("agent-request"),
  id: identifier,
  operation: AgentOperationSchema,
  body: v.record(v.string(), v.unknown()),
});
export type AgentRequest = v.InferOutput<typeof AgentRequestSchema>;
export const ClientFrameSchema = v.variant("type", [
  v.object({
    type: v.literal("attach"),
    sessionId: identifier,
    userId: v.optional(userId),
    routeId: v.optional(identifier),
    cwd: v.optional(LocalPathSchema),
    attachmentToken: v.optional(identifier),
    sessionFile: v.optional(LocalPathSchema),
  }),
  v.object({ type: v.literal("status") }),
  v.object({ type: v.literal("stop") }),
  v.object({ type: v.literal("detach") }),
  v.object({ type: v.literal("cancel"), id: identifier }),
  v.object({ type: v.literal("output"), event: AgentOutputSchema }),
  v.object({ type: v.literal("agent-result"), id: identifier, result: v.unknown() }),
  v.object({ type: v.literal("agent-error"), id: identifier, message: v.string() }),
  v.object({
    type: v.literal("request"),
    id: identifier,
    operation: OperationSchema,
    body: v.record(v.string(), v.unknown()),
  }),
]);
export type ClientFrame = v.InferOutput<typeof ClientFrameSchema>;
export const StatisticsSchema = v.object({
  topics: integer,
  tasks: integer,
  pendingReplies: integer,
  failedReplies: integer,
});
export type Statistics = v.InferOutput<typeof StatisticsSchema>;
const FrontendIdentitySchema = v.object({ id: identifier, label: text });
export const ServerFrameSchema = v.variant("type", [
  v.object({ type: v.literal("attached"), userId, routeId: v.optional(identifier), frontend: FrontendIdentitySchema }),
  v.object({ type: v.literal("prompt"), prompt: PreparedPromptSchema }),
  AgentRequestSchema,
  v.object({ type: v.literal("result"), id: identifier, result: v.unknown() }),
  v.object({
    type: v.literal("error"),
    id: v.optional(identifier),
    message: v.string(),
    unknownOutcome: v.optional(v.boolean()),
  }),
  v.object({
    type: v.literal("status"),
    frontend: FrontendIdentitySchema,
    sessions: v.array(v.object({ userId, sessionId: identifier, routeId: v.optional(identifier) })),
    statistics: StatisticsSchema,
    mode: v.picklist(["setup", "routing"]),
    uptimeSeconds: integer,
  }),
  v.object({ type: v.literal("stopping") }),
  v.object({ type: v.literal("detached") }),
]);
export type ServerFrame = v.InferOutput<typeof ServerFrameSchema>;
export const MAX_FRAME_BYTES = 1024 * 1024;
export function bridgeSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.AGENT_BRIDGE_SOCKET ??
    join(
      env.XDG_RUNTIME_DIR ?? join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-bridge"),
      "agent-bridge.sock",
    )
  );
}
