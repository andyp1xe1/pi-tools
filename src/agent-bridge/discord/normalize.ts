import * as v from "valibot";
import { type Container, type IncomingMessage, IncomingMessageSchema } from "../domain.ts";
import { type DiscordChannel, DiscordChannelSchema, DiscordMessageSchema, SnowflakeSchema } from "./schemas.ts";

export interface NormalizedDiscord {
  message: IncomingMessage;
  /** Parsed only syntactically here; the shared command service supplies semantics. */
  command: { name: string; argument: string } | null;
  name: string;
  wire: { channelId: string; messageId: string };
}
export class DiscordTargetError extends Error {}

export function discordContainer(channel: DiscordChannel): Container {
  if (channel.type === 1 && !channel.guild_id)
    return { platform: "discord", spaceId: `dm:${channel.id}`, channelId: channel.id };
  if ((channel.type === 0 || channel.type === 5) && channel.guild_id)
    return { platform: "discord", spaceId: channel.guild_id, channelId: channel.id };
  if ([10, 11, 12].includes(channel.type) && channel.guild_id && channel.parent_id)
    return { platform: "discord", spaceId: channel.guild_id, channelId: channel.parent_id };
  throw new DiscordTargetError("Unsupported Discord project space.");
}

/** Channel metadata must come from Discord, never message text or an agent-supplied path. */
export function normalizeDiscord(
  input: unknown,
  context: { channel: DiscordChannel; botId: string; nativeThreadRootId?: string },
): NormalizedDiscord | null {
  const raw = v.parse(DiscordMessageSchema, input);
  const channel = v.parse(DiscordChannelSchema, context.channel);
  const botId = v.parse(SnowflakeSchema, context.botId);
  if (raw.author.bot || raw.author.id === botId || raw.webhook_id || ![0, 19].includes(raw.type)) return null;
  if (raw.channel_id !== channel.id || raw.guild_id !== channel.guild_id)
    throw new DiscordTargetError("Discord channel metadata does not match this message.");
  const container = discordContainer(channel);
  const native = [10, 11, 12].includes(channel.type);
  if (native && !context.nativeThreadRootId)
    throw new DiscordTargetError("Unknown Discord native thread; no shared thread mapping exists.");
  // Message references on forwards and crossposts are not replies. Unknown explicit references
  // are never silently reinterpreted as input to Main, including cross-channel references.
  const reference = raw.type === 19 ? raw.message_reference : undefined;
  if (raw.type === 19 && (!reference?.message_id || !reference.channel_id))
    throw new DiscordTargetError("Discord reply has no usable target.");
  if (
    reference &&
    (reference.type === 1 ||
      reference.channel_id !== channel.id ||
      (reference.guild_id !== undefined && reference.guild_id !== raw.guild_id))
  )
    throw new DiscordTargetError("Discord reply target is outside this project space.");
  const text = raw.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
  if (!text) return null;
  const match = /^\/([a-z][a-z0-9_]*)(?:\s+([\s\S]*))?$/i.exec(text);
  return {
    message: v.parse(IncomingMessageSchema, {
      id: raw.id,
      container,
      authorId: raw.author.id,
      text,
      route: reference?.message_id
        ? { kind: "reply", parentId: reference.message_id }
        : native
          ? { kind: "thread", threadId: v.parse(SnowflakeSchema, context.nativeThreadRootId) }
          : { kind: "default" },
    }),
    command: match?.[1] ? { name: match[1].toLowerCase(), argument: match[2]?.trim() ?? "" } : null,
    name: raw.author.global_name ?? raw.author.username,
    wire: { channelId: raw.channel_id, messageId: raw.id },
  };
}

/** Explicit local-host authority, not Discord guild administrator permissions. */
export class DiscordPermissions {
  private readonly owners: Set<string>;
  constructor(ownerIds: readonly string[]) {
    this.owners = new Set(ownerIds.map((id) => v.parse(SnowflakeSchema, id)));
  }
  canBind(userId: string): boolean {
    return this.owners.has(userId);
  }
  canControl(userId: string, threadOwnerId: string): boolean {
    return this.owners.has(userId) && userId === threadOwnerId;
  }
}
