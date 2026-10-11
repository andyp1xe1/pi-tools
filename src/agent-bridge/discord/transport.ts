import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as v from "valibot";
import type { ThreadTransport } from "../../bot/runtime.ts";
import type { Task } from "../domain.ts";
import type { DiscordAPI, DiscordCreateMessage } from "./api.ts";
import { SnowflakeSchema } from "./schemas.ts";

export interface DiscordReplyTarget {
  channelId: string;
  messageId?: string;
}
export interface DiscordTransportScope {
  /** Resolve only persisted, authorized targets. Never infer a channel from a message ID. */
  resolve(task: Task, targetMessageId?: string): DiscordReplyTarget;
  current(task: Task): boolean;
  /** Invoked per acknowledged chunk, including chunks preceding a later send failure. */
  sent(task: Task, channelId: string, messageId: string): void;
  /** Shared core decides which remembered users belong to this project space. */
  knownUser(task: Task, userId: string): boolean;
}
export function chunkDiscordText(text: string): string[] {
  if (!text.trim()) throw new Error("Discord message text is required.");
  const chunks: string[] = [];
  while (text.length) {
    let end = Math.min(2000, text.length);
    // Never separate a UTF-16 surrogate pair. Conservatively count code units.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  return chunks;
}
export function discordMessageBody(
  text?: string,
  target?: DiscordReplyTarget,
  mentions: string[] = [],
): DiscordCreateMessage {
  return {
    ...(text === undefined ? {} : { content: text }),
    nonce: randomBytes(12).toString("hex"),
    enforce_nonce: true,
    allowed_mentions: { parse: [], users: mentions, replied_user: false },
    ...(target?.messageId
      ? {
          message_reference: {
            type: 0,
            channel_id: target.channelId,
            message_id: target.messageId,
            fail_if_not_exists: true,
          },
        }
      : {}),
  };
}
/** Wire publishing only. Thread lifecycle, authorizations and message mappings belong to the core. */
export class DiscordTransport implements ThreadTransport {
  constructor(
    readonly api: DiscordAPI,
    private readonly scope: DiscordTransportScope,
    readonly maxUploadBytes = 10 * 1024 * 1024,
  ) {}
  private target(task: Task, targetMessageId?: string): DiscordReplyTarget {
    if (task.container.platform !== "discord") throw new Error("Not a Discord thread.");
    if (!this.scope.current(task)) throw new Error("Discord thread is no longer current.");
    const target = this.scope.resolve(task, targetMessageId);
    v.parse(SnowflakeSchema, target.channelId);
    if (target.messageId !== undefined) v.parse(SnowflakeSchema, target.messageId);
    if (targetMessageId !== undefined && target.messageId !== targetMessageId)
      throw new Error("Discord reply resolver changed the explicit message target.");
    return { ...target };
  }
  async publishAnchor(task: Task, signal: AbortSignal): Promise<string> {
    const target = this.target(task);
    signal.throwIfAborted();
    const result = await this.api.createMessage(
      target.channelId,
      discordMessageBody(task.title.slice(0, 120) || "Untitled thread", target),
      signal,
    );
    this.scope.sent(task, target.channelId, result.id);
    return result.id;
  }
  async reply(
    task: Task,
    targetMessageId: string,
    text: string,
    mentions: string[],
    signal: AbortSignal,
    sent?: (id: string) => void,
  ): Promise<string[]> {
    const target = this.target(task, v.parse(SnowflakeSchema, targetMessageId));
    const users = [...new Set(mentions.map((id) => v.parse(SnowflakeSchema, id)))];
    if (users.length > 100 || users.some((id) => !this.scope.knownUser(task, id)))
      throw new Error("Discord mentions must name known users in this project space.");
    // allowed_mentions cannot cause invisible pings; put explicit tool mentions in content.
    const chunks = chunkDiscordText(`${users.length ? `${users.map((id) => `<@${id}>`).join(" ")}\n` : ""}${text}`);
    const ids: string[] = [];
    for (const [index, content] of chunks.entries()) {
      signal.throwIfAborted();
      this.target(task, targetMessageId); // Recheck binding/writer fencing before each send.
      const result = await this.api.createMessage(
        target.channelId,
        discordMessageBody(content, target, index === 0 ? users : []),
        signal,
      );
      if (sent) sent(result.id);
      else this.scope.sent(task, target.channelId, result.id);
      ids.push(result.id);
    }
    return ids;
  }
  async sendAttachment(task: Task, body: { path: string; fileName: string }, signal: AbortSignal): Promise<void> {
    const target = this.target(task);
    if (!target.messageId) throw new Error("Discord thread has no acknowledged reply anchor yet.");
    if (!isAbsolute(body.path)) throw new Error("An absolute local file path is required.");
    if (!body.fileName.trim() || /[\r\n\0/\\]/.test(body.fileName))
      throw new Error("Invalid Discord attachment filename.");
    signal.throwIfAborted();
    const metadata = await stat(body.path);
    if (!metadata.isFile() || metadata.size > this.maxUploadBytes)
      throw new Error("Discord attachment exceeds the configured upload limit or is not a file.");
    const data = await readFile(body.path, { signal });
    if (data.byteLength > this.maxUploadBytes)
      throw new Error("Discord attachment exceeds the configured upload limit.");
    signal.throwIfAborted();
    this.target(task);
    const payload = discordMessageBody(undefined, target);
    payload.attachments = [{ id: 0, filename: body.fileName }];
    const result = await this.api.createMessage(target.channelId, payload, signal, {
      data: new Blob([new Uint8Array(data)]),
      name: body.fileName,
    });
    this.scope.sent(task, target.channelId, result.id);
  }
}
