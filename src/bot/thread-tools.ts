import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as v from "valibot";
import type { BridgeClient } from "../agent-bridge/client.ts";
import { type Operation, OperationBodies, OperationResults } from "../agent-bridge/protocol.ts";

export interface ThreadToolConnection extends Pick<BridgeClient, "request"> {
  check(): void;
}

export interface ThreadHistory {
  messages: { id: string; role: string; text: string }[];
  nextBefore?: string;
}
const textBlock = v.object({ type: v.literal("text"), text: v.string() });
function historyText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 4001);
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    const parsed = v.safeParse(textBlock, block);
    if (!parsed.success) continue;
    text += `${text ? "\n" : ""}${parsed.output.text.slice(0, 4001)}`;
    if (text.length > 4000) break;
  }
  return text;
}

/** Shared live-session projection: never expose thinking, tool arguments, or raw results. */
export function threadHistory(manager: Pick<SessionManager, "getBranch">, limit = 20, before?: string): ThreadHistory {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("History limit must be between 1 and 50");
  const entries = manager.getBranch();
  const end = before === undefined ? entries.length : entries.findIndex((entry) => entry.id === before);
  if (end < 0) throw new Error("Unknown history cursor");
  const messages: ThreadHistory["messages"] = [];
  let nextBefore: string | undefined;
  for (let index = end - 1; index >= 0; index--) {
    const entry = entries[index];
    let role: string;
    let text: string;
    if (entry.type === "custom_message") {
      role = "custom";
      text = historyText(entry.content);
    } else if (entry.type === "message") {
      const message = entry.message;
      role = message.role;
      if (role === "user" || role === "custom" || role === "assistant") {
        text = historyText("content" in message ? message.content : undefined);
        if (message.role === "assistant") {
          const tools = message.content
            .filter((block) => block.type === "toolCall")
            .slice(0, 16)
            .map((block) => block.name.slice(0, 80));
          if (tools.length) text += `\n[Tools: ${tools.join(", ")}]`;
        }
      } else if (message.role === "toolResult") {
        const sent =
          ["reply_message", "message_thread", "create_thread"].includes(message.toolName) && !message.isError
            ? v.safeParse(
                v.object({ communication: v.object({ destination: v.string(), text: v.string() }) }),
                message.details,
              )
            : undefined;
        if (sent?.success) {
          role = "sent";
          text = `[To ${sent.output.communication.destination}]\n${sent.output.communication.text}`;
        } else text = `[Tool ${message.toolName.slice(0, 80)}: ${message.isError ? "error" : "completed"}]`;
      } else continue;
    } else continue;
    if (!text.trim()) continue;
    if (text.length > 4000) text = `${text.slice(0, 3986)}\n[truncated]`;
    const projected = { id: entry.id, role, text };
    // Include JSON escaping, entry metadata, separators, wrapper and cursor.
    const bytes = Buffer.byteLength(JSON.stringify({ messages: [projected, ...messages], nextBefore: entry.id }));
    if (messages.length >= limit || bytes > 32000) {
      nextBefore = messages[0]?.id;
      break;
    }
    messages.unshift(projected);
  }
  return { messages, ...(nextBefore ? { nextBefore } : {}) };
}

export const THREAD_TOOL_NAMES = [
  "list_threads",
  "peek_thread",
  "create_thread",
  "message_thread",
  "stop_thread",
  "reply_message",
];

