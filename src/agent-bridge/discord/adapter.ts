import * as v from "valibot";
import type { Container, IncomingMessage } from "../domain.ts";
import { DiscordPermissions, type NormalizedDiscord, normalizeDiscord } from "./normalize.ts";
import { type DiscordChannel, DiscordMessageSchema, SnowflakeSchema } from "./schemas.ts";

/** The shared service, not Discord, owns thread admission, commands, sessions and ownership. */
export interface DiscordCorePort {
  accept(input: NormalizedDiscord, permissions: DiscordPermissions, signal: AbortSignal): Promise<void>;
  /** Check explicit reply/root mappings in the currently bound project; unknown means reject. */
  knownTarget(container: Container, route: IncomingMessage["route"]): boolean;
  /** Resolve an existing native thread alias, never manufacture a thread or bind its parent. */
  nativeThreadRoot(channel: DiscordChannel): string | undefined;
}

/** Gateway MESSAGE_CREATE adapter. Edits, webhooks and bot output are not replayed as input. */
export class DiscordAdapter {
  private readonly botId: string;
  readonly permissions: DiscordPermissions;
  constructor(
    botId: string,
    ownerIds: readonly string[],
    private readonly core: DiscordCorePort,
    private readonly channel: (id: string, signal: AbortSignal) => Promise<DiscordChannel>,
  ) {
    this.botId = v.parse(SnowflakeSchema, botId);
    this.permissions = new DiscordPermissions(ownerIds);
  }
  async dispatch(name: string, data: unknown, signal: AbortSignal): Promise<"ignored" | "accepted" | "unknown-target"> {
    signal.throwIfAborted();
    if (name !== "MESSAGE_CREATE") return "ignored";
    const raw = v.parse(DiscordMessageSchema, data);
    if (raw.author.bot || raw.author.id === this.botId || raw.webhook_id || ![0, 19].includes(raw.type))
      return "ignored";
    const channel = await this.channel(raw.channel_id, signal);
    signal.throwIfAborted();
    const normalized = normalizeDiscord(raw, {
      channel,
      botId: this.botId,
      nativeThreadRootId: this.core.nativeThreadRoot(channel),
    });
    if (!normalized) return "ignored";
    const route = normalized.message.route;
    if (
      (route.kind === "reply" || route.kind === "thread") &&
      !this.core.knownTarget(normalized.message.container, route)
    )
      return "unknown-target";
    await this.core.accept(normalized, this.permissions, signal);
    return "accepted";
  }
}
