import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import * as v from "valibot";
import type { PreparedPrompt } from "../agent-bridge/protocol.ts";

export const BOT_MESSAGE_TYPE = "agent-bridge";
const TurnDetailsSchema = v.object({ turnId: v.pipe(v.string(), v.nonEmpty(), v.maxLength(128)) });

export function getBotTurnId(message: AgentMessage): string | undefined {
  if (message.role !== "custom" || message.customType !== BOT_MESSAGE_TYPE) return;
  const details: unknown = message.details;
  const parsed = v.safeParse(TurnDetailsSchema, details);
  return parsed.success ? parsed.output.turnId : undefined;
}

export interface PendingBotTurn {
  id: string;
  content: (TextContent | ImageContent)[];
}

export function getMessageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export async function preparePrompt(prompt: PreparedPrompt, signal?: AbortSignal): Promise<PendingBotTurn> {
  signal?.throwIfAborted();
  const content: PendingBotTurn["content"] = [];
  for (const block of prompt.content) {
    if (block.type === "text") content.push(block);
    else
      content.push({
        type: "image",
        data: (await readFile(block.path, { signal })).toString("base64"),
        mimeType: block.mimeType,
      });
  }
  signal?.throwIfAborted();
  return { id: prompt.id, content };
}