/** Only managed explicit-communication sessions register these tools. */
export function registerThreadTools(pi: ExtensionAPI, capture: () => ThreadToolConnection): void {
  const id = Type.String({ minLength: 1, maxLength: 128 });
  const text = Type.String({ minLength: 1, maxLength: 50000 });
  const page = {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    before: Type.Optional(id),
  };
  const execute = async (operation: Operation, params: unknown, signal?: AbortSignal) => {
    // Capture before any await; a late result must never follow a replacement attachment.
    const connection = capture();
    signal?.throwIfAborted();
    connection.check();
    const body = v.parse(OperationBodies[operation], params);
    const result = v.parse(OperationResults[operation], await connection.request(operation, body, signal));
    signal?.throwIfAborted();
    connection.check();
    const output = truncateHead(JSON.stringify(result, null, 2));
    // Save exactly what was explicitly sent in native tool history, not generic assistant output.
    let communication: { destination: string; text: string } | undefined;
    if (operation === "replyMessage") {
      const sent = v.parse(OperationBodies.replyMessage, body);
      communication = { destination: `message=${sent.messageId}`, text: sent.text };
    } else if (operation === "messageThread") {
      const sent = v.parse(OperationBodies.messageThread, body);
      communication = { destination: `thread=${sent.threadId}`, text: sent.text };
    } else if (operation === "createThread") {
      const sent = v.parse(OperationBodies.createThread, body);
      const created = v.parse(OperationResults.createThread, result);
      communication = { destination: `thread=${created.threadId}`, text: sent.text };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: output.content + (output.truncated ? "\n[Output truncated; request smaller pages.]" : ""),
        },
      ],
      details: communication ? { result, communication } : result,
    };
  };
  pi.registerTool({
    name: "list_threads",
    label: "List Threads",
    description:
      "List accessible threads and their status as an array. Default limit is 50 (1–100); pages are also byte-bounded and may contain fewer than limit. Use the final returned thread ID as before and continue until an empty array.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      before: Type.Optional(id),
    }),
    execute: (_id, params, signal) => execute("listThreads", params, signal),
  });
  pi.registerTool({
    name: "peek_thread",
    label: "Peek Thread",
    description:
      "Read a bounded tail of a thread's conversation without messaging it. Use nextBefore for older pages; thinking and raw tool output are omitted.",
    parameters: Type.Object({ threadId: id, ...page }),
    execute: (_id, params, signal) => execute("peekThread", params, signal),
  });
  pi.registerTool({
    name: "create_thread",
    label: "Create Thread",
    description:
      "Create a saved task thread in a working directory and send its initial instructions. Delegated results must be reported explicitly to the sender.",
    parameters: Type.Object({
      cwd: Type.String({ minLength: 1 }),
      title: Type.String({ minLength: 1, maxLength: 120 }),
      text,
    }),
    execute: (_id, params, signal, _update, ctx) =>
      execute("createThread", { ...params, cwd: resolveCwd(ctx.cwd, params.cwd) }, signal),
  });
  pi.registerTool({
    name: "message_thread",
    label: "Message Thread",
    description:
      "Enqueue text for another thread, reviving it if stopped. Returns acceptance, not the eventual answer. Ordinary assistant text stays private.",
    parameters: Type.Object({ threadId: id, text }),
    execute: (_id, params, signal) => execute("messageThread", params, signal),
  });
  pi.registerTool({
    name: "stop_thread",
    label: "Stop Thread",
    description:
      "Cancel and unload a task thread without deleting history. Later user replies or peer messages revive its saved session.",
    parameters: Type.Object({ threadId: id }),
    execute: (_id, params, signal) => execute("stopThread", params, signal),
  });
  pi.registerTool({
    name: "reply_message",
    label: "Reply Message",
    promptGuidelines: [
      "Use reply_message with the incoming envelope's user message ID to reply to users; ordinary assistant text stays private.",
      "Use message_thread for explicit communication with peer threads.",
      "Report delegated results explicitly to the requester using message_thread for a peer request or reply_message for a user request.",
    ],
    description:
      "Publish a reply to the platform message ID in an incoming envelope (not a peek entry ID). Optional mentions are user IDs from envelopes.",
    parameters: Type.Object({ messageId: id, text, mentions: Type.Optional(Type.Array(id)) }),
    execute: (_id, params, signal) => execute("replyMessage", params, signal),
  });
}

function resolveCwd(cwd: string, input: string): string {
  return resolve(cwd, input === "~" ? homedir() : input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : input);
}
